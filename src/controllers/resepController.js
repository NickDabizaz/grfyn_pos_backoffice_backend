const pool = require('../config/db');

exports.getAll = async (req, res) => {
  try {
    const { search } = req.query;
    let sql = `SELECT r.*, b.namabarang, b.kodebarang
      FROM resep r
      JOIN barang b ON r.idbarang = b.idbarang
      WHERE 1=1`;
    const params = [];
    if (search) { sql += ' AND (b.namabarang LIKE ? OR r.koderesep LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY r.idresep DESC';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, b.namabarang, b.kodebarang
       FROM resep r
       JOIN barang b ON r.idbarang = b.idbarang
       WHERE r.idresep = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Resep tidak ditemukan' });

    const [details] = await pool.query(
      `SELECT d.*, b.namabarang, b.kodebarang, b.satuankecil
       FROM resepdtl d
       JOIN barang b ON d.idbarang = b.idbarang
       WHERE d.idresep = ?
       ORDER BY d.idresepdtl`, [req.params.id]);

    res.json({ ...rows[0], details });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { idbarang, details } = req.body;

    if (!idbarang) return res.status(400).json({ message: 'Barang jadi wajib diisi' });
    if (!details || details.length === 0) return res.status(400).json({ message: 'Detail resep wajib diisi' });

    // Generate kode
    const [[{ maxKode }]] = await conn.query('SELECT MAX(koderesep) as maxKode FROM resep');
    let num = 1;
    if (maxKode) { const parts = maxKode.split('-'); num = parseInt(parts[1]) + 1; }
    const koderesep = `RSP-${String(num).padStart(4, '0')}`;

    const [result] = await conn.query(
      'INSERT INTO resep (koderesep, idbarang) VALUES (?, ?)',
      [koderesep, idbarang]
    );
    const idresep = result.insertId;

    for (const d of details) {
      const subtotal = (parseFloat(d.jml) || 0) * (parseFloat(d.harga) || 0);
      await conn.query(
        'INSERT INTO resepdtl (idresep, koderesep, idbarang, jml, satuan, harga, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [idresep, koderesep, d.idbarang, d.jml, d.satuan || '', d.harga || 0, subtotal]
      );
    }

    await conn.commit();
    res.status(201).json({ message: 'Resep berhasil ditambah', idresep, koderesep });
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
    const { idbarang, details, status } = req.body;
    const { id } = req.params;

    const [resep] = await conn.query('SELECT * FROM resep WHERE idresep = ?', [id]);
    if (resep.length === 0) return res.status(404).json({ message: 'Resep tidak ditemukan' });

    await conn.query(
      'UPDATE resep SET idbarang = ?, status = ? WHERE idresep = ?',
      [idbarang || resep[0].idbarang, status ?? resep[0].status, id]
    );

    if (details && details.length > 0) {
      await conn.query('DELETE FROM resepdtl WHERE idresep = ?', [id]);

      for (const d of details) {
        const subtotal = (parseFloat(d.jml) || 0) * (parseFloat(d.harga) || 0);
        await conn.query(
          'INSERT INTO resepdtl (idresep, koderesep, idbarang, jml, satuan, harga, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, resep[0].koderesep, d.idbarang, d.jml, d.satuan || '', d.harga || 0, subtotal]
        );
      }
    }

    await conn.commit();
    res.json({ message: 'Resep berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM resep WHERE idresep = ?', [req.params.id]);
    res.json({ message: 'Resep berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
