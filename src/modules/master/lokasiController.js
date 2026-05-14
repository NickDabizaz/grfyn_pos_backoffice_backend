// Controller untuk manajemen data lokasi (gudang/toko).
// Menangani pembacaan, penambahan, dan pembaruan lokasi. Lokasi default ditampilkan paling atas.

const { tenantQuery, tenantExecute, getConnection, getTenantContext } = require('../../config/db');
const logger = require('../../lib/logger');

// GET /lokasi — Menampilkan semua lokasi aktif milik tenant, default diurutkan paling atas
exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    let sql = "SELECT * FROM lokasi WHERE idtenant = ? AND status = 'AKTIF' ORDER BY isdefault DESC, idlokasi ASC";
    const rows = await tenantQuery(sql, [ctx.idtenant]);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// POST /lokasi — Membuat lokasi baru; kode lokasi diinput manual oleh user
exports.create = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { kodelokasi, namalokasi, alamat, hp } = req.body;

    // isdefault selalu 0 untuk lokasi baru (hanya lokasi pertama saat registrasi yang default)
    let sql = "INSERT INTO lokasi (idtenant, kodelokasi, namalokasi, alamat, hp, isdefault, status, userentry) VALUES (?, ?, ?, ?, ?, 0, 'AKTIF', ?)";
    await tenantExecute(sql, [ctx.idtenant, kodelokasi, namalokasi, alamat || null, hp || null, ctx.iduser]);

    res.status(201).json({ message: 'Lokasi berhasil ditambah' });
  } catch (err) {
    // Validasi: kode lokasi duplikat
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Kode lokasi sudah digunakan' });
    }
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// PUT /lokasi/:id — Memperbarui data lokasi
exports.update = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { namalokasi, alamat, hp, status } = req.body;
    let sql = 'UPDATE lokasi SET namalokasi = ?, alamat = ?, hp = ?, status = ? WHERE idlokasi = ? AND idtenant = ?';
    await tenantExecute(sql, [namalokasi, alamat, hp, status, req.params.id, ctx.idtenant]);
    res.json({ message: 'Lokasi berhasil diupdate' });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};
