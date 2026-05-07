const { pool } = require('../../config/db');
const logger = require('../../lib/logger');

const QUERY_TIMEOUT = 10000;
const MAX_RESULT_ROWS = 1000;

exports.index = (req, res) => {
  res.render('layout', { view: 'db-console', 
    title: 'DB Query Console',
    active: 'db-console',
    query: '',
    result: null,
    error: null,
    rowCount: 0,
    elapsed: 0
  });
};

exports.execute = async (req, res) => {
  const { query: sqlQuery } = req.body;
  const startTime = Date.now();

  if (!sqlQuery || !sqlQuery.trim()) {
    return res.render('layout', { view: 'db-console', 
      title: 'DB Query Console',
      active: 'db-console',
      query: '',
      result: null,
      error: 'Query tidak boleh kosong',
      rowCount: 0,
      elapsed: 0
    });
  }

  const trimmed = sqlQuery.trim();
  const upperSQL = trimmed.substring(0, 100).toUpperCase();
  const isSelect = upperSQL.startsWith('SELECT') || upperSQL.startsWith('SHOW') || upperSQL.startsWith('DESCRIBE') || upperSQL.startsWith('EXPLAIN');

  try {
    let result;
    let rowCount = 0;

    if (isSelect) {
      const limitedSQL = trimmed.replace(/;/g, '');
      const [rows] = await pool.query({
        sql: `${limitedSQL} LIMIT ${MAX_RESULT_ROWS + 1}`,
        timeout: QUERY_TIMEOUT
      });

      const hasMore = rows.length > MAX_RESULT_ROWS;
      if (hasMore) rows.pop();

      result = {
        columns: rows.length > 0 ? Object.keys(rows[0]) : [],
        rows: rows,
        hasMore
      };
      rowCount = rows.length;
    } else {
      const [execResult] = await pool.query({
        sql: trimmed,
        timeout: QUERY_TIMEOUT
      });

      result = {
        affectedRows: execResult.affectedRows || 0,
        insertId: execResult.insertId || null,
        changedRows: execResult.changedRows || 0,
        message: execResult.message || 'Query executed successfully'
      };
      rowCount = execResult.affectedRows || 0;
    }

    const elapsed = Date.now() - startTime;

    await logger.history('DEV_QUERY', {
      ref: 'db_console',
      detail: {
        query: trimmed.length > 500 ? trimmed.substring(0, 500) + '...' : trimmed,
        elapsed,
        rowCount,
        isSelect
      },
      req
    });

    res.render('layout', { view: 'db-console', 
      title: 'DB Query Console',
      active: 'db-console',
      query: sqlQuery,
      result,
      error: null,
      rowCount,
      elapsed
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;

    await logger.history('DEV_QUERY_ERROR', {
      ref: 'db_console',
      detail: {
        query: trimmed.length > 500 ? trimmed.substring(0, 500) + '...' : trimmed,
        error: err.message,
        elapsed
      },
      req
    });

    res.render('layout', { view: 'db-console', 
      title: 'DB Query Console',
      active: 'db-console',
      query: sqlQuery,
      result: null,
      error: err.message,
      rowCount: 0,
      elapsed
    });
  }
};
