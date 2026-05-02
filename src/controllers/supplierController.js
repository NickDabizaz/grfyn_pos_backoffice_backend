const pool = require('../config/db');

exports.getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM supplier ORDER BY idsupplier ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { namasupplier, alamat, hp } = req.body;
    const [[{ maxKode }]] = await pool.query('SELECT MAX(kodesupplier) as maxKode FROM supplier');
    let num = 1;
    if (maxKode) { const parts = maxKode.split('-'); num = parseInt(parts[1]) + 1; }
    const kodesupplier = `SUP-${String(num).padStart(4, '0')}`;
    const [result] = await pool.query('INSERT INTO supplier (kodesupplier, namasupplier, alamat, hp) VALUES (?, ?, ?, ?)',
      [kodesupplier, namasupplier, alamat || '', hp || '']);
    res.status(201).json({ message: 'Supplier berhasil ditambah', idsupplier: result.insertId, kodesupplier });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const { namasupplier, alamat, hp } = req.body;
    await pool.query('UPDATE supplier SET namasupplier = ?, alamat = ?, hp = ? WHERE idsupplier = ?',
      [namasupplier, alamat, hp, req.params.id]);
    res.json({ message: 'Supplier berhasil diupdate' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM supplier WHERE idsupplier = ? AND kodesupplier != ?', [req.params.id, 'SUP-0001']);
    res.json({ message: 'Supplier berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
