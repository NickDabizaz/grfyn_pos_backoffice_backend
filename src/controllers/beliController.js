const pool = require('../config/db');

exports.create = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { idsupplier, idkasir, bayar, items } = req.body;

    if (!items || !items.length) return res.status(400).json({ message: 'Items tidak boleh kosong' });

    const [[user]] = await conn.query('SELECT ppn FROM users WHERE iduser = ?', [idkasir || 1]);
    const ppnPercent = req.body.useppn === false ? 0 : (user ? parseFloat(user.ppn) : 11);

    const dateStr     = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const [[{ cnt }]] = await conn.query(`SELECT COUNT(*) as cnt FROM beli WHERE kodebeli LIKE ?`, [`PB-${dateStr}-%`]);
    const num         = String(cnt + 1).padStart(4, '0');
    const kodebeli    = `PB-${dateStr}-${num}`;
    const tgltrans    = new Date().toISOString().slice(0, 10);

    // Insert header (grandtotal sementara 0, akan diupdate setelah hitung)
    await conn.query(
      'INSERT INTO beli (kodebeli, tgltrans, idsupplier, idkasir, grandtotal, bayar) VALUES (?, ?, ?, ?, ?, ?)',
      [kodebeli, tgltrans, idsupplier || 1, idkasir, 0, bayar || 0]
    );

    const [[header]] = await conn.query('SELECT idbeli FROM beli WHERE kodebeli = ?', [kodebeli]);

    let calculatedGrandTotal = 0;

    for (const item of items) {
      // Cek harga beli terbaru dari tabel hargabeli
      const [[latestBeli]] = await conn.query(
        'SELECT hargabeli FROM hargabeli WHERE idbarang = ? ORDER BY tgltrans DESC, idhargabeli DESC LIMIT 1',
        [item.idbarang]
      );

      // Gunakan harga terbaru dari DB, fallback ke harga dari frontend
      const harga = latestBeli ? parseFloat(latestBeli.hargabeli) : parseFloat(item.harga);

      const ppnAmount    = (harga * item.jml * ppnPercent) / 100;
      const diskonAmount = item.diskon ? (harga * item.jml * item.diskon) / 100 : 0;
      const subtotal     = (harga * item.jml) + ppnAmount - diskonAmount;
      calculatedGrandTotal += subtotal;

      await conn.query(
        'INSERT INTO belidtl (idbeli, kodebeli, idbarang, jml, harga, ppn, diskon, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [header.idbeli, kodebeli, item.idbarang, item.jml, harga, ppnAmount, item.diskon || 0, subtotal]
      );

      // Kartu Stok - M (Masuk)
      await conn.query(
        'INSERT INTO kartustok (kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [kodebeli, item.idbarang, item.jml, 'M', tgltrans, `Pembelian ${kodebeli}`, header.idbeli, 'beli']
      );

      // Update hargabeli jika harga dari frontend berbeda dengan harga terbaru di DB
      if (!latestBeli || parseFloat(latestBeli.hargabeli) !== parseFloat(item.harga)) {
        await conn.query('INSERT INTO hargabeli (idbarang, hargabeli, tgltrans) VALUES (?, ?, ?)',
          [item.idbarang, parseFloat(item.harga), tgltrans]);
      }
    }

    // Update header dengan grandtotal yang sudah dihitung ulang
    await conn.query('UPDATE beli SET grandtotal = ? WHERE idbeli = ?', [calculatedGrandTotal, header.idbeli]);

    await conn.commit();
    res.status(201).json({ message: 'Pembelian berhasil', kodebeli, idbeli: header.idbeli, grandtotal: calculatedGrandTotal });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.getAll = async (req, res) => {
  try {
    const { tglwal, tglakhir, idsupplier, search } = req.query;
    let sql = `SELECT b.*, s.namasupplier, u.username as kasir
      FROM beli b LEFT JOIN supplier s ON b.idsupplier = s.idsupplier
      LEFT JOIN users u ON b.idkasir = u.iduser WHERE 1=1`;
    const params = [];
    if (tglwal) { sql += ' AND b.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND b.tgltrans <= ?'; params.push(tglakhir); }
    if (idsupplier) { sql += ' AND b.idsupplier = ?'; params.push(idsupplier); }
    if (search) { sql += ' AND b.kodebeli LIKE ?'; params.push(`%${search}%`); }
    sql += ' ORDER BY b.tgltrans DESC, b.idbeli DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT b.*, s.namasupplier, u.username as kasir
      FROM beli b LEFT JOIN supplier s ON b.idsupplier = s.idsupplier
      LEFT JOIN users u ON b.idkasir = u.iduser WHERE b.idbeli = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Pembelian tidak ditemukan' });
    const [items] = await pool.query(`SELECT bd.*, br.namabarang, br.satuankecil
      FROM belidtl bd LEFT JOIN barang br ON bd.idbarang = br.idbarang WHERE bd.idbeli = ?`, [req.params.id]);
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

    const [[beli]] = await conn.query('SELECT * FROM beli WHERE idbeli = ?', [id]);
    if (!beli) return res.status(404).json({ message: 'Pembelian tidak ditemukan' });
    if (beli.status === 0) return res.status(400).json({ message: 'Pembelian sudah dibatalkan' });

    await conn.query('UPDATE beli SET status = 0 WHERE idbeli = ?', [id]);

    const [details] = await conn.query('SELECT * FROM belidtl WHERE idbeli = ?', [id]);
    for (const dtl of details) {
      await conn.query(
        'INSERT INTO kartustok (kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [`VOID-${beli.kodebeli}`, dtl.idbarang, dtl.jml, 'K', new Date().toISOString().slice(0, 10), `Pembatalan ${beli.kodebeli}`, beli.idbeli, 'beli_void']
      );
    }

    await conn.commit();
    res.json({ message: 'Pembelian berhasil dibatalkan' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
