const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
require('dotenv').config();

exports.login = async (req, res) => {
  try {
    const { username, pass } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (rows.length === 0) return res.status(401).json({ message: 'Username tidak ditemukan' });

    const user = rows[0];
    const valid = await bcrypt.compare(pass, user.pass);
    if (!valid) return res.status(401).json({ message: 'Password salah' });

    const token = jwt.sign(
      { iduser: user.iduser, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        iduser: user.iduser,
        username: user.username,
        email: user.email,
        namatoko: user.namatoko,
        alamat: user.alamat,
        hp: user.hp,
        logo: user.logo,
        ppn: user.ppn
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.me = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT iduser, username, email, namatoko, alamat, hp, logo, ppn FROM users WHERE iduser = ?', [req.user.iduser]);
    if (rows.length === 0) return res.status(404).json({ message: 'User tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { oldPass, newPass } = req.body;
    const [rows] = await pool.query('SELECT pass FROM users WHERE iduser = ?', [req.user.iduser]);
    const valid = await bcrypt.compare(oldPass, rows[0].pass);
    if (!valid) return res.status(400).json({ message: 'Password lama salah' });
    const hash = await bcrypt.hash(newPass, 10);
    await pool.query('UPDATE users SET pass = ? WHERE iduser = ?', [hash, req.user.iduser]);
    res.json({ message: 'Password berhasil diubah' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
