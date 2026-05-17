const { tenantQuery, getConnection, getTenantContext } = require('../../config/db');
const { generateKodeTransferStok } = require('../../lib/kodetrans');
const logger = require('../../lib/logger');

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeDate(value) {
  return value && /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? String(value).slice(0, 10) : todayLocal();
}

function mapStatus(status) {
  if (['DIKIRIM', 'DITERIMA', 'KIRIM', 'TERIMA'].includes(status)) return 'APPROVED';
  if (['DIBATALKAN', 'BATAL'].includes(status)) return 'CANCELLED';
  return status || 'DRAFT';
}

async function getTransferForUpdate(conn, ctx, id) {
  const [[row]] = await conn.query(
    'SELECT * FROM transferstok WHERE idtransferstok = ? AND idtenant = ? FOR UPDATE',
    [id, ctx.idtenant]
  );
  return row;
}

async function deleteTransferKartuStok(conn, ctx, idtransferstok) {
  await conn.query(
    "DELETE FROM kartustok WHERE idtenant = ? AND idtrans = ? AND jenistransaksi IN ('TRANSFERSTOK_KELUAR', 'TRANSFERSTOK_MASUK', 'TRANSFERSTOK_BATAL')",
    [ctx.idtenant, idtransferstok]
  );
}

async function insertTransferKartuStok(conn, ctx, transfer, items) {
  await deleteTransferKartuStok(conn, ctx, transfer.idtransferstok);
  const tgl = normalizeDate(transfer.tgltrans);
  for (const item of items) {
    const qty = parseFloat(item.jml || 0);
    if (qty <= 0) continue;
    await conn.query(
      `INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idtrans, jenistransaksi)
       VALUES (?, ?, ?, ?, ?, 'K', ?, ?, ?, 'TRANSFERSTOK_KELUAR')`,
      [ctx.idtenant, transfer.idlokasi, transfer.kodetransferstok, item.idbarang, qty, tgl, `Transfer Keluar ${transfer.kodetransferstok}`, transfer.idtransferstok]
    );
    await conn.query(
      `INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idtrans, jenistransaksi)
       VALUES (?, ?, ?, ?, ?, 'M', ?, ?, ?, 'TRANSFERSTOK_MASUK')`,
      [ctx.idtenant, transfer.idlokasitujuan, transfer.kodetransferstok, item.idbarang, qty, tgl, `Transfer Masuk ${transfer.kodetransferstok}`, transfer.idtransferstok]
    );
  }
}

// GET /transfer-stok — Daftar transfer stok dengan filter
exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, status } = req.query;
    let sql = `SELECT ts.*, l1.kodelokasi AS kodelokasi, l1.namalokasi AS namalokasi, l2.kodelokasi AS kodelokasitujuan, l2.namalokasi AS namalokasitujuan
      FROM transferstok ts
      LEFT JOIN lokasi l1 ON ts.idlokasi = l1.idlokasi AND l1.idtenant = ts.idtenant
      LEFT JOIN lokasi l2 ON ts.idlokasitujuan = l2.idlokasi AND l2.idtenant = ts.idtenant
      WHERE ts.idtenant = ?`;
    const params = [ctx.idtenant];
    if (tglwal) { sql += ' AND ts.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND ts.tgltrans <= ?'; params.push(tglakhir); }
    if (status) {
      const vals = status === 'APPROVED' ? ['APPROVED', 'DIKIRIM', 'DITERIMA', 'KIRIM', 'TERIMA'] : [status];
      sql += ` AND ts.status IN (${vals.map(() => '?').join(',')})`;
      params.push(...vals);
    }
    sql += ' ORDER BY ts.tgltrans DESC, ts.idtransferstok DESC LIMIT 200';
    const rows = await tenantQuery(sql, params);
    res.json(rows.map(row => ({ ...row, status: mapStatus(row.status) })));
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /transfer-stok/:id — Detail transfer stok + items
exports.getOne = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await tenantQuery(
      `SELECT ts.*, l1.kodelokasi AS kodelokasi, l1.namalokasi AS namalokasi, l2.kodelokasi AS kodelokasitujuan, l2.namalokasi AS namalokasitujuan
       FROM transferstok ts
       LEFT JOIN lokasi l1 ON ts.idlokasi = l1.idlokasi AND l1.idtenant = ts.idtenant
       LEFT JOIN lokasi l2 ON ts.idlokasitujuan = l2.idlokasi AND l2.idtenant = ts.idtenant
       WHERE ts.idtransferstok = ? AND ts.idtenant = ?`,
      [req.params.id, ctx.idtenant]
    );
    if (!rows.length) return res.status(404).json({ message: 'Transfer stok tidak ditemukan' });

    const items = await tenantQuery(
      `SELECT tsd.*, b.namabarang, b.kodebarang, b.satuanbesar, b.satuansedang, b.satuankecil
       FROM transferstokdtl tsd
       LEFT JOIN barang b ON tsd.idbarang = b.idbarang AND b.idtenant = tsd.idtenant
       WHERE tsd.idtransferstok = ?`,
      [req.params.id]
    );
    res.json({ ...rows[0], status: mapStatus(rows[0].status), items });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// PUT /transfer-stok/:id — Edit transfer stok DRAFT
exports.update = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { idlokasitujuan, idlokasiasal, tgltrans, items, catatan } = req.body;
    const approve = req.body.approve === true || req.body.status === 'APPROVED';

    if (!items || !items.length) return res.status(400).json({ message: 'Items tidak boleh kosong' });

    await conn.beginTransaction();
    const transfer = await getTransferForUpdate(conn, ctx, req.params.id);
    if (!transfer) {
      await conn.rollback();
      return res.status(404).json({ message: 'Transfer stok tidak ditemukan' });
    }
    if (mapStatus(transfer.status) !== 'DRAFT') {
      await conn.rollback();
      return res.status(400).json({ message: 'Hanya transfer DRAFT yang bisa diedit' });
    }

    const idlokasiAsal = parseInt(idlokasiasal || req.body.idlokasi || transfer.idlokasi, 10);
    const idlokasiTujuan = parseInt(idlokasitujuan || transfer.idlokasitujuan, 10);
    if (!idlokasiAsal) {
      await conn.rollback();
      return res.status(400).json({ message: 'Lokasi asal wajib diisi' });
    }
    if (!idlokasiTujuan) {
      await conn.rollback();
      return res.status(400).json({ message: 'Lokasi tujuan wajib diisi' });
    }
    if (idlokasiAsal === idlokasiTujuan) {
      await conn.rollback();
      return res.status(400).json({ message: 'Lokasi tujuan tidak boleh sama dengan lokasi asal' });
    }

    const detailItems = [];
    for (const item of items) {
      const qty = parseFloat(item.jml || 0);
      if (!item.idbarang || !(qty > 0)) {
        await conn.rollback();
        return res.status(400).json({ message: 'Detail barang tidak valid' });
      }
      detailItems.push({ ...item, jml: qty });
    }

    const tgl = normalizeDate(tgltrans || transfer.tgltrans);
    const status = approve ? 'APPROVED' : 'DRAFT';
    await conn.query(
      `UPDATE transferstok SET idlokasi = ?, idlokasitujuan = ?, tgltrans = ?, catatan = ?, status = ?
       WHERE idtransferstok = ? AND idtenant = ?`,
      [idlokasiAsal, idlokasiTujuan, tgl, catatan || null, status, transfer.idtransferstok, ctx.idtenant]
    );
    await conn.query('DELETE FROM transferstokdtl WHERE idtransferstok = ? AND idtenant = ?', [transfer.idtransferstok, ctx.idtenant]);
    for (const item of detailItems) {
      await conn.query(
        `INSERT INTO transferstokdtl (idtransferstok, idtenant, idbarang, jml, satuan, keterangan)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [transfer.idtransferstok, ctx.idtenant, item.idbarang, item.jml, item.satuan || null, item.keterangan || null]
      );
    }

    const nextTransfer = { ...transfer, idlokasi: idlokasiAsal, idlokasitujuan: idlokasiTujuan, tgltrans: tgl, status };
    if (status === 'APPROVED') {
      await insertTransferKartuStok(conn, ctx, nextTransfer, detailItems);
    } else {
      await deleteTransferKartuStok(conn, ctx, transfer.idtransferstok);
    }

    await conn.commit();
    await logger.history('TRANSFERSTOK_UPDATE', { idtenant: ctx.idtenant, idlokasi: idlokasiAsal, iduser: ctx.iduser, ref: transfer.kodetransferstok, req });
    res.json({ message: 'Transfer stok berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// POST /transfer-stok — Buat transfer stok DRAFT (belum gerak stok)
exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { idlokasitujuan, idlokasiasal, tgltrans, items, catatan } = req.body;
    const idlokasiAsal = parseInt(idlokasiasal || req.body.idlokasi || ctx.idlokasi, 10);
    const approve = req.body.approve === true || req.body.status === 'APPROVED';

    if (!idlokasitujuan) return res.status(400).json({ message: 'idlokasitujuan wajib diisi' });
    if (!idlokasiAsal) return res.status(400).json({ message: 'Lokasi asal wajib diisi' });
    if (parseInt(idlokasitujuan) === idlokasiAsal) return res.status(400).json({ message: 'Lokasi tujuan tidak boleh sama dengan lokasi asal' });
    if (!items || !items.length) return res.status(400).json({ message: 'Items tidak boleh kosong' });

    const kodetransferstok = await generateKodeTransferStok(conn, ctx.idtenant, idlokasiAsal);
    const tgl = normalizeDate(tgltrans);

    await conn.beginTransaction();

    const [headerResult] = await conn.query(
      `INSERT INTO transferstok (idtenant, idlokasi, kodetransferstok, tgltrans, idlokasitujuan, iduser, catatan, status, userentry, tglentry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [ctx.idtenant, idlokasiAsal, kodetransferstok, tgl, idlokasitujuan, ctx.iduser, catatan || null, approve ? 'APPROVED' : 'DRAFT', ctx.iduser]
    );
    const idtransferstok = headerResult.insertId;

    for (const item of items) {
      await conn.query(
        `INSERT INTO transferstokdtl (idtransferstok, idtenant, idbarang, jml, satuan, keterangan)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [idtransferstok, ctx.idtenant, item.idbarang, item.jml, item.satuan || null, item.keterangan || null]
      );
      if (approve) {
        await conn.query(
          `INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idtrans, jenistransaksi)
           VALUES (?, ?, ?, ?, ?, 'K', ?, ?, ?, 'TRANSFERSTOK_KELUAR')`,
          [ctx.idtenant, idlokasiAsal, kodetransferstok, item.idbarang, item.jml, tgl, `Transfer Keluar ${kodetransferstok}`, idtransferstok]
        );
        await conn.query(
          `INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idtrans, jenistransaksi)
           VALUES (?, ?, ?, ?, ?, 'M', ?, ?, ?, 'TRANSFERSTOK_MASUK')`,
          [ctx.idtenant, idlokasitujuan, kodetransferstok, item.idbarang, item.jml, tgl, `Transfer Masuk ${kodetransferstok}`, idtransferstok]
        );
      }
    }

    await conn.commit();
    await logger.history('TRANSFERSTOK_CREATE', { idtenant: ctx.idtenant, idlokasi: idlokasiAsal, iduser: ctx.iduser, ref: kodetransferstok, req });
    res.status(201).json({ message: 'Transfer stok berhasil dibuat', kodetransferstok, idtransferstok });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// PUT /transfer-stok/:id/kirim — Ubah status DIKIRIM, kurangi stok di lokasi asal
exports.kirim = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const [[ts]] = await conn.query(
      'SELECT * FROM transferstok WHERE idtransferstok = ? AND idtenant = ?',
      [req.params.id, ctx.idtenant]
    );
    if (!ts) return res.status(404).json({ message: 'Transfer stok tidak ditemukan' });
    if (ts.status !== 'DRAFT') return res.status(400).json({ message: 'Hanya status DRAFT yang bisa dikirim' });

    const [items] = await conn.query(
      'SELECT * FROM transferstokdtl WHERE idtransferstok = ? AND idtenant = ?',
      [req.params.id, ctx.idtenant]
    );

    const tgl = normalizeDate(ts.tgltrans);
    for (const item of items) {
      await conn.query(
        `INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idtrans, jenistransaksi)
         VALUES (?, ?, ?, ?, ?, 'K', ?, ?, ?, 'TRANSFERSTOK_KELUAR')`,
        [ctx.idtenant, ts.idlokasi, ts.kodetransferstok, item.idbarang, item.jml, tgl, `Transfer Keluar ${ts.kodetransferstok}`, ts.idtransferstok]
      );
    }

    await conn.query(
      "UPDATE transferstok SET status = 'DIKIRIM' WHERE idtransferstok = ? AND idtenant = ?",
      [req.params.id, ctx.idtenant]
    );

    await conn.commit();
    await logger.history('TRANSFERSTOK_KIRIM', { idtenant: ctx.idtenant, idlokasi: ts.idlokasi, iduser: ctx.iduser, ref: ts.kodetransferstok, req });
    res.json({ message: 'Transfer stok berhasil dikirim' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// PUT /transfer-stok/:id/approve — Approve langsung seperti transaksi pembelian/penjualan
exports.approve = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const transfer = await getTransferForUpdate(conn, ctx, req.params.id);
    if (!transfer) {
      await conn.rollback();
      return res.status(404).json({ message: 'Transfer stok tidak ditemukan' });
    }
    if (mapStatus(transfer.status) !== 'DRAFT') {
      await conn.rollback();
      return res.status(400).json({ message: 'Hanya transfer DRAFT yang bisa diapprove' });
    }
    const [items] = await conn.query(
      'SELECT * FROM transferstokdtl WHERE idtransferstok = ? AND idtenant = ?',
      [transfer.idtransferstok, ctx.idtenant]
    );
    await insertTransferKartuStok(conn, ctx, transfer, items);
    await conn.query(
      "UPDATE transferstok SET status = 'APPROVED' WHERE idtransferstok = ? AND idtenant = ?",
      [transfer.idtransferstok, ctx.idtenant]
    );

    await conn.commit();
    await logger.history('TRANSFERSTOK_APPROVE', { idtenant: ctx.idtenant, idlokasi: transfer.idlokasi, iduser: ctx.iduser, ref: transfer.kodetransferstok, req });
    res.json({ message: 'Transfer stok berhasil diapprove' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// PUT /transfer-stok/:id/unapprove — Hapus mutasi stok dan kembalikan DRAFT
exports.unapprove = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const transfer = await getTransferForUpdate(conn, ctx, req.params.id);
    if (!transfer) {
      await conn.rollback();
      return res.status(404).json({ message: 'Transfer stok tidak ditemukan' });
    }
    if (mapStatus(transfer.status) !== 'APPROVED') {
      await conn.rollback();
      return res.status(400).json({ message: 'Hanya transfer APPROVED yang bisa batal approve' });
    }
    await deleteTransferKartuStok(conn, ctx, transfer.idtransferstok);
    await conn.query(
      "UPDATE transferstok SET status = 'DRAFT' WHERE idtransferstok = ? AND idtenant = ?",
      [transfer.idtransferstok, ctx.idtenant]
    );

    await conn.commit();
    await logger.history('TRANSFERSTOK_UNAPPROVE', { idtenant: ctx.idtenant, idlokasi: transfer.idlokasi, iduser: ctx.iduser, ref: transfer.kodetransferstok, req });
    res.json({ message: 'Approve transfer stok dibatalkan' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// PUT /transfer-stok/:id/terima — Ubah status DITERIMA, tambah stok di lokasi tujuan
exports.terima = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    // Boleh diterima oleh lokasi tujuan
    const [[ts]] = await conn.query(
      'SELECT * FROM transferstok WHERE idtransferstok = ? AND idtenant = ?',
      [req.params.id, ctx.idtenant]
    );
    if (!ts) return res.status(404).json({ message: 'Transfer stok tidak ditemukan' });
    if (ts.status !== 'DIKIRIM') return res.status(400).json({ message: 'Hanya status DIKIRIM yang bisa diterima' });

    const [items] = await conn.query(
      'SELECT * FROM transferstokdtl WHERE idtransferstok = ? AND idtenant = ?',
      [req.params.id, ctx.idtenant]
    );

    const tgl = normalizeDate(ts.tgltrans);
    for (const item of items) {
      await conn.query(
        `INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idtrans, jenistransaksi)
         VALUES (?, ?, ?, ?, ?, 'M', ?, ?, ?, 'TRANSFERSTOK_MASUK')`,
        [ctx.idtenant, ts.idlokasitujuan, ts.kodetransferstok, item.idbarang, item.jml, tgl, `Transfer Masuk ${ts.kodetransferstok}`, ts.idtransferstok]
      );
    }

    await conn.query(
      "UPDATE transferstok SET status = 'DITERIMA' WHERE idtransferstok = ? AND idtenant = ?",
      [req.params.id, ctx.idtenant]
    );

    await conn.commit();
    await logger.history('TRANSFERSTOK_TERIMA', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: ts.kodetransferstok, req });
    res.json({ message: 'Transfer stok berhasil diterima' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// PUT /transfer-stok/:id/batal — Batalkan transfer stok
exports.batal = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const [[ts]] = await conn.query(
      'SELECT * FROM transferstok WHERE idtransferstok = ? AND idtenant = ?',
      [req.params.id, ctx.idtenant]
    );
    if (!ts) {
      await conn.rollback();
      return res.status(404).json({ message: 'Transfer stok tidak ditemukan' });
    }
    if (mapStatus(ts.status) === 'CANCELLED') {
      await conn.rollback();
      return res.status(400).json({ message: 'Transfer sudah dibatalkan' });
    }
    if (mapStatus(ts.status) === 'APPROVED') {
      await conn.rollback();
      return res.status(400).json({ message: 'Transfer APPROVED harus batal approve dulu sebelum dibatalkan' });
    }

    await deleteTransferKartuStok(conn, ctx, ts.idtransferstok);
    await conn.query(
      "UPDATE transferstok SET status = 'CANCELLED' WHERE idtransferstok = ? AND idtenant = ?",
      [req.params.id, ctx.idtenant]
    );

    await conn.commit();
    await logger.history('TRANSFERSTOK_BATAL', { idtenant: ctx.idtenant, idlokasi: ts.idlokasi, iduser: ctx.iduser, ref: ts.kodetransferstok, req });
    res.json({ message: 'Transfer stok berhasil dibatalkan' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
