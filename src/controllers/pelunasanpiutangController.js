/* Controller pelunasan piutang dari customer.
   Menangani daftar, detail, pembuatan, dan penghapusan pelunasan piutang
   beserta integrasi kartu piutang (OPEN/LUNAS). */
const { tenantQuery, getConnection, getTenantContext } = require('../config/db');
const { generateKodePelunasanPiutang } = require('../lib/kodetrans');
const logger = require('../lib/logger');

// GET /pelunasanpiutang — Daftar pelunasan piutang dengan filter customer & rentang tanggal
exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idcustomer, tglwal, tglakhir } = req.query;
    let sql = `SELECT pp.*, c.namacustomer FROM pelunasanpiutang pp LEFT JOIN customer c ON pp.idcustomer = c.idcustomer AND c.idtenant = pp.idtenant WHERE 1=1`;
    const params = [];
    // Query dinamis: filter tenant, lokasi, customer, dan rentang tanggal
    sql += ' AND pp.idtenant = ?'; params.push(ctx.idtenant);
    sql += ' AND pp.idlokasi = ?'; params.push(ctx.idlokasi);
    if (idcustomer) { sql += ' AND pp.idcustomer = ?'; params.push(idcustomer); }
    if (tglwal) { sql += ' AND pp.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND pp.tgltrans <= ?'; params.push(tglakhir); }
    sql += ' ORDER BY pp.tgltrans DESC, pp.idpelunasan DESC';
    const rows = await tenantQuery(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /pelunasanpiutang/:id — Detail satu pelunasan piutang beserta detail transaksi yang dilunasi
exports.getOne = async (req, res) => {
  try {
    const ctx = getTenantContext();
    let sql = `SELECT pp.*, c.namacustomer FROM pelunasanpiutang pp LEFT JOIN customer c ON pp.idcustomer = c.idcustomer AND c.idtenant = pp.idtenant WHERE pp.idpelunasan = ? AND pp.idlokasi = ?`;
    const rows = await tenantQuery(sql, [req.params.id, ctx.idlokasi]);
    if (rows.length === 0) return res.status(404).json({ message: 'Pelunasan piutang tidak ditemukan' });

    // Ambil detail pelunasan (transaksi jual mana saja yang dilunasi)
    let sql2 = 'SELECT * FROM pelunasanpiutangdtl WHERE idpelunasan = ?';
    const details = await tenantQuery(sql2, [req.params.id]);
    res.json({ ...rows[0], details });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// POST /pelunasanpiutang — Buat pelunasan piutang baru (validasi total, catat detail, update status kartu piutang)
exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const { idcustomer, tgltrans, total_amount, metodbayar, catatan, details } = req.body;

    if (!idcustomer) return res.status(400).json({ message: 'Customer harus dipilih' }); // Validasi: customer wajib
    if (!details || !details.length) return res.status(400).json({ message: 'Detail pelunasan tidak boleh kosong' }); // Validasi: minimal 1 detail

    // Validasi: total amount harus cocok dengan jumlah amount di detail
    const totalDetail = details.reduce((sum, d) => sum + parseFloat(d.amount), 0);
    if (Math.abs(totalDetail - parseFloat(total_amount)) > 0.01) {
      return res.status(400).json({ message: 'Total amount tidak sesuai dengan jumlah detail' });
    }

    // Generate kode pelunasan otomatis
    const kodepelunasan = await generateKodePelunasanPiutang(conn, ctx.idtenant, ctx.idlokasi);

    // Insert header pelunasan piutang
    let sql = 'INSERT INTO pelunasanpiutang (idtenant, idlokasi, idcustomer, kodepelunasan, tgltrans, total_amount, metodbayar, catatan, userentry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const [result] = await conn.query(sql, [ctx.idtenant, ctx.idlokasi, idcustomer, kodepelunasan, tgltrans, total_amount, metodbayar || 'TUNAI', catatan || '', ctx.iduser]);
    const idpelunasan = result.insertId;

    // Iterasi detail: catat setiap pelunasan per transaksi jual
    for (const d of details) {
      let sql2 = 'INSERT INTO pelunasanpiutangdtl (idpelunasan, kodetrans, amount) VALUES (?, ?, ?)';
      await conn.query(sql2, [idpelunasan, d.kodetrans, d.amount]);

      // Update kartupiutang: tambahkan terbayar, kurangi sisa
      // Cek dulu nilai amount dan sisa sekarang
      let sql3 = 'SELECT amount, terbayar, sisa FROM kartupiutang WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? AND jenis = ?';
      const [[kp]] = await conn.query(sql3, [d.kodetrans, ctx.idtenant, ctx.idlokasi, 'JUAL']);

      if (kp) {
        const currentTerbayar = parseFloat(kp.terbayar) || 0;
        const currentSisa = parseFloat(kp.sisa) || 0;
        const paymentAmount = Math.abs(parseFloat(d.amount));
        const newTerbayar = currentTerbayar + paymentAmount;
        const newSisa = currentSisa - paymentAmount;
        const newStatus = newSisa <= 0 ? 'LUNAS' : 'OPEN';

        let sql4 = 'UPDATE kartupiutang SET terbayar = ?, sisa = ?, status = ? WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? AND jenis = ?';
        await conn.query(sql4, [newTerbayar, newSisa, newStatus, d.kodetrans, ctx.idtenant, ctx.idlokasi, 'JUAL']);
      }
    }

    await conn.commit();
    await logger.history('PELUNASAN_PIUTANG_CREATE', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: kodepelunasan, req });
    res.status(201).json({ message: 'Pelunasan piutang berhasil ditambah', idpelunasan, kodepelunasan });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// DELETE /pelunasanpiutang/:id — Hapus pelunasan piutang (balikkan status piutang ke OPEN)
exports.remove = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const { id } = req.params;

    let sql = 'SELECT * FROM pelunasanpiutang WHERE idpelunasan = ? AND idtenant = ? AND idlokasi = ?';
    const [[pelunasan]] = await conn.query(sql, [id, ctx.idtenant, ctx.idlokasi]);
    if (!pelunasan) return res.status(404).json({ message: 'Pelunasan piutang tidak ditemukan' });

    // Ambil detail pelunasan untuk mengembalikan status piutang
    let sql2 = 'SELECT * FROM pelunasanpiutangdtl WHERE idpelunasan = ?';
    const [details] = await conn.query(sql2, [id]);

    // Kembalikan status piutang: kurangi terbayar, tambah sisa
    for (const d of details) {
      // Cari baris kartupiutang untuk transaksi ini (jenis JUAL)
      let sql3 = 'SELECT * FROM kartupiutang WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? AND jenis = ?';
      const [[kp]] = await conn.query(sql3, [d.kodetrans, ctx.idtenant, ctx.idlokasi, 'JUAL']);

      if (kp) {
        const currentTerbayar = parseFloat(kp.terbayar) || 0;
        const currentSisa = parseFloat(kp.sisa) || 0;
        const paymentAmount = parseFloat(d.amount) || 0;
        const newTerbayar = Math.max(0, currentTerbayar - paymentAmount);
        const newSisa = currentSisa + paymentAmount;

        let sql4 = 'UPDATE kartupiutang SET terbayar = ?, sisa = ?, status = ? WHERE idkartupiutang = ?';
        await conn.query(sql4, [newTerbayar, newSisa, 'OPEN', kp.idkartupiutang]);
      }
    }

    // Hapus detail dan header pelunasan
    let sql5 = 'DELETE FROM pelunasanpiutangdtl WHERE idpelunasan = ?';
    await conn.query(sql5, [id]);
    let sql6 = 'DELETE FROM pelunasanpiutang WHERE idpelunasan = ? AND idtenant = ? AND idlokasi = ?';
    await conn.query(sql6, [id, ctx.idtenant, ctx.idlokasi]);

    await conn.commit();
    await logger.history('PELUNASAN_PIUTANG_DELETE', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: pelunasan.kodepelunasan, req });
    res.json({ message: 'Pelunasan piutang berhasil dihapus' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
