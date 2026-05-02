const pool = require('../config/db');

exports.getAll = async (req, res) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT * FROM akun WHERE 1=1';
    const params = [];
    if (search) { sql += ' AND (namaakun LIKE ? OR kodeakun LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY idakun DESC';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM akun WHERE idakun = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Akun tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { namaakun, posisi } = req.body;

    const [[{ maxKode }]] = await conn.query('SELECT MAX(kodeakun) as maxKode FROM akun');
    let num = 1;
    if (maxKode) { const parts = maxKode.split('-'); num = parseInt(parts[1]) + 1; }
    const kodeakun = `AKN-${String(num).padStart(4, '0')}`;

    await conn.query(
      'INSERT INTO akun (kodeakun, namaakun, posisi, iduser) VALUES (?, ?, ?, ?)',
      [kodeakun, namaakun, posisi || 'DEBET', req.user.iduser]
    );

    await conn.commit();
    res.status(201).json({ message: 'Akun berhasil ditambah', kodeakun });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.update = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { namaakun, posisi, status } = req.body;
    const { id } = req.params;

    const [rows] = await conn.query('SELECT * FROM akun WHERE idakun = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Akun tidak ditemukan' });

    await conn.query(
      'UPDATE akun SET namaakun = ?, posisi = ?, status = ? WHERE idakun = ?',
      [namaakun || rows[0].namaakun, posisi || rows[0].posisi, status ?? rows[0].status, id]
    );

    await conn.commit();
    res.json({ message: 'Akun berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM akun WHERE idakun = ?', [req.params.id]);
    res.json({ message: 'Akun berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
