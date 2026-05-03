const pool = require('../config/db');

exports.getAll = async (req, res) => {
  try {
    const { search } = req.query;
    let sql = `SELECT p.*, b.namabarang, b.kodebarang, r.koderesep as koderef,
      u.username as pembuat
      FROM produksi p
      JOIN barang b ON p.idbarang = b.idbarang
      LEFT JOIN resep r ON p.idresep = r.idresep
      LEFT JOIN users u ON p.iduser = u.iduser
      WHERE 1=1`;
    const params = [];
    if (search) { sql += ' AND (b.namabarang LIKE ? OR p.kodeproduksi LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY p.idproduksi DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, b.namabarang, b.kodebarang, b.satuankecil, r.koderesep as koderef,
        u.username as pembuat
       FROM produksi p
       JOIN barang b ON p.idbarang = b.idbarang
       LEFT JOIN resep r ON p.idresep = r.idresep
       LEFT JOIN users u ON p.iduser = u.iduser
       WHERE p.idproduksi = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Produksi tidak ditemukan' });

    const [details] = await pool.query(
      `SELECT d.*, b.namabarang, b.kodebarang, b.satuankecil
       FROM produksidtl d
       JOIN barang b ON d.idbarang = b.idbarang
       WHERE d.idproduksi = ?
       ORDER BY d.idproduksidtl`, [req.params.id]);

    res.json({ ...rows[0], details });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { idresep, idbarang, details, qtyhasil, satuanhasil, biayatk, biayaoverhead, keterangan, iduser } = req.body;

    if (!idbarang) return res.status(400).json({ message: 'Barang jadi wajib diisi' });
    if (!details || details.length === 0) return res.status(400).json({ message: 'Detail bahan baku wajib diisi' });
    if (!qtyhasil || parseFloat(qtyhasil) <= 0) return res.status(400).json({ message: 'Jumlah hasil produksi wajib diisi (>0)' });

    const tgltrans = req.body.tgltrans || new Date().toISOString().slice(0, 10);
    const dateStr = tgltrans.replace(/-/g, '');
    const [[{ cnt }]] = await conn.query('SELECT COUNT(*) as cnt FROM produksi WHERE kodeproduksi LIKE ?', [`PRD-${dateStr}-%`]);
    const num = String(cnt + 1).padStart(4, '0');
    const kodeproduksi = `PRD-${dateStr}-${num}`;

    const biayaTK = parseFloat(biayatk) || 0;
    const biayaOH = parseFloat(biayaoverhead) || 0;

    let totalBahan = 0;
    for (const d of details) {
      const subtotal = (parseFloat(d.jml) || 0) * (parseFloat(d.harga) || 0);
      totalBahan += subtotal;
      d._subtotal = subtotal;
    }

    const totalhpp = totalBahan + biayaTK + biayaOH;
    const hppperunit = parseFloat(qtyhasil) > 0 ? totalhpp / parseFloat(qtyhasil) : 0;

    const [result] = await conn.query(
      'INSERT INTO produksi (kodeproduksi, idresep, idbarang, tgltrans, qtyhasil, satuanhasil, biayatk, biayaoverhead, totalhpp, hppperunit, keterangan, iduser) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [kodeproduksi, idresep || null, idbarang, tgltrans, qtyhasil, satuanhasil || '', biayaTK, biayaOH, totalhpp, hppperunit, keterangan || '', iduser || null]
    );
    const idproduksi = result.insertId;

    for (const d of details) {
      await conn.query(
        'INSERT INTO produksidtl (idproduksi, kodeproduksi, idbarang, jml, satuan, harga, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [idproduksi, kodeproduksi, d.idbarang, d.jml, d.satuan || '', d.harga || 0, d._subtotal]
      );
    }

    // Kartu stok: keluar untuk bahan baku
    for (const d of details) {
      await conn.query(
        'INSERT INTO kartustok (kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [kodeproduksi, d.idbarang, d.jml, 'K', tgltrans, `Produksi ${kodeproduksi}`, idproduksi, 'produksi']
      );
    }

    // Kartu stok: masuk untuk barang jadi
    await conn.query(
      'INSERT INTO kartustok (kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [kodeproduksi, idbarang, qtyhasil, 'M', tgltrans, `Hasil Produksi ${kodeproduksi}`, idproduksi, 'produksi']
    );

    await conn.commit();
    res.status(201).json({ message: 'Produksi berhasil dicatat', idproduksi, kodeproduksi, totalhpp, hppperunit });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.remove = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM produksi WHERE idproduksi = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Produksi tidak ditemukan' });
    const p = rows[0];

    // Hapus kartustok terkait
    await conn.query('DELETE FROM kartustok WHERE jenisref = ? AND idref = ?', ['produksi', p.idproduksi]);
    // Hapus produksi (cascade ke produksidtl)
    await conn.query('DELETE FROM produksi WHERE idproduksi = ?', [p.idproduksi]);

    await conn.commit();
    res.json({ message: 'Produksi berhasil dihapus' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
