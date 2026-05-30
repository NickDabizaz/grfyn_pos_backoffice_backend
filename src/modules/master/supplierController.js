// Controller untuk manajemen data supplier (pemasok).
// Menangani CRUD supplier dengan pengecekan referensi transaksi sebelum penghapusan.

const { tenantQuery, tenantExecute, getTenantContext, getConnection } = require('../../config/db');
const { generateKodeMaster } = require('../../lib/kodetrans');
const logger = require('../../lib/logger');
const { isForeignKeyConstraintError } = require('../../lib/dbErrors');

// GET /supplier — Menampilkan semua supplier dengan filter pencarian opsional
exports.getAll = async (req, res) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT * FROM supplier WHERE 1=1';
    const params = [];
    // Filter opsional: pencarian berdasarkan nama/kode supplier
    if (search) { sql += ' AND (namasupplier LIKE ? OR kodesupplier LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY idsupplier ASC';
    const rows = await tenantQuery(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// POST /supplier — Membuat supplier baru dengan kode auto-generate
exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { namasupplier, alamat, hp, kodesupplier: customKode } = req.body;
    // Generate kode supplier: gunakan kustom jika ada, jika tidak auto-generate
    const kodesupplier = (customKode && customKode.trim())
      ? customKode.trim().toUpperCase()
      : await generateKodeMaster(conn, 'SUP', ctx.idtenant, 'supplier', 'kodesupplier', 4);
    let sql = 'INSERT INTO supplier (idtenant, kodesupplier, namasupplier, alamat, hp, status, userentry) VALUES (?, ?, ?, ?, ?, ?, ?)';
    await tenantExecute(sql, [ctx.idtenant, kodesupplier, namasupplier, alamat || '', hp || '', 'AKTIF', ctx.iduser]);
    res.status(201).json({ message: 'Supplier berhasil ditambah', kodesupplier });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// PUT /supplier/:id — Memperbarui data supplier
exports.update = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { namasupplier, alamat, hp, status } = req.body;
    let sql = 'UPDATE supplier SET namasupplier = ?, alamat = ?, hp = ?, status = ? WHERE idsupplier = ? AND idtenant = ?';
    await tenantExecute(sql, [namasupplier, alamat, hp, status || 'AKTIF', req.params.id, ctx.idtenant]);
    res.json({ message: 'Supplier berhasil diupdate' });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// DELETE /supplier/:id — Menghapus supplier; dicegah jika sudah dipakai di transaksi beli
exports.remove = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    // Validasi: cek apakah supplier sudah digunakan di transaksi beli
    let sql = `SELECT
      (SELECT COUNT(*) FROM beli WHERE idsupplier = ? AND idtenant = ?)
      + (SELECT COUNT(*) FROM purchaseorder WHERE idsupplier = ? AND idtenant = ?)
      + (SELECT COUNT(*) FROM returbeli WHERE idsupplier = ? AND idtenant = ?)
      + (SELECT COUNT(*) FROM kartuhutang WHERE idsupplier = ? AND idtenant = ?) as cnt`;
    const params = [req.params.id, ctx.idtenant];
    const [[{ cnt }]] = await conn.query(sql, [...params, ...params, ...params, ...params]);
    if (cnt > 0) {
      return res.status(400).json({ message: 'Supplier tidak dapat dihapus karena sudah terdapat transaksi atau referensi atas supplier tersebut. Nonaktifkan saja.' });
    }
    let sql2 = 'DELETE FROM supplier WHERE idsupplier = ? AND idtenant = ?';
    await tenantExecute(sql2, [req.params.id, ctx.idtenant]);
    res.json({ message: 'Supplier berhasil dihapus' });
  } catch (err) {
    if (isForeignKeyConstraintError(err)) {
      return res.status(400).json({ message: 'Supplier tidak dapat dihapus karena sudah terdapat transaksi atau referensi atas supplier tersebut. Nonaktifkan saja.' });
    }
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
