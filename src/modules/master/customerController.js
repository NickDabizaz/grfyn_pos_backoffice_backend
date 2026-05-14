// Controller untuk manajemen data customer (pelanggan).
// Menangani CRUD customer dengan pengecekan referensi transaksi penjualan sebelum penghapusan.

const { tenantQuery, tenantExecute, getTenantContext } = require('../../config/db');
const { generateKodeMaster } = require('../../lib/kodetrans');
const logger = require('../../lib/logger');

// GET /customer — Menampilkan semua customer dengan filter pencarian opsional
exports.getAll = async (req, res) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT * FROM customer WHERE 1=1';
    const params = [];
    // Filter opsional: pencarian berdasarkan nama/kode customer
    if (search) { sql += ' AND (namacustomer LIKE ? OR kodecustomer LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY idcustomer ASC';
    const rows = await tenantQuery(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// POST /customer — Membuat customer baru dengan kode auto-generate
exports.create = async (req, res) => {
  try {
    const ctx                          = getTenantContext();
    const { namacustomer, alamat, hp, kodecustomer: customKode, status } = req.body;
    // Generate kode customer: gunakan kustom jika ada, jika tidak auto-generate
    const kodecustomer = (customKode && customKode.trim())
      ? customKode.trim().toUpperCase()
      : await generateKodeMaster(await require('../../config/db').getConnection(), 'CST', ctx.idtenant, 'customer', 'kodecustomer', 4);
    let sql = 'INSERT INTO customer (idtenant, kodecustomer, namacustomer, alamat, hp, status, userentry) VALUES (?, ?, ?, ?, ?, ?, ?)';
    await tenantExecute(sql, [ctx.idtenant, kodecustomer, namacustomer, alamat || '', hp || '', 'AKTIF', ctx.iduser]);
    res.status(201).json({ message: 'Customer berhasil ditambah', kodecustomer });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// PUT /customer/:id — Memperbarui data customer
exports.update = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { namacustomer, alamat, hp, status } = req.body;
    let sql = 'UPDATE customer SET namacustomer = ?, alamat = ?, hp = ?, status = ? WHERE idcustomer = ? AND idtenant = ?';
    await tenantExecute(sql, [namacustomer, alamat, hp, status || 'AKTIF', req.params.id, ctx.idtenant]);
    res.json({ message: 'Customer berhasil diupdate' });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// DELETE /customer/:id — Menghapus customer; dicegah jika sudah dipakai di transaksi jual
exports.remove = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const conn = await require('../../config/db').getConnection();
    // Validasi: cek apakah customer sudah digunakan di transaksi penjualan
    let sql = 'SELECT COUNT(*) as cnt FROM jual WHERE idcustomer = ? AND idtenant = ?';
    const [[{ cnt }]] = await conn.query(sql, [req.params.id, ctx.idtenant]);
    conn.release();
    if (cnt > 0) {
      return res.status(400).json({ message: 'Customer sudah digunakan di transaksi. Nonaktifkan saja.' });
    }
    let sql2 = 'DELETE FROM customer WHERE idcustomer = ? AND idtenant = ?';
    await tenantExecute(sql2, [req.params.id, ctx.idtenant]);
    res.json({ message: 'Customer berhasil dihapus' });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};
