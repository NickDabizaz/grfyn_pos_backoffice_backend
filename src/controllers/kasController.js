const pool = require('../config/db');

exports.getAll = async (req, res) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT k.*, u.username FROM kas k JOIN users u ON k.iduser = u.iduser WHERE 1=1';
    const params = [];
    if (search) { sql += ' AND k.kodekas LIKE ?'; params.push(`%${search}%`); }
    sql += ' ORDER BY k.idkas DESC';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT k.*, u.username FROM kas k JOIN users u ON k.iduser = u.iduser WHERE k.idkas = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Kas tidak ditemukan' });

    const [details] = await pool.query(
      'SELECT kd.*, a.kodeakun, a.namaakun, a.posisi FROM kasdtl kd JOIN akun a ON kd.idakun = a.idakun WHERE kd.idkas = ?',
      [req.params.id]
    );

    res.json({ ...rows[0], details });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { details } = req.body;

    const [[{ maxKode }]] = await conn.query('SELECT MAX(kodekas) as maxKode FROM kas');
    let num = 1;
    if (maxKode) { const parts = maxKode.split('-'); num = parseInt(parts[1]) + 1; }
    const kodekas = `KAS-${String(num).padStart(4, '0')}`;

    const tgltrans = new Date().toISOString().slice(0, 10);

    const [result] = await conn.query(
      'INSERT INTO kas (kodekas, tgltrans, iduser) VALUES (?, ?, ?)',
      [kodekas, tgltrans, req.user.iduser]
    );
    const idkas = result.insertId;

    for (const d of details) {
      await conn.query(
        'INSERT INTO kasdtl (idkas, kodekas, idakun, catatan, amount) VALUES (?, ?, ?, ?, ?)',
        [idkas, kodekas, d.idakun, d.catatan || '', d.amount]
      );

      const [[akun]] = await conn.query('SELECT posisi FROM akun WHERE idakun = ?', [d.idakun]);

      await conn.query(
        'INSERT INTO jurnal (idtrans, kodetrans, jenis, idakun, posisi, amount) VALUES (?, ?, ?, ?, ?, ?)',
        [idkas, kodekas, 'kas', d.idakun, akun.posisi, d.amount]
      );
    }

    await conn.commit();
    res.status(201).json({ message: 'Kas berhasil ditambah', idkas, kodekas });
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
    const { details } = req.body;
    const { id } = req.params;

    const [rows] = await conn.query('SELECT * FROM kas WHERE idkas = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Kas tidak ditemukan' });

    await conn.query('DELETE FROM jurnal WHERE jenis = ? AND idtrans = ?', ['kas', id]);

    await conn.query('DELETE FROM kasdtl WHERE idkas = ?', [id]);

    for (const d of details) {
      await conn.query(
        'INSERT INTO kasdtl (idkas, kodekas, idakun, catatan, amount) VALUES (?, ?, ?, ?, ?)',
        [id, rows[0].kodekas, d.idakun, d.catatan || '', d.amount]
      );

      const [[akun]] = await conn.query('SELECT posisi FROM akun WHERE idakun = ?', [d.idakun]);

      await conn.query(
        'INSERT INTO jurnal (idtrans, kodetrans, jenis, idakun, posisi, amount) VALUES (?, ?, ?, ?, ?, ?)',
        [id, rows[0].kodekas, 'kas', d.idakun, akun.posisi, d.amount]
      );
    }

    await conn.commit();
    res.json({ message: 'Kas berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM jurnal WHERE jenis = ? AND idtrans = ?', ['kas', req.params.id]);
    await pool.query('DELETE FROM kas WHERE idkas = ?', [req.params.id]);
    res.json({ message: 'Kas berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
