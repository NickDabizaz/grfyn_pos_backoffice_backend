/**
 * Controller untuk pengaturan toko (nama, alamat, kontak, PPN) dan logo.
 * Endpoint: PUT /api/setting/toko, PUT /api/setting/logo
 */
const { pool, tenantExecute, getTenantContext } = require('../../config/db');
const { getConfigValue, setConfigValue } = require('../../lib/confighelper');
const logger = require('../../lib/logger');

// GET /api/setting/toko - Membaca data toko dan konfigurasi global tenant
exports.getToko = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const [[tenant]] = await pool.query(
      'SELECT namatenant, alamat, hp, email, ppn, logo FROM tenant WHERE idtenant = ?',
      [ctx.idtenant]
    );

    if (!tenant) return res.status(404).json({ message: 'Tenant tidak ditemukan' });

    const cekminus = await getConfigValue(pool, ctx.idtenant, 'GLOBAL', 'CEKMINUS');
    res.json({ ...tenant, cekminus: String(cekminus || 'TIDAK').toUpperCase() });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/setting/toko — Memperbarui data toko (nama, alamat, HP, email, PPN)
exports.updateToko = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { namatenant, alamat, hp, email, ppn, cekminus } = req.body;
    let sql = 'UPDATE tenant SET namatenant = ?, alamat = ?, hp = ?, email = ?, ppn = ? WHERE idtenant = ?';
    // PPN default 11 jika tidak dikirim
    await tenantExecute(sql, [namatenant, alamat, hp, email, (ppn !== undefined && ppn !== null) ? ppn : 11, ctx.idtenant]);
    await setConfigValue(pool, ctx.idtenant, 'GLOBAL', 'CEKMINUS', cekminus === true || cekminus === 'YA' ? 'YA' : 'TIDAK', 1);
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
