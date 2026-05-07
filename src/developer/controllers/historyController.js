const { pool } = require('../../config/db');

exports.historyLog = async (req, res) => {
  try {
    const { tglwal, tglakhir, action, idtenant, iduser, search, page = 1 } = req.query;
    const perPage = 50;
    const currentPage = Math.max(1, parseInt(page));
    const offset = (currentPage - 1) * perPage;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (tglwal) { whereClause += ' AND DATE(h.tglentry) >= ?'; params.push(tglwal); }
    if (tglakhir) { whereClause += ' AND DATE(h.tglentry) <= ?'; params.push(tglakhir); }
    if (action) { whereClause += ' AND h.action = ?'; params.push(action); }
    if (idtenant) { whereClause += ' AND h.idtenant = ?'; params.push(parseInt(idtenant)); }
    if (iduser) { whereClause += ' AND h.iduser = ?'; params.push(parseInt(iduser)); }
    if (search) { whereClause += ' AND (h.action LIKE ? OR h.ref LIKE ? OR h.detail LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) as cnt FROM historyprogram h ${whereClause}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT h.* FROM historyprogram h ${whereClause}
       ORDER BY h.tglentry DESC LIMIT ${perPage} OFFSET ${offset}`,
      params
    );

    const totalPages = Math.ceil(cnt / perPage);

    const [actions] = await pool.query(
      'SELECT DISTINCT action FROM historyprogram ORDER BY action'
    );

    res.render('layout', { view: 'log-history', 
      title: 'Log History Program',
      active: 'logs-history',
      rows,
      currentPage,
      totalPages,
      totalRows: cnt,
      actions: actions.map(a => a.action),
      filters: { tglwal: tglwal || '', tglakhir: tglakhir || '', action: action || '', idtenant: idtenant || '', iduser: iduser || '', search: search || '' }
    });
  } catch (err) {
    res.render('layout', { view: 'log-history', 
      title: 'Log History Program',
      active: 'logs-history',
      rows: [],
      currentPage: 1,
      totalPages: 0,
      totalRows: 0,
      actions: [],
      filters: { tglwal: '', tglakhir: '', action: '', idtenant: '', iduser: '', search: '' },
      error: err.message
    });
  }
};
