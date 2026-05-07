const { pool } = require('../../config/db');

exports.index = async (req, res) => {
  try {
    const [[dbSize]] = await pool.query(
      "SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) as size_mb FROM information_schema.tables WHERE table_schema = DATABASE()"
    );

    const [tables] = await pool.query(
      "SELECT table_name, ROUND((data_length + index_length) / 1024 / 1024, 2) as size_mb, table_rows FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY (data_length + index_length) DESC"
    );

    const [poolVars] = await pool.query(
      "SHOW VARIABLES LIKE 'max_connections'"
    );

    const [poolStatus] = await pool.query(
      "SHOW STATUS WHERE Variable_name IN ('Threads_connected', 'Threads_running', 'Connections', 'Slow_queries', 'Uptime')"
    );

    const statusMap = {};
    for (const s of poolStatus) {
      statusMap[s.Variable_name] = s.Value;
    }

    const [[procCount]] = await pool.query(
      "SELECT COUNT(*) as cnt FROM information_schema.processlist"
    );

    const startTime = Date.now();
    await pool.query('SELECT 1');
    const latency = Date.now() - startTime;

    res.render('layout', { view: 'db-health', 
      title: 'Database Monitoring',
      active: 'database',
      dbSize: dbSize?.size_mb || 0,
      tables,
      poolInfo: {
        maxConnections: poolVars[0]?.Value || 0,
        threadsConnected: statusMap['Threads_connected'] || 0,
        threadsRunning: statusMap['Threads_running'] || 0,
        totalConnections: statusMap['Connections'] || 0,
        slowQueries: statusMap['Slow_queries'] || 0,
        uptime: statusMap['Uptime'] || 0,
        activeProcesses: procCount?.cnt || 0
      },
      latency
    });
  } catch (err) {
    res.render('layout', { view: 'db-health', 
      title: 'Database Monitoring',
      active: 'database',
      dbSize: 0,
      tables: [],
      poolInfo: { maxConnections: 0, threadsConnected: 0, threadsRunning: 0, totalConnections: 0, slowQueries: 0, uptime: 0, activeProcesses: 0 },
      latency: 0,
      error: err.message
    });
  }
};

exports.processList = async (req, res) => {
  try {
    const [rows] = await pool.query('SHOW FULL PROCESSLIST');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
