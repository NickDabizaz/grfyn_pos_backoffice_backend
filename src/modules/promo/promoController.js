const { tenantQuery, getConnection, getTenantContext } = require('../../config/db');
const { hitungPromo } = require('../../lib/promoHelper');
const logger = require('../../lib/logger');

const VALID_JENIS = ['PERSEN_ITEM', 'NOMINAL_ITEM', 'PERSEN_TRANSAKSI', 'NOMINAL_TRANSAKSI', 'BELI_X_GRATIS_Y'];
const VALID_BERLAKU = ['PENJUALAN', 'PEMBELIAN', 'KEDUANYA'];

// GET /api/promo — Daftar semua promo
exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { search, status, jenis, berlaku_untuk } = req.query;

    let sql = `
      SELECT p.*,
             DATE_FORMAT(p.tglawal, '%Y-%m-%d')  AS tglawal,
             DATE_FORMAT(p.tglakhir, '%Y-%m-%d') AS tglakhir,
             COUNT(DISTINCT pd.idpromodtl) AS jumlah_item,
             COUNT(DISTINCT pg.idpromobaranggratis) AS jumlah_barang_gratis
      FROM promo p
      LEFT JOIN promodtl pd ON pd.idpromo = p.idpromo AND pd.idtenant = p.idtenant
      LEFT JOIN promobarang_gratis pg ON pg.idpromo = p.idpromo AND pg.idtenant = p.idtenant
      WHERE p.idtenant = ?
    `;
    const params = [ctx.idtenant];

    if (search) {
      sql += ' AND (p.namapromo LIKE ? OR p.kodepromo LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (status) { sql += ' AND p.status = ?';         params.push(status); }
    if (jenis)  { sql += ' AND p.jenis = ?';          params.push(jenis); }
    if (berlaku_untuk) { sql += ' AND (p.berlaku_untuk = ? OR p.berlaku_untuk = \'KEDUANYA\')'; params.push(berlaku_untuk); }

    sql += ' GROUP BY p.idpromo ORDER BY p.tglawal DESC, p.idpromo DESC';

    const rows = await tenantQuery(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/promo/aktif — Promo aktif pada hari ini (untuk dropdown transaksi)
exports.getAktif = async (req, res) => {
  try {
    const ctx   = getTenantContext();
    const today = req.query.tgl || new Date().toISOString().slice(0, 10);
    const berlaku_untuk = req.query.berlaku_untuk || null;

    let sql = `
      SELECT p.*,
             DATE_FORMAT(p.tglawal, '%Y-%m-%d')  AS tglawal,
             DATE_FORMAT(p.tglakhir, '%Y-%m-%d') AS tglakhir
      FROM promo p
      WHERE p.idtenant = ? AND p.status = 'AKTIF'
        AND p.tglawal <= ? AND p.tglakhir >= ?
    `;
    const params = [ctx.idtenant, today, today];

    if (berlaku_untuk) {
      sql += " AND (p.berlaku_untuk = ? OR p.berlaku_untuk = 'KEDUANYA')";
      params.push(berlaku_untuk);
    }

    sql += ' ORDER BY p.idpromo ASC';

    const rows = await tenantQuery(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/promo/:id — Detail satu promo
exports.getOne = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { id } = req.params;

    const rows = await tenantQuery(
      `SELECT p.*,
              DATE_FORMAT(p.tglawal, '%Y-%m-%d')  AS tglawal,
              DATE_FORMAT(p.tglakhir, '%Y-%m-%d') AS tglakhir
       FROM promo p
       WHERE p.idpromo = ? AND p.idtenant = ?`,
      [id, ctx.idtenant]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Promo tidak ditemukan' });

    const items = await tenantQuery(
      `SELECT pd.*, b.namabarang, b.kodebarang
       FROM promodtl pd
       LEFT JOIN barang b ON pd.idbarang = b.idbarang AND b.idtenant = pd.idtenant
       WHERE pd.idpromo = ? AND pd.idtenant = ?`,
      [id, ctx.idtenant]
    );

    const barangGratis = await tenantQuery(
      `SELECT pg.*, b.namabarang, b.kodebarang
       FROM promobarang_gratis pg
       LEFT JOIN barang b ON pg.idbarang = b.idbarang AND b.idtenant = pg.idtenant
       WHERE pg.idpromo = ? AND pg.idtenant = ?`,
      [id, ctx.idtenant]
    );

    res.json({ ...rows[0], items, barang_gratis: barangGratis });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// POST /api/promo/preview — Hitung diskon promo untuk transaksi yang sedang dibuat
exports.preview = async (req, res) => {
  let conn;
  try {
    conn = await getConnection();
    const ctx = getTenantContext();
    const { idpromo, items, tgltrans, berlaku_untuk } = req.body;

    if (!idpromo)  return res.status(400).json({ message: 'idpromo wajib diisi' });
    if (!items || !items.length) return res.status(400).json({ message: 'items tidak boleh kosong' });

    const tgl = tgltrans || new Date().toISOString().slice(0, 10);
    const buFor = berlaku_untuk || 'PENJUALAN';

    // Siapkan items dengan subtotal untuk kalkulasi
    const [[tenant]] = await conn.query('SELECT ppn FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
    const ppnPercent  = tenant ? parseFloat(tenant.ppn) : 11;

    const processedItems = items.map(item => {
      const harga   = parseFloat(item.harga);
      const jml     = parseFloat(item.jml) || 1;
      const diskon  = parseFloat(item.diskon) || 0;
      const ppnMode = item.ppn_mode || 'INCLUDE';
      const ppnRp   = ppnMode === 'INCLUDE' ? (harga * jml * ppnPercent) / 100 : 0;
      const disknRp = (harga * jml * diskon) / 100;
      const subtotal = (harga * jml) + ppnRp - disknRp;
      return { ...item, harga, jml, subtotal };
    });

    const hasil = await hitungPromo(conn, {
      idpromo, idtenant: ctx.idtenant,
      tgltrans: tgl, berlaku_untuk: buFor,
      items: processedItems,
    });

    const grandtotalSebelum = processedItems.reduce((s, it) => s + it.subtotal, 0);
    const totalItemDiskon   = [...hasil.itemDiskonPromo.values()].reduce((s, v) => s + v, 0);
    const totalDiskon       = hasil.diskonPromoTransaksi + totalItemDiskon;
    const grandtotalSetelah = grandtotalSebelum - totalDiskon;

    res.json({
      idpromo,
      namapromo: hasil.promo?.namapromo,
      jenis: hasil.promo?.jenis,
      berlaku_untuk: hasil.promo?.berlaku_untuk,
      diskon_per_transaksi: hasil.diskonPromoTransaksi,
      diskon_per_item: Object.fromEntries(hasil.itemDiskonPromo),
      total_diskon: totalDiskon,
      grandtotal_sebelum: grandtotalSebelum,
      grandtotal_setelah: grandtotalSetelah,
      barang_gratis: hasil.barangGratis,
    });
  } catch (err) {
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    if (conn) conn.release();
  }
};

// POST /api/promo — Buat promo baru
exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const {
      kodepromo, namapromo, deskripsi, jenis, berlaku_untuk,
      nilai, nilai_x, nilai_y,
      min_transaksi, min_qty, max_diskon,
      tglawal, tglakhir,
      berlaku_semua_barang, max_penggunaan,
      status, items, barang_gratis,
    } = req.body;

    if (!kodepromo || !namapromo) {
      await conn.rollback();
      return res.status(400).json({ message: 'kodepromo dan namapromo wajib diisi' });
    }
    if (!VALID_JENIS.includes(jenis)) {
      await conn.rollback();
      return res.status(400).json({ message: `jenis harus salah satu dari: ${VALID_JENIS.join(', ')}` });
    }
    if (!VALID_BERLAKU.includes(berlaku_untuk)) {
      await conn.rollback();
      return res.status(400).json({ message: `berlaku_untuk harus salah satu dari: ${VALID_BERLAKU.join(', ')}` });
    }
    if (!tglawal || !tglakhir) {
      await conn.rollback();
      return res.status(400).json({ message: 'tglawal dan tglakhir wajib diisi' });
    }
    if (tglawal > tglakhir) {
      await conn.rollback();
      return res.status(400).json({ message: 'tglawal tidak boleh melebihi tglakhir' });
    }

    const semuaBarang = berlaku_semua_barang === false || berlaku_semua_barang === 0 ? 0 : 1;
    if (!semuaBarang && jenis !== 'PERSEN_TRANSAKSI' && jenis !== 'NOMINAL_TRANSAKSI') {
      if (!items || items.length === 0) {
        await conn.rollback();
        return res.status(400).json({ message: 'items (idbarang) wajib diisi jika berlaku_semua_barang = false' });
      }
    }

    if (jenis === 'BELI_X_GRATIS_Y') {
      if (!nilai_x || !nilai_y) {
        await conn.rollback();
        return res.status(400).json({ message: 'nilai_x dan nilai_y wajib diisi untuk promo BELI_X_GRATIS_Y' });
      }
      if (!barang_gratis || barang_gratis.length === 0) {
        await conn.rollback();
        return res.status(400).json({ message: 'barang_gratis wajib diisi untuk promo BELI_X_GRATIS_Y' });
      }
    }

    const [result] = await conn.query(
      `INSERT INTO promo
         (idtenant, kodepromo, namapromo, deskripsi, jenis, berlaku_untuk,
          nilai, nilai_x, nilai_y, min_transaksi, min_qty, max_diskon,
          tglawal, tglakhir, berlaku_semua_barang, max_penggunaan, status, userentry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.idtenant, kodepromo, namapromo, deskripsi || null, jenis, berlaku_untuk,
        parseFloat(nilai) || 0,
        nilai_x != null ? parseInt(nilai_x) : null,
        nilai_y != null ? parseInt(nilai_y) : null,
        parseFloat(min_transaksi) || 0,
        parseFloat(min_qty) || 0,
        max_diskon != null ? parseFloat(max_diskon) : null,
        tglawal, tglakhir,
        semuaBarang,
        max_penggunaan != null ? parseInt(max_penggunaan) : null,
        status || 'AKTIF',
        ctx.iduser,
      ]
    );
    const idpromo = result.insertId;

    if (!semuaBarang && items && items.length > 0) {
      for (const idbarang of items) {
        await conn.query(
          'INSERT INTO promodtl (idpromo, idtenant, idbarang) VALUES (?, ?, ?)',
          [idpromo, ctx.idtenant, idbarang]
        );
      }
    }

    if (jenis === 'BELI_X_GRATIS_Y' && barang_gratis && barang_gratis.length > 0) {
      for (const g of barang_gratis) {
        await conn.query(
          'INSERT INTO promobarang_gratis (idpromo, idtenant, idbarang, jml) VALUES (?, ?, ?, ?)',
          [idpromo, ctx.idtenant, g.idbarang, parseFloat(g.jml) || 1]
        );
      }
    }

    await conn.commit();
    await logger.history('PROMO_CREATE', { idtenant: ctx.idtenant, iduser: ctx.iduser, ref: kodepromo, req });
    res.status(201).json({ message: 'Promo berhasil ditambah', idpromo });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// PUT /api/promo/:id — Update promo
exports.update = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const { id } = req.params;

    const [[existing]] = await conn.query(
      'SELECT idpromo FROM promo WHERE idpromo = ? AND idtenant = ?',
      [id, ctx.idtenant]
    );
    if (!existing) {
      await conn.rollback();
      return res.status(404).json({ message: 'Promo tidak ditemukan' });
    }

    const {
      kodepromo, namapromo, deskripsi, jenis, berlaku_untuk,
      nilai, nilai_x, nilai_y,
      min_transaksi, min_qty, max_diskon,
      tglawal, tglakhir,
      berlaku_semua_barang, max_penggunaan,
      status, items, barang_gratis,
    } = req.body;

    if (jenis && !VALID_JENIS.includes(jenis)) {
      await conn.rollback();
      return res.status(400).json({ message: `jenis harus salah satu dari: ${VALID_JENIS.join(', ')}` });
    }
    if (berlaku_untuk && !VALID_BERLAKU.includes(berlaku_untuk)) {
      await conn.rollback();
      return res.status(400).json({ message: `berlaku_untuk harus salah satu dari: ${VALID_BERLAKU.join(', ')}` });
    }
    if (tglawal && tglakhir && tglawal > tglakhir) {
      await conn.rollback();
      return res.status(400).json({ message: 'tglawal tidak boleh melebihi tglakhir' });
    }

    const semuaBarang = berlaku_semua_barang === false || berlaku_semua_barang === 0 ? 0 : 1;

    await conn.query(
      `UPDATE promo SET
         kodepromo = COALESCE(?, kodepromo),
         namapromo = COALESCE(?, namapromo),
         deskripsi = ?,
         jenis = COALESCE(?, jenis),
         berlaku_untuk = COALESCE(?, berlaku_untuk),
         nilai = COALESCE(?, nilai),
         nilai_x = ?,
         nilai_y = ?,
         min_transaksi = COALESCE(?, min_transaksi),
         min_qty = COALESCE(?, min_qty),
         max_diskon = ?,
         tglawal = COALESCE(?, tglawal),
         tglakhir = COALESCE(?, tglakhir),
         berlaku_semua_barang = ?,
         max_penggunaan = ?,
         status = COALESCE(?, status)
       WHERE idpromo = ? AND idtenant = ?`,
      [
        kodepromo || null, namapromo || null,
        deskripsi !== undefined ? deskripsi : null,
        jenis || null, berlaku_untuk || null,
        nilai != null ? parseFloat(nilai) : null,
        nilai_x != null ? parseInt(nilai_x) : null,
        nilai_y != null ? parseInt(nilai_y) : null,
        min_transaksi != null ? parseFloat(min_transaksi) : null,
        min_qty != null ? parseFloat(min_qty) : null,
        max_diskon != null ? parseFloat(max_diskon) : null,
        tglawal || null, tglakhir || null,
        semuaBarang,
        max_penggunaan != null ? parseInt(max_penggunaan) : null,
        status || null,
        id, ctx.idtenant,
      ]
    );

    await conn.query('DELETE FROM promodtl WHERE idpromo = ? AND idtenant = ?', [id, ctx.idtenant]);
    if (!semuaBarang && items && items.length > 0) {
      for (const idbarang of items) {
        await conn.query(
          'INSERT INTO promodtl (idpromo, idtenant, idbarang) VALUES (?, ?, ?)',
          [id, ctx.idtenant, idbarang]
        );
      }
    }

    await conn.query('DELETE FROM promobarang_gratis WHERE idpromo = ? AND idtenant = ?', [id, ctx.idtenant]);
    if (barang_gratis && barang_gratis.length > 0) {
      for (const g of barang_gratis) {
        await conn.query(
          'INSERT INTO promobarang_gratis (idpromo, idtenant, idbarang, jml) VALUES (?, ?, ?, ?)',
          [id, ctx.idtenant, g.idbarang, parseFloat(g.jml) || 1]
        );
      }
    }

    await conn.commit();
    await logger.history('PROMO_UPDATE', { idtenant: ctx.idtenant, iduser: ctx.iduser, ref: id, req });
    res.json({ message: 'Promo berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// DELETE /api/promo/:id — Hapus promo
exports.remove = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const { id } = req.params;

    const [[existing]] = await conn.query(
      'SELECT idpromo FROM promo WHERE idpromo = ? AND idtenant = ?',
      [id, ctx.idtenant]
    );
    if (!existing) {
      await conn.rollback();
      return res.status(404).json({ message: 'Promo tidak ditemukan' });
    }

    // Check if promo is in use
    const [[inUse]] = await conn.query(
      "SELECT idjual FROM jual WHERE idpromo = ? AND idtenant = ? AND status != 'CANCELLED' LIMIT 1",
      [id, ctx.idtenant]
    );
    if (inUse) {
      await conn.rollback();
      return res.status(400).json({ message: 'Promo tidak dapat dihapus karena sudah digunakan dalam transaksi' });
    }

    await conn.query('DELETE FROM promobarang_gratis WHERE idpromo = ? AND idtenant = ?', [id, ctx.idtenant]);
    await conn.query('DELETE FROM promodtl WHERE idpromo = ? AND idtenant = ?', [id, ctx.idtenant]);
    await conn.query('DELETE FROM promo WHERE idpromo = ? AND idtenant = ?', [id, ctx.idtenant]);

    await conn.commit();
    res.json({ message: 'Promo berhasil dihapus' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
