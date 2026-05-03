const pool = require('../config/db');

exports.summary = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [[salesToday]] = await pool.query(
      'SELECT COUNT(*) as total_transaksi, COALESCE(SUM(grandtotal), 0) as total_sales FROM jual WHERE tgltrans = ?',
      [today]
    );

    const [[profit]] = await pool.query(
      `SELECT COALESCE(SUM((jd.harga - COALESCE(
        (SELECT hb.hargabeli FROM hargabeli hb WHERE hb.idbarang = jd.idbarang ORDER BY hb.tgltrans DESC, hb.idhargabeli DESC LIMIT 1), 0
      )) * jd.jml), 0) as laba_kotor
       FROM jualdtl jd
       JOIN jual j ON jd.idjual = j.idjual
       WHERE j.tgltrans = ?`,
      [today]
    );

    const [topProducts] = await pool.query(
      `SELECT b.namabarang, SUM(jd.jml) as total_jml, SUM(jd.subtotal) as total_nilai
       FROM jualdtl jd
       JOIN jual j ON jd.idjual = j.idjual
       JOIN barang b ON jd.idbarang = b.idbarang
       WHERE j.tgltrans = ?
       GROUP BY jd.idbarang, b.namabarang ORDER BY total_jml DESC LIMIT 5`,
      [today]
    );

    // Stok menipis
    const [lowStock] = await pool.query(
      `SELECT b.idbarang, b.namabarang, b.satuankecil, b.stokmin,
        COALESCE(m.total, 0) - COALESCE(k.total, 0) as stok
       FROM barang b
       LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'M' GROUP BY idbarang) m ON b.idbarang = m.idbarang
       LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'K' GROUP BY idbarang) k ON b.idbarang = k.idbarang
       WHERE b.status = 1
       HAVING stok <= b.stokmin ORDER BY stok ASC LIMIT 5`
    );

    res.json({
      total_transaksi: salesToday.total_transaksi,
      total_sales: salesToday.total_sales,
      laba_kotor: profit.laba_kotor,
      top_products: topProducts,
      low_stock: lowStock
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.lowStock = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil, b.stokmin,
        COALESCE(m.total, 0) - COALESCE(k.total, 0) as stok
       FROM barang b
       LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'M' GROUP BY idbarang) m ON b.idbarang = m.idbarang
       LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'K' GROUP BY idbarang) k ON b.idbarang = k.idbarang
       WHERE b.status = 1
       HAVING stok <= b.stokmin ORDER BY stok ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.chart = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const [rows] = await pool.query(
      `SELECT tgltrans, SUM(grandtotal) as total
       FROM jual WHERE tgltrans >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY tgltrans ORDER BY tgltrans ASC`,
      [days - 1]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
