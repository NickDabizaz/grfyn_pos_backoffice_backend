// Controller untuk data dashboard dan ringkasan bisnis.
// Menyediakan ringkasan penjualan harian, laba kotor, produk terlaris, stok menipis, dan data grafik.

const { tenantQuery, getTenantContext } = require('../config/db');
const logger = require('../lib/logger');

// GET /dashboard/summary — Ringkasan dashboard: total transaksi, total sales, laba kotor, top 5 produk, stok menipis
exports.summary = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const today = new Date().toISOString().slice(0, 10); // Tanggal hari ini (YYYY-MM-DD)

    // Query 1: Total transaksi dan total penjualan hari ini di lokasi aktif
    let sql = `SELECT COUNT(*) as total_transaksi, COALESCE(SUM(grandtotal), 0) as total_sales
       FROM jual WHERE tgltrans = ? AND idlokasi = ?`;
    const salesToday = await tenantQuery(sql, [today, ctx.idlokasi]);

    // Query 2: Laba kotor = SUM((harga_jual - harga_beli_terbaru) * jml)
    let sql2 = `SELECT COALESCE(SUM((jd.harga - COALESCE(
        (SELECT hb.hargabeli FROM hargabeli hb WHERE hb.idbarang = jd.idbarang AND hb.idtenant = ? ORDER BY hb.tgltrans DESC, hb.idhargabeli DESC LIMIT 1), 0
      )) * jd.jml), 0) as laba_kotor
       FROM jualdtl jd
       JOIN jual j ON jd.idjual = j.idjual AND jd.idtenant = j.idtenant
       WHERE j.tgltrans = ? AND j.idlokasi = ?`;
    const profit = await tenantQuery(sql2, [ctx.idtenant, today, ctx.idlokasi]);

    // Query 3: Top 5 produk berdasarkan jumlah terjual hari ini
    let sql3 = `SELECT b.namabarang, SUM(jd.jml) as total_jml, SUM(jd.subtotal) as total_nilai
       FROM jualdtl jd
       JOIN jual j ON jd.idjual = j.idjual AND jd.idtenant = j.idtenant
       JOIN barang b ON jd.idbarang = b.idbarang AND b.idtenant = jd.idtenant
       WHERE j.tgltrans = ? AND j.idlokasi = ?
       GROUP BY jd.idbarang, b.namabarang ORDER BY total_jml DESC LIMIT 5`;
    const topProducts = await tenantQuery(sql3, [today, ctx.idlokasi]);

    // Query 4: 5 produk dengan stok di bawah atau sama dengan stok minimum
    let sql4 = `SELECT b.idbarang, b.namabarang, b.satuankecil, b.stokmin,
        COALESCE(m.total, 0) - COALESCE(k.total, 0) as stok
       FROM barang b
       LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'M' AND idtenant = ? AND idlokasi = ? GROUP BY idbarang) m ON b.idbarang = m.idbarang
       LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'K' AND idtenant = ? AND idlokasi = ? GROUP BY idbarang) k ON b.idbarang = k.idbarang
       WHERE b.status = 'AKTIF'
       HAVING stok <= b.stokmin ORDER BY stok ASC LIMIT 5`;
    const lowStock = await tenantQuery(sql4, [ctx.idtenant, ctx.idlokasi, ctx.idtenant, ctx.idlokasi]);

    res.json({
      total_transaksi: salesToday[0]?.total_transaksi || 0,
      total_sales: salesToday[0]?.total_sales || 0,
      laba_kotor: profit[0]?.laba_kotor || 0,
      top_products: topProducts,
      low_stock: lowStock
    });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /dashboard/low-stock — Menampilkan semua produk yang stoknya di bawah atau sama dengan stok minimum
exports.lowStock = async (req, res) => {
  try {
    const ctx = getTenantContext();
    // Hitung stok = SUM(masuk) - SUM(keluar) per barang per lokasi
    let sql = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil, b.stokmin,
        COALESCE(m.total, 0) - COALESCE(k.total, 0) as stok
       FROM barang b
       LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'M' AND idtenant = ? AND idlokasi = ? GROUP BY idbarang) m ON b.idbarang = m.idbarang
       LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'K' AND idtenant = ? AND idlokasi = ? GROUP BY idbarang) k ON b.idbarang = k.idbarang
       WHERE b.status = 'AKTIF'
       HAVING stok <= b.stokmin ORDER BY stok ASC`;
    const rows = await tenantQuery(sql, [ctx.idtenant, ctx.idlokasi, ctx.idtenant, ctx.idlokasi]);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /dashboard/chart — Data grafik penjualan N hari terakhir (default 7 hari)
exports.chart = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const days = parseInt(req.query.days) || 7; // Jumlah hari, default 7
    // Grup penjualan per tanggal untuk grafik
    let sql = `SELECT tgltrans, SUM(grandtotal) as total
       FROM jual WHERE tgltrans >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND idlokasi = ?
       GROUP BY tgltrans ORDER BY tgltrans ASC`;
    const rows = await tenantQuery(sql, [days - 1, ctx.idlokasi]);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};
