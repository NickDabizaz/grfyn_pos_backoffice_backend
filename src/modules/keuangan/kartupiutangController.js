/**
 * Controller untuk kartu piutang (piutang dari customer).
 * Endpoint: GET /api/kartupiutang, GET .../summary/:idcustomer, GET .../open/:idcustomer, GET .../open-invoices/:idcustomer
 */
const { tenantQuery, getConnection, getTenantContext } = require('../../config/db');
const logger = require('../../lib/logger');

// GET /api/kartupiutang — Menampilkan semua riwayat piutang dengan filter opsional
exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idcustomer, status, tglwal, tglakhir } = req.query;
    let sql = `SELECT kp.*, c.namacustomer FROM kartupiutang kp LEFT JOIN customer c ON kp.idcustomer = c.idcustomer AND c.idtenant = kp.idtenant WHERE 1=1`;
    const params = [];
    sql += ' AND kp.idtenant = ?'; params.push(ctx.idtenant);
    sql += ' AND kp.idlokasi = ?'; params.push(ctx.idlokasi);
    if (idcustomer) { sql += ' AND kp.idcustomer = ?'; params.push(idcustomer); }
    if (status) { sql += ' AND kp.status = ?'; params.push(status); }
    if (tglwal) { sql += ' AND kp.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND kp.tgltrans <= ?'; params.push(tglakhir); }
    sql += ' ORDER BY kp.tgltrans DESC, kp.idkartupiutang DESC';
    const rows = await tenantQuery(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/kartupiutang/summary/:idcustomer — Ringkasan total piutang, retur, bayar, dan sisa per customer
exports.getSummary = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idcustomer } = req.params;
    let sql = `SELECT
        COALESCE(SUM(CASE WHEN jenis = 'JUAL' THEN amount ELSE 0 END), 0) as total_piutang,
        COALESCE(SUM(CASE WHEN jenis = 'RETUR' THEN ABS(amount) ELSE 0 END), 0) as total_retur,
        COALESCE(SUM(terbayar), 0) as total_terbayar,
        COALESCE(SUM(sisa), 0) as sisa
      FROM kartupiutang WHERE idcustomer = ? AND idlokasi = ? AND jenis = 'JUAL'`;
    const [rows] = await tenantQuery(sql, [idcustomer, ctx.idlokasi]);
    const summary = rows[0] || { total_piutang: 0, total_retur: 0, total_terbayar: 0, sisa: 0 };
    res.json(summary);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/kartupiutang/open/:idcustomer — Menampilkan invoice penjualan yang masih OPEN (belum lunas)
exports.getOpen = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idcustomer } = req.params;
    let sql2 = `SELECT kp.*, c.namacustomer FROM kartupiutang kp LEFT JOIN customer c ON kp.idcustomer = c.idcustomer AND c.idtenant = kp.idtenant WHERE kp.idcustomer = ? AND kp.status = 'OPEN' AND kp.jenis = 'JUAL' AND kp.idlokasi = ? ORDER BY kp.tgltrans ASC`;
    const rows = await tenantQuery(sql2, [idcustomer, ctx.idlokasi]);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/kartupiutang/open-invoices/:idcustomer — Mendapatkan semua invoice penjualan yang belum lunas untuk pelunasan piutang
exports.getOpenInvoices = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idcustomer } = req.params;
    let sql = `SELECT
                kp.kodetrans,
                kp.tgltrans,
                kp.idcustomer,
                c.namacustomer,
                kp.amount as original_amount,
                kp.terbayar,
                kp.sisa,
                kp.status
              FROM kartupiutang kp
              LEFT JOIN customer c ON kp.idcustomer = c.idcustomer AND c.idtenant = kp.idtenant
              WHERE kp.idcustomer = ? AND kp.idtenant = ? AND kp.idlokasi = ?
                AND kp.jenis = 'JUAL'
                AND kp.status = 'OPEN'
                AND kp.sisa > 0
              ORDER BY kp.tgltrans ASC`;
    const rows = await tenantQuery(sql, [idcustomer, ctx.idtenant, ctx.idlokasi]);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};