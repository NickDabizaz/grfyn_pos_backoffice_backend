/**
 * Controller untuk pengaturan toko (nama, alamat, kontak, PPN) dan logo.
 * Endpoint: PUT /api/setting/toko, PUT /api/setting/logo
 */
const { tenantQuery, tenantExecute, getTenantContext } = require('../config/db');
const logger = require('../lib/logger');

// PUT /api/setting/toko — Memperbarui data toko (nama, alamat, HP, email, PPN)
exports.updateToko = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { namatenant, alamat, hp, email, ppn } = req.body;
    let sql = 'UPDATE tenant SET namatenant = ?, alamat = ?, hp = ?, email = ?, ppn = ? WHERE idtenant = ?';
    // PPN default 11 jika tidak dikirim
    await tenantExecute(sql, [namatenant, alamat, hp, email, (ppn !== undefined && ppn !== null) ? ppn : 11, ctx.idtenant]);
    res.json({ message: 'Setting berhasil diupdate' });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/setting/logo — Mengunggah dan memperbarui logo toko
exports.updateLogo = async (req, res) => {
  try {
    const ctx = getTenantContext();
    if (!req.file) return res.status(400).json({ message: 'File tidak ditemukan' });
    const logoPath = `/uploads/${req.file.filename}`;
    let sql = 'UPDATE tenant SET logo = ? WHERE idtenant = ?';
    await tenantExecute(sql, [logoPath, ctx.idtenant]);
    res.json({ message: 'Logo berhasil diupdate', logo: logoPath });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};
