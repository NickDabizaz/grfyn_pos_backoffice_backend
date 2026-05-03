const pool = require('../config/db');

function generateKode(prefix) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${date}-`;
}

exports.create = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { idcustomer, idkasir, grandtotal, bayar, kembali, items, jenis } = req.body;

    if (!items || !items.length) return res.status(400).json({ message: 'Items tidak boleh kosong' });

    // Get PPN from user, respect useppn flag
    const [[user]] = await conn.query('SELECT ppn FROM users WHERE iduser = ?', [idkasir || 1]);
    const ppnPercent = req.body.useppn === false ? 0 : (user ? parseFloat(user.ppn) : 11);

    // Generate kode
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const [[{ cnt }]] = await conn.query(`SELECT COUNT(*) as cnt FROM jual WHERE kodejual LIKE ?`, [`FJ-${dateStr}-%`]);
    const num = String(cnt + 1).padStart(4, '0');
    const kodejual = `FJ-${dateStr}-${num}`;
    const tgltrans = new Date().toISOString().slice(0, 10);

    // Insert header
    await conn.query(
      'INSERT INTO jual (kodejual, tgltrans, idcustomer, idkasir, grandtotal, bayar, kembali, jenis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [kodejual, tgltrans, idcustomer || 1, idkasir, grandtotal, bayar || 0, kembali || 0, jenis || 'POS']
    );

    const [[header]] = await conn.query('SELECT idjual FROM jual WHERE kodejual = ?', [kodejual]);

    // Insert details & kartustok
    for (const item of items) {
      const ppnAmount = (item.harga * item.jml * ppnPercent) / 100;
      const diskonAmount = item.diskon ? (item.harga * item.jml * item.diskon) / 100 : 0;
      const subtotal = (item.harga * item.jml) + ppnAmount - diskonAmount;

      await conn.query(
        'INSERT INTO jualdtl (idjual, kodejual, idbarang, jml, harga, ppn, diskon, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [header.idjual, kodejual, item.idbarang, item.jml, item.harga, ppnAmount, item.diskon || 0, subtotal]
      );

      // Kartu Stok - K (Keluar)
      await conn.query(
        'INSERT INTO kartustok (kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [kodejual, item.idbarang, item.jml, 'K', tgltrans, `Penjualan ${kodejual}`, header.idjual, 'jual']
      );
    }

    // Jurnal — KAS DEBET & PENJUALAN KREDIT
    const [[akunKas]] = await conn.query("SELECT idakun FROM akun WHERE namaakun = 'KAS' LIMIT 1");
    const [[akunJual]] = await conn.query("SELECT idakun FROM akun WHERE namaakun = 'PENJUALAN' LIMIT 1");
    if (akunKas) {
      await conn.query('INSERT INTO jurnal (idtrans, kodetrans, jenis, idakun, posisi, amount) VALUES (?, ?, ?, ?, ?, ?)',
        [header.idjual, kodejual, 'jual', akunKas.idakun, 'DEBET', grandtotal]);
    }
    if (akunJual) {
      await conn.query('INSERT INTO jurnal (idtrans, kodetrans, jenis, idakun, posisi, amount) VALUES (?, ?, ?, ?, ?, ?)',
        [header.idjual, kodejual, 'jual', akunJual.idakun, 'KREDIT', grandtotal]);
    }

    await conn.commit();
    res.status(201).json({ message: 'Transaksi berhasil', kodejual, idjual: header.idjual });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.getAll = async (req, res) => {
  try {
    const { tglwal, tglakhir, idcustomer, jenis } = req.query;
    let sql = `SELECT j.*, c.namacustomer, u.username as kasir
      FROM jual j LEFT JOIN customer c ON j.idcustomer = c.idcustomer
      LEFT JOIN users u ON j.idkasir = u.iduser WHERE 1=1`;
    const params = [];
    if (tglwal) { sql += ' AND j.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND j.tgltrans <= ?'; params.push(tglakhir); }
    if (idcustomer) { sql += ' AND j.idcustomer = ?'; params.push(idcustomer); }
    if (jenis) { sql += ' AND j.jenis = ?'; params.push(jenis); }
    sql += ' ORDER BY j.tgltrans DESC, j.idjual DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT j.*, c.namacustomer, u.username as kasir
      FROM jual j LEFT JOIN customer c ON j.idcustomer = c.idcustomer
      LEFT JOIN users u ON j.idkasir = u.iduser WHERE j.idjual = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Transaksi tidak ditemukan' });
    const [items] = await pool.query(`SELECT jd.*, b.namabarang, b.satuankecil
      FROM jualdtl jd LEFT JOIN barang b ON jd.idbarang = b.idbarang WHERE jd.idjual = ?`, [req.params.id]);
    res.json({ ...rows[0], items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.cancel = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;

    const [[jual]] = await conn.query('SELECT * FROM jual WHERE idjual = ?', [id]);
    if (!jual) return res.status(404).json({ message: 'Transaksi tidak ditemukan' });
    if (jual.status === 0) return res.status(400).json({ message: 'Transaksi sudah dibatalkan' });

    await conn.query('UPDATE jual SET status = 0 WHERE idjual = ?', [id]);

    // Nonaktifkan jurnal
    await conn.query("UPDATE jurnal SET status = 0 WHERE kodetrans = ? AND jenis = 'jual'", [jual.kodejual]);

    // Reverse kartustok: add Masuk (M) entries to cancel the Keluar (K)
    const [details] = await conn.query('SELECT * FROM jualdtl WHERE idjual = ?', [id]);
    for (const dtl of details) {
      await conn.query(
        'INSERT INTO kartustok (kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [`VOID-${jual.kodejual}`, dtl.idbarang, dtl.jml, 'M', new Date().toISOString().slice(0, 10), `Pembatalan ${jual.kodejual}`, jual.idjual, 'jual_void']
      );
    }

    await conn.commit();
    res.json({ message: 'Transaksi berhasil dibatalkan' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
