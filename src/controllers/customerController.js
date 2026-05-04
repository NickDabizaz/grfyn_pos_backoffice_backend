const pool = require('../config/db');

exports.getAll = async (req, res) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT * FROM customer WHERE 1=1';
    const params = [];
    if (search) { sql += ' AND (namacustomer LIKE ? OR kodecustomer LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY idcustomer ASC';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { namacustomer, alamat, hp } = req.body;
    const [[{ maxKode }]] = await pool.query('SELECT MAX(kodecustomer) as maxKode FROM customer');
    let num = 1;
    if (maxKode) { const parts = maxKode.split('-'); num = parseInt(parts[1]) + 1; }
    const kodecustomer = `CST-${String(num).padStart(4, '0')}`;
    const [result] = await pool.query('INSERT INTO customer (kodecustomer, namacustomer, alamat, hp) VALUES (?, ?, ?, ?)',
      [kodecustomer, namacustomer, alamat || '', hp || '']);
    res.status(201).json({ message: 'Customer berhasil ditambah', idcustomer: result.insertId, kodecustomer });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const { namacustomer, alamat, hp } = req.body;
    await pool.query('UPDATE customer SET namacustomer = ?, alamat = ?, hp = ? WHERE idcustomer = ?',
      [namacustomer, alamat, hp, req.params.id]);
    res.json({ message: 'Customer berhasil diupdate' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM customer WHERE idcustomer = ? AND kodecustomer != ?', [req.params.id, 'CST-0001']);
    res.json({ message: 'Customer berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
