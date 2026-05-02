const pool = require('../config/db');

exports.getAll = async (req, res) => {
  try {
    const { search, jenis } = req.query;
    let sql = `SELECT b.*,
      (SELECT hargabeli FROM hargabeli WHERE idbarang = b.idbarang ORDER BY tgltrans DESC, idhargabeli DESC LIMIT 1) as hargabeli_terbaru,
      (SELECT hargajual FROM hargajual WHERE idbarang = b.idbarang ORDER BY tgltrans DESC, idhargajual DESC LIMIT 1) as hargajual_terbaru
    FROM barang b WHERE 1=1`;
    const params = [];
    if (search) { sql += ' AND (b.namabarang LIKE ? OR b.kodebarang LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (jenis) { sql += ' AND b.jenis = ?'; params.push(jenis); }
    sql += ' ORDER BY b.idbarang DESC';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT b.*,
      (SELECT hargabeli FROM hargabeli WHERE idbarang = b.idbarang ORDER BY tgltrans DESC, idhargabeli DESC LIMIT 1) as hargabeli_terbaru,
      (SELECT hargajual FROM hargajual WHERE idbarang = b.idbarang ORDER BY tgltrans DESC, idhargajual DESC LIMIT 1) as hargajual_terbaru
    FROM barang b WHERE b.idbarang = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Barang tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { namabarang, satuanbesar, satuansedang, satuankecil, konversi1, konversi2, jenis, stokmin, hargabeli, hargajual } = req.body;

    const [[{ maxKode }]] = await conn.query('SELECT MAX(kodebarang) as maxKode FROM barang');
    let num = 1;
    if (maxKode) { const parts = maxKode.split('-'); num = parseInt(parts[1]) + 1; }
    const kodebarang = `BRG-${String(num).padStart(4, '0')}`;

    const [result] = await conn.query(
      'INSERT INTO barang (kodebarang, namabarang, satuanbesar, satuansedang, satuankecil, konversi1, konversi2, jenis, stokmin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [kodebarang, namabarang, satuanbesar, satuansedang, satuankecil, konversi1 || 0, konversi2 || 0, jenis || 'BAHAN JADI', stokmin || 0]
    );
    const idbarang = result.insertId;
    const today = new Date().toISOString().slice(0, 10);

    if (hargabeli) {
      await conn.query('INSERT INTO hargabeli (idbarang, hargabeli, tgltrans) VALUES (?, ?, ?)', [idbarang, hargabeli, today]);
    }
    if (hargajual) {
      await conn.query('INSERT INTO hargajual (idbarang, hargajual, tgltrans) VALUES (?, ?, ?)', [idbarang, hargajual, today]);
    }

    await conn.commit();
    res.status(201).json({ message: 'Barang berhasil ditambah', idbarang, kodebarang });
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
    const { namabarang, satuanbesar, satuansedang, satuankecil, konversi1, konversi2, jenis, stokmin, hargabeli, hargajual, status } = req.body;
    const { id } = req.params;

    const [barang] = await conn.query('SELECT * FROM barang WHERE idbarang = ?', [id]);
    if (barang.length === 0) return res.status(404).json({ message: 'Barang tidak ditemukan' });

    await conn.query(
      'UPDATE barang SET namabarang = ?, satuanbesar = ?, satuansedang = ?, satuankecil = ?, konversi1 = ?, konversi2 = ?, jenis = ?, stokmin = ?, status = ? WHERE idbarang = ?',
      [
        namabarang || barang[0].namabarang,
        satuanbesar ?? barang[0].satuanbesar,
        satuansedang ?? barang[0].satuansedang,
        satuankecil ?? barang[0].satuankecil,
        konversi1 ?? barang[0].konversi1,
        konversi2 ?? barang[0].konversi2,
        jenis || barang[0].jenis,
        stokmin ?? barang[0].stokmin,
        status ?? barang[0].status, id
      ]
    );

    const today = new Date().toISOString().slice(0, 10);

    if (hargabeli) {
      const [[latest]] = await conn.query('SELECT hargabeli FROM hargabeli WHERE idbarang = ? ORDER BY tgltrans DESC, idhargabeli DESC LIMIT 1', [id]);
      if (!latest || parseFloat(latest.hargabeli) !== parseFloat(hargabeli)) {
        await conn.query('INSERT INTO hargabeli (idbarang, hargabeli, tgltrans) VALUES (?, ?, ?)', [id, hargabeli, today]);
      }
    }
    if (hargajual) {
      const [[latest]] = await conn.query('SELECT hargajual FROM hargajual WHERE idbarang = ? ORDER BY tgltrans DESC, idhargajual DESC LIMIT 1', [id]);
      if (!latest || parseFloat(latest.hargajual) !== parseFloat(hargajual)) {
        await conn.query('INSERT INTO hargajual (idbarang, hargajual, tgltrans) VALUES (?, ?, ?)', [id, hargajual, today]);
      }
    }

    await conn.commit();
    res.json({ message: 'Barang berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM barang WHERE idbarang = ?', [req.params.id]);
    res.json({ message: 'Barang berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getHargaBeli = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM hargabeli WHERE idbarang = ? ORDER BY tgltrans DESC, idhargabeli DESC', [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getHargaJual = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM hargajual WHERE idbarang = ? ORDER BY tgltrans DESC, idhargajual DESC', [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.checkPrice = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT b.*,
      (SELECT hargabeli FROM hargabeli WHERE idbarang = b.idbarang ORDER BY tgltrans DESC, hargabeli desc LIMIT 1) as hargabeli,
      (SELECT hargajual FROM hargajual WHERE idbarang = b.idbarang ORDER BY tgltrans DESC, hargajual desc LIMIT 1) as hargajual
    FROM barang b WHERE b.status = 1`);
    const warnings = rows.filter(r => r.hargajual && r.hargabeli && parseFloat(r.hargajual) < parseFloat(r.hargabeli));
    res.json({ total: rows.length, warnings: warnings.length, items: warnings });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
