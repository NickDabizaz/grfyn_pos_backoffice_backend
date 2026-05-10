/* Controller pelunasan hutang ke supplier.
   Menangani daftar, detail, pembuatan, dan penghapusan pelunasan hutang
   beserta integrasi kartu hutang (OPEN/LUNAS). */
const { tenantQuery, getConnection, getTenantContext } = require('../config/db');
const { generateKodePelunasanHutang } = require('../lib/kodetrans');
const logger = require('../lib/logger');

// GET /pelunasanhutang — Daftar pelunasan hutang dengan filter supplier & rentang tanggal
exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idsupplier, tglwal, tglakhir } = req.query;
    let sql = `SELECT ph.*, s.namasupplier FROM pelunasanhutang ph LEFT JOIN supplier s ON ph.idsupplier = s.idsupplier AND s.idtenant = ph.idtenant WHERE 1=1`;
    const params = [];
    // Query dinamis: filter tenant, lokasi, supplier, dan rentang tanggal
    sql += ' AND ph.idtenant = ?'; params.push(ctx.idtenant);
    sql += ' AND ph.idlokasi = ?'; params.push(ctx.idlokasi);
    if (idsupplier) { sql += ' AND ph.idsupplier = ?'; params.push(idsupplier); }
    if (tglwal) { sql += ' AND ph.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND ph.tgltrans <= ?'; params.push(tglakhir); }
    sql += ' ORDER BY ph.tgltrans DESC, ph.idpelunasan DESC';
    const rows = await tenantQuery(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /pelunasanhutang/:id — Detail satu pelunasan hutang beserta detail transaksi yang dilunasi
exports.getOne = async (req, res) => {
  try {
    const ctx = getTenantContext();
    let sql = `SELECT ph.*, s.namasupplier FROM pelunasanhutang ph LEFT JOIN supplier s ON ph.idsupplier = s.idsupplier AND s.idtenant = ph.idtenant WHERE ph.idpelunasan = ? AND ph.idlokasi = ?`;
    const rows = await tenantQuery(sql, [req.params.id, ctx.idlokasi]);
    if (rows.length === 0) return res.status(404).json({ message: 'Pelunasan hutang tidak ditemukan' });

    // Ambil detail pelunasan (transaksi beli mana saja yang dilunasi)
    let sql2 = 'SELECT * FROM pelunasanhutangdtl WHERE idpelunasan = ?';
    const details = await tenantQuery(sql2, [req.params.id]);
    res.json({ ...rows[0], details });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// POST /pelunasanhutang — Buat pelunasan hutang baru (validasi total, catat detail, update status kartu hutang)
exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const { idsupplier, tgltrans, total_amount, metodbayar, catatan, details } = req.body;

    if (!idsupplier) return res.status(400).json({ message: 'Supplier harus dipilih' }); // Validasi: supplier wajib
    if (!details || !details.length) return res.status(400).json({ message: 'Detail pelunasan tidak boleh kosong' }); // Validasi: minimal 1 detail

    // Validasi: total amount harus cocok dengan jumlah amount di detail
    const totalDetail = details.reduce((sum, d) => sum + parseFloat(d.amount), 0);
    if (Math.abs(totalDetail - parseFloat(total_amount)) > 0.01) {
      return res.status(400).json({ message: 'Total amount tidak sesuai dengan jumlah detail' });
    }

    // Generate kode pelunasan otomatis
    const kodepelunasan = await generateKodePelunasanHutang(conn, ctx.idtenant, ctx.idlokasi);

    // Insert header pelunasan hutang
    let sql = 'INSERT INTO pelunasanhutang (idtenant, idlokasi, idsupplier, kodepelunasan, tgltrans, total_amount, metodbayar, catatan, userentry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const [result] = await conn.query(sql, [ctx.idtenant, ctx.idlokasi, idsupplier, kodepelunasan, tgltrans, total_amount, metodbayar || 'TUNAI', catatan || '', ctx.iduser]);
    const idpelunasan = result.insertId;

    // Iterasi detail: catat setiap pelunasan per transaksi beli
    for (const d of details) {
      let sql2 = 'INSERT INTO pelunasanhutangdtl (idpelunasan, kodetrans, amount) VALUES (?, ?, ?)';
      await conn.query(sql2, [idpelunasan, d.kodetrans, d.amount]);

      // Catat pengurangan hutang di kartuhutang (amount negatif)
      let sql3 = 'INSERT INTO kartuhutang (idtenant, idlokasi, idsupplier, kodetrans, jenis, kodetransreferensi, amount, tgltrans, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
      await conn.query(sql3, [ctx.idtenant, ctx.idlokasi, idsupplier, d.kodetrans, 'PELUNASAN', kodepelunasan, -Math.abs(d.amount), tgltrans, 'OPEN']);

      // Cek sisa hutang: jika total amount mendekati 0 (selisih < 0.01), tandai LUNAS
      let sql4 = "SELECT kodetrans, SUM(amount) as sisa FROM kartuhutang WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? GROUP BY kodetrans";
      const [[hutang]] = await conn.query(sql4, [d.kodetrans, ctx.idtenant, ctx.idlokasi]);

      if (hutang && Math.abs(parseFloat(hutang.sisa) - Math.abs(d.amount)) < 0.01) {
        let sql5 = "UPDATE kartuhutang SET status = 'LUNAS' WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? AND jenis = 'BELI'";
        await conn.query(sql5, [d.kodetrans, ctx.idtenant, ctx.idlokasi]);
      }
    }

    await conn.commit();
    await logger.history('PELUNASAN_HUTANG_CREATE', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: kodepelunasan, req });
    res.status(201).json({ message: 'Pelunasan hutang berhasil ditambah', idpelunasan, kodepelunasan });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// DELETE /pelunasanhutang/:id — Hapus pelunasan hutang (balikkan status hutang ke OPEN)
exports.remove = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const { id } = req.params;

    let sql = 'SELECT * FROM pelunasanhutang WHERE idpelunasan = ? AND idtenant = ? AND idlokasi = ?';
    const [[pelunasan]] = await conn.query(sql, [id, ctx.idtenant, ctx.idlokasi]);
    if (!pelunasan) return res.status(404).json({ message: 'Pelunasan hutang tidak ditemukan' });

    // Ambil detail pelunasan untuk mengembalikan status hutang
    let sql2 = 'SELECT * FROM pelunasanhutangdtl WHERE idpelunasan = ?';
    const [details] = await conn.query(sql2, [id]);

    // Balikkan status setiap transaksi beli yang dilunasi menjadi OPEN kembali
    for (const d of details) {
      let sql3 = "UPDATE kartuhutang SET status = 'OPEN' WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? AND jenis = 'BELI'";
      await conn.query(sql3, [d.kodetrans, ctx.idtenant, ctx.idlokasi]);

      // Hapus entri pelunasan dari kartuhutang
      let sql4 = "DELETE FROM kartuhutang WHERE kodetransreferensi = ? AND idtenant = ? AND idlokasi = ? AND jenis = 'PELUNASAN'";
      await conn.query(sql4, [pelunasan.kodepelunasan, ctx.idtenant, ctx.idlokasi]);
    }

    // Hapus detail dan header pelunasan
    let sql5 = 'DELETE FROM pelunasanhutangdtl WHERE idpelunasan = ?';
    await conn.query(sql5, [id]);
    let sql6 = 'DELETE FROM pelunasanhutang WHERE idpelunasan = ? AND idtenant = ? AND idlokasi = ?';
    await conn.query(sql6, [id, ctx.idtenant, ctx.idlokasi]);

    await conn.commit();
    await logger.history('PELUNASAN_HUTANG_DELETE', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: pelunasan.kodepelunasan, req });
    res.json({ message: 'Pelunasan hutang berhasil dihapus' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
