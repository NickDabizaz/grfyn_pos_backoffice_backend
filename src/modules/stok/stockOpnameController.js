const { tenantQuery, getConnection, getTenantContext } = require('../../config/db');
const { generateKodeStockOpname, generateKodePenyesuaian } = require('../../lib/kodetrans');
const logger = require('../../lib/logger');

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeDate(value) {
  return value && /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? String(value).slice(0, 10) : todayLocal();
}

function mapStatus(status) {
  if (status === 'FINALIZED' || status === 'SELESAI' || status === 'AKTIF') return 'APPROVED';
  if (status === 'DIBATALKAN' || status === 'BATAL') return 'CANCELLED';
  return status || 'DRAFT';
}

async function getOpnameForUpdate(conn, ctx, id) {
  const [[row]] = await conn.query(
    'SELECT * FROM stockopname WHERE idstockopname = ? AND idtenant = ? FOR UPDATE',
    [id, ctx.idtenant]
  );
  return row;
}

async function deleteOpnameEffects(conn, ctx, opname) {
  const [penyesuaianRows] = await conn.query(
    'SELECT idpenyesuaianstok FROM penyesuaianstok WHERE idtenant = ? AND keterangan = ?',
    [ctx.idtenant, `Stock Opname ${opname.kodestockopname}`]
  );
  const penyesuaianIds = penyesuaianRows.map(row => row.idpenyesuaianstok);
  if (penyesuaianIds.length) {
    const placeholders = penyesuaianIds.map(() => '?').join(',');
    await conn.query(
      `DELETE FROM kartustok WHERE idtenant = ? AND jenistransaksi = 'STOCKOPNAME' AND idtrans IN (${placeholders})`,
      [ctx.idtenant, ...penyesuaianIds]
    );
    await conn.query(
      `DELETE FROM penyesuaianstokdtl WHERE idtenant = ? AND idpenyesuaianstok IN (${placeholders})`,
      [ctx.idtenant, ...penyesuaianIds]
    );
    await conn.query(
      `DELETE FROM penyesuaianstok WHERE idtenant = ? AND idpenyesuaianstok IN (${placeholders})`,
      [ctx.idtenant, ...penyesuaianIds]
    );
  }
  await conn.query(
    "DELETE FROM kartustok WHERE idtenant = ? AND idtrans = ? AND jenistransaksi = 'STOCKOPNAME'",
    [ctx.idtenant, opname.idstockopname]
  );
}

async function insertOpnameEffects(conn, ctx, opname, details) {
  await deleteOpnameEffects(conn, ctx, opname);
  const tgl = normalizeDate(opname.tgltrans);
  for (const dtl of details) {
    const selisih = parseFloat(dtl.selisih || 0);
    if (selisih !== 0) {
      await insertOpnameMovement(conn, ctx, opname.idlokasi, opname.kodestockopname, opname.idstockopname, dtl.idbarang, selisih, tgl);
    }
  }
}

// GET /stock-opname — Daftar stock opname
exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, status } = req.query;
    let sql = `SELECT so.*, u.namauser, l.kodelokasi, l.namalokasi FROM stockopname so
      LEFT JOIN user u ON so.iduser = u.iduser AND u.idtenant = so.idtenant
      LEFT JOIN lokasi l ON l.idlokasi = so.idlokasi AND l.idtenant = so.idtenant
      WHERE so.idtenant = ?`;
    const params = [ctx.idtenant];
    if (tglwal) { sql += ' AND so.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND so.tgltrans <= ?'; params.push(tglakhir); }
    if (status) {
      const statusValues = status === 'APPROVED' ? ['APPROVED', 'FINALIZED', 'SELESAI', 'AKTIF'] : [status];
      sql += ` AND so.status IN (${statusValues.map(() => '?').join(',')})`;
      params.push(...statusValues);
    }
    sql += ' ORDER BY so.tgltrans DESC, so.idstockopname DESC LIMIT 200';
    const rows = await tenantQuery(sql, params);
    res.json(rows.map(row => ({ ...row, status: mapStatus(row.status) })));
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// POST /stock-opname — Buat opname baru DRAFT, auto-load stok sistem
exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { tgltrans, catatan, idlokasi, items } = req.body;
    const idlokasiTrans = parseInt(idlokasi || ctx.idlokasi, 10);
    if (!idlokasiTrans) return res.status(400).json({ message: 'Lokasi wajib diisi' });
    const tgl = normalizeDate(tgltrans);
    const approve = req.body.approve === true || req.body.status === 'APPROVED';

    const kodestockopname = await generateKodeStockOpname(conn, ctx.idtenant, idlokasiTrans);

    await conn.beginTransaction();

    const [headerResult] = await conn.query(
      `INSERT INTO stockopname (idtenant, idlokasi, kodestockopname, tgltrans, iduser, catatan, status, userentry, tglentry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [ctx.idtenant, idlokasiTrans, kodestockopname, tgl, ctx.iduser, catatan || null, approve ? 'APPROVED' : 'DRAFT', ctx.iduser]
    );
    const idstockopname = headerResult.insertId;

    const inputItems = Array.isArray(items) && items.length ? items : null;
    const [barangList] = inputItems
      ? [inputItems]
      : await conn.query(
          `SELECT b.idbarang,
             COALESCE(SUM(CASE WHEN ks.jenis='M' THEN ks.jml ELSE -ks.jml END), 0) AS stok_sistem,
             0 AS stok_fisik
           FROM barang b
           LEFT JOIN kartustok ks ON ks.idbarang = b.idbarang AND ks.idtenant = b.idtenant AND ks.idlokasi = ?
           WHERE b.idtenant = ? AND b.status = 'AKTIF'
           GROUP BY b.idbarang`,
          [idlokasiTrans, ctx.idtenant]
        );

    for (const br of barangList) {
      const stokSistem = inputItems
        ? await getCurrentStock(conn, ctx.idtenant, idlokasiTrans, br.idbarang, tgl)
        : parseFloat(br.stok_sistem || 0);
      const stokFisik = parseFloat(br.stok_fisik ?? br.jml ?? 0);
      const selisih = stokFisik - stokSistem;
      await conn.query(
        `INSERT INTO stockopnamedtl (idstockopname, idtenant, idbarang, stok_sistem, stok_fisik, selisih)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [idstockopname, ctx.idtenant, br.idbarang, stokSistem, stokFisik, selisih]
      );
      if (approve && selisih !== 0) {
        await insertOpnameMovement(conn, ctx, idlokasiTrans, kodestockopname, idstockopname, br.idbarang, selisih, tgl);
      }
    }

    await conn.commit();
    await logger.history('STOCKOPNAME_CREATE', { idtenant: ctx.idtenant, idlokasi: idlokasiTrans, iduser: ctx.iduser, ref: kodestockopname, req });
    res.status(201).json({ message: 'Stock opname berhasil dibuat', kodestockopname, idstockopname });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// GET /stock-opname/:id — Detail dengan daftar barang, stok sistem, stok fisik
exports.getOne = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await tenantQuery(
      `SELECT so.*, u.namauser, l.kodelokasi, l.namalokasi FROM stockopname so
       LEFT JOIN user u ON so.iduser = u.iduser AND u.idtenant = so.idtenant
       LEFT JOIN lokasi l ON l.idlokasi = so.idlokasi AND l.idtenant = so.idtenant
       WHERE so.idstockopname = ? AND so.idtenant = ?`,
      [req.params.id, ctx.idtenant]
    );
    if (!rows.length) return res.status(404).json({ message: 'Stock opname tidak ditemukan' });

    const items = await tenantQuery(
      `SELECT sod.*, b.namabarang, b.kodebarang, b.satuanbesar, b.satuansedang, b.satuankecil FROM stockopnamedtl sod
       LEFT JOIN barang b ON sod.idbarang = b.idbarang AND b.idtenant = sod.idtenant
       WHERE sod.idstockopname = ?`,
      [req.params.id]
    );
    res.json({ ...rows[0], status: mapStatus(rows[0].status), items });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// PUT /stock-opname/:id/fisik — Update stok fisik per item
exports.update = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { tgltrans, catatan, idlokasi, items } = req.body;
    const approve = req.body.approve === true || req.body.status === 'APPROVED';
    if (!items || !items.length) return res.status(400).json({ message: 'Items tidak boleh kosong' });

    await conn.beginTransaction();
    const opname = await getOpnameForUpdate(conn, ctx, req.params.id);
    if (!opname) {
      await conn.rollback();
      return res.status(404).json({ message: 'Stock opname tidak ditemukan' });
    }
    if (mapStatus(opname.status) !== 'DRAFT') {
      await conn.rollback();
      return res.status(400).json({ message: 'Hanya opname DRAFT yang bisa diedit' });
    }

    const idlokasiTrans = parseInt(idlokasi || opname.idlokasi, 10);
    if (!idlokasiTrans) {
      await conn.rollback();
      return res.status(400).json({ message: 'Lokasi wajib diisi' });
    }
    const tgl = normalizeDate(tgltrans || opname.tgltrans);
    const detailItems = [];
    for (const item of items) {
      const stokFisik = parseFloat(item.stok_fisik ?? item.jml ?? 0);
      if (!item.idbarang || !(stokFisik >= 0)) {
        await conn.rollback();
        return res.status(400).json({ message: 'Detail barang tidak valid' });
      }
      const stokSistem = await getCurrentStock(conn, ctx.idtenant, idlokasiTrans, item.idbarang, tgl);
      detailItems.push({ idbarang: item.idbarang, stok_sistem: stokSistem, stok_fisik: stokFisik, selisih: stokFisik - stokSistem });
    }

    await conn.query(
      'UPDATE stockopname SET idlokasi = ?, tgltrans = ?, catatan = ?, status = ? WHERE idstockopname = ? AND idtenant = ?',
      [idlokasiTrans, tgl, catatan || null, approve ? 'APPROVED' : 'DRAFT', opname.idstockopname, ctx.idtenant]
    );
    await conn.query('DELETE FROM stockopnamedtl WHERE idstockopname = ? AND idtenant = ?', [opname.idstockopname, ctx.idtenant]);
    for (const item of detailItems) {
      await conn.query(
        `INSERT INTO stockopnamedtl (idstockopname, idtenant, idbarang, stok_sistem, stok_fisik, selisih)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [opname.idstockopname, ctx.idtenant, item.idbarang, item.stok_sistem, item.stok_fisik, item.selisih]
      );
    }

    const nextOpname = { ...opname, idlokasi: idlokasiTrans, tgltrans: tgl, status: approve ? 'APPROVED' : 'DRAFT' };
    if (approve) await insertOpnameEffects(conn, ctx, nextOpname, detailItems);
    else await deleteOpnameEffects(conn, ctx, opname);

    await conn.commit();
    await logger.history('STOCKOPNAME_UPDATE', { idtenant: ctx.idtenant, idlokasi: idlokasiTrans, iduser: ctx.iduser, ref: opname.kodestockopname, req });
    res.json({ message: 'Stock opname berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.updateFisik = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { items } = req.body;

    if (!items || !items.length) return res.status(400).json({ message: 'Items tidak boleh kosong' });

    const [[opname]] = await conn.query(
      'SELECT * FROM stockopname WHERE idstockopname = ? AND idtenant = ?',
      [req.params.id, ctx.idtenant]
    );
    if (!opname) return res.status(404).json({ message: 'Stock opname tidak ditemukan' });
    if (mapStatus(opname.status) !== 'DRAFT') return res.status(400).json({ message: 'Hanya opname DRAFT yang bisa diupdate' });

    await conn.beginTransaction();

    for (const item of items) {
      const stokFisik = parseFloat(item.stok_fisik);
      const [[dtl]] = await conn.query(
        'SELECT stok_sistem FROM stockopnamedtl WHERE idstockopname = ? AND idbarang = ? AND idtenant = ?',
        [req.params.id, item.idbarang, ctx.idtenant]
      );
      if (dtl) {
        const selisih = stokFisik - parseFloat(dtl.stok_sistem);
        await conn.query(
          'UPDATE stockopnamedtl SET stok_fisik = ?, selisih = ? WHERE idstockopname = ? AND idbarang = ? AND idtenant = ?',
          [stokFisik, selisih, req.params.id, item.idbarang, ctx.idtenant]
        );
      }
    }

    await conn.commit();
    res.json({ message: 'Stok fisik berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// PUT /stock-opname/:id/finalize — Finalisasi opname, buat penyesuaian stok
exports.finalize = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const opname = await getOpnameForUpdate(conn, ctx, req.params.id);
    if (!opname) {
      await conn.rollback();
      return res.status(404).json({ message: 'Stock opname tidak ditemukan' });
    }
    if (mapStatus(opname.status) !== 'DRAFT') {
      await conn.rollback();
      return res.status(400).json({ message: 'Hanya opname DRAFT yang bisa di-approve' });
    }

    const [details] = await conn.query(
      'SELECT * FROM stockopnamedtl WHERE idstockopname = ? AND idtenant = ?',
      [req.params.id, ctx.idtenant]
    );

    await insertOpnameEffects(conn, ctx, opname, details);

    await conn.query("UPDATE stockopname SET status = 'APPROVED' WHERE idstockopname = ? AND idtenant = ?", [req.params.id, ctx.idtenant]);

    await conn.commit();
    await logger.history('STOCKOPNAME_FINALIZE', { idtenant: ctx.idtenant, idlokasi: opname.idlokasi, iduser: ctx.iduser, ref: opname.kodestockopname, req });
    res.json({ message: 'Stock opname berhasil difinalisasi', jumlah_penyesuaian: details.length });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// PUT /stock-opname/:id/unapprove — Batal approve dan hapus mutasi opname
exports.unapprove = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const opname = await getOpnameForUpdate(conn, ctx, req.params.id);
    if (!opname) {
      await conn.rollback();
      return res.status(404).json({ message: 'Stock opname tidak ditemukan' });
    }
    if (mapStatus(opname.status) !== 'APPROVED') {
      await conn.rollback();
      return res.status(400).json({ message: 'Hanya opname APPROVED yang bisa batal approve' });
    }

    await deleteOpnameEffects(conn, ctx, opname);
    await conn.query("UPDATE stockopname SET status = 'DRAFT' WHERE idstockopname = ? AND idtenant = ?", [opname.idstockopname, ctx.idtenant]);
    await conn.commit();
    await logger.history('STOCKOPNAME_UNAPPROVE', { idtenant: ctx.idtenant, idlokasi: opname.idlokasi, iduser: ctx.iduser, ref: opname.kodestockopname, req });
    res.json({ message: 'Approve stock opname dibatalkan' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

async function getCurrentStock(conn, idtenant, idlokasi, idbarang, tgl) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(CASE WHEN jenis='M' THEN jml ELSE -jml END), 0) AS stok
     FROM kartustok
     WHERE idtenant = ? AND idlokasi = ? AND idbarang = ? AND tgltrans <= ?`,
    [idtenant, idlokasi, idbarang, tgl]
  );
  return parseFloat(row?.stok || 0);
}

async function insertOpnameMovement(conn, ctx, idlokasi, kode, idstockopname, idbarang, selisih, tgl) {
  const jenis = selisih > 0 ? 'M' : 'K';
  await conn.query(
    `INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idtrans, jenistransaksi)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'STOCKOPNAME')`,
    [ctx.idtenant, idlokasi, kode, idbarang, Math.abs(selisih), jenis, tgl, `Opname ${kode}`, idstockopname]
  );
}
