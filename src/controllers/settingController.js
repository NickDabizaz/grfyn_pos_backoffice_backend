const pool = require('../config/db');

exports.updateToko = async (req, res) => {
  try {
    const { namatoko, alamat, hp, email, ppn } = req.body;
    await pool.query('UPDATE users SET namatoko = ?, alamat = ?, hp = ?, email = ?, ppn = ? WHERE iduser = ?',
      [namatoko, alamat, hp, email, ppn || 11, req.user.iduser]);
    res.json({ message: 'Setting berhasil diupdate' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateLogo = async (req, res) => {
  try {
    // Logo uploaded via multer middleware
    if (!req.file) return res.status(400).json({ message: 'File tidak ditemukan' });
    const logoPath = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE users SET logo = ? WHERE iduser = ?', [logoPath, req.user.iduser]);
    res.json({ message: 'Logo berhasil diupdate', logo: logoPath });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
