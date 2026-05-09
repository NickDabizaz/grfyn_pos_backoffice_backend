const { tenantQuery, getConnection, getTenantContext } = require('../config/db');
const logger = require('../lib/logger');

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

exports.getSummary = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idcustomer } = req.params;
    const [rows] = await tenantQuery(
      `SELECT 
        COALESCE(SUM(CASE WHEN jenis = 'JUAL' THEN amount ELSE 0 END), 0) as total_piutang,
        COALESCE(SUM(CASE WHEN jenis = 'RETUR' THEN ABS(amount) ELSE 0 END), 0) as total_retur,
        COALESCE(SUM(CASE WHEN jenis = 'PELUNASAN' THEN ABS(amount) ELSE 0 END), 0) as total_terbayar,
        COALESCE(SUM(amount), 0) as sisa
      FROM kartupiutang WHERE idcustomer = ? AND idlokasi = ?`,
      [idcustomer, ctx.idlokasi]
    );
    const summary = rows[0] || { total_piutang: 0, total_retur: 0, total_terbayar: 0, sisa: 0 };
    res.json(summary);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

exports.getOpen = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idcustomer } = req.params;
    const rows = await tenantQuery(
      `SELECT kp.*, c.namacustomer FROM kartupiutang kp LEFT JOIN customer c ON kp.idcustomer = c.idcustomer AND c.idtenant = kp.idtenant WHERE kp.idcustomer = ? AND kp.status = 'OPEN' AND kp.jenis = 'JUAL' AND kp.idlokasi = ? ORDER BY kp.tgltrans ASC`,
      [idcustomer, ctx.idlokasi]
    );
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};