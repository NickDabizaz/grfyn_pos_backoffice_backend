const { pool } = require('../../config/db');
const logger = require('../../lib/logger');

const PREFERRED_EXPORT_ORDER = [
  'tenant',
  'subscription_payment',
  'lokasi',
  'user',
  'usermenu',
  'userlokasi',
  'config',
  'akun',
  'customer',
  'supplier',
  'barang',
  'hargabeli',
  'hargajual',
  'jurnal',
  'kas',
  'kasdtl',
  'jual',
  'jualdtl',
  'beli',
  'belidtl',
  'returbeli',
  'returbelidtl',
  'returjual',
  'returjualdtl',
  'kartustok',
  'penyesuaianstok',
  'penyesuaianstokdtl',
  'saldostok',
  'saldostokdtl',
  'hitunghpp',
  'hitunghppdtl',
  'kartupiutang',
  'pelunasanpiutang',
  'pelunasanpiutangdtl',
  'pelunasanpiutangbayar',
  'kartuhutang',
  'pelunasanhutang',
  'pelunasanhutangdtl',
  'pelunasanhutangbayar',
  'salesorder',
  'salesorderdtl',
  'bpk',
  'bpkdtl',
  'closing',
  'closingdtl',
  'transferstok',
  'transferstokdtl',
  'shift',
  'modalawal',
  'setorantunai',
  'purchaseorder',
  'purchaseorderdtl',
  'bpb',
  'bpbdtl',
  'stockopname',
  'stockopnamedtl',
  'karyawan',
  'komponengaji',
  'absensi',
  'payroll',
  'payrolldtl',
  'produksi',
  'produksidtl',
  'historyprogram',
];

const SPECIAL_TENANT_TABLES = new Set(['usermenu', 'userlokasi']);

function escapeId(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function formatSqlDate(date) {
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeSqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return `'${formatSqlDate(value)}'`;
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';

  return `'${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\0/g, '\\0')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\x1a/g, '\\Z')
    .replace(/'/g, "\\'")}'`;
}

function sortExportTables(tables) {
  const order = new Map(PREFERRED_EXPORT_ORDER.map((name, index) => [name, index]));
  return [...tables].sort((a, b) => {
    const ai = order.has(a) ? order.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b) ? order.get(b) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

async function getTenantExportTables(conn) {
  const [rows] = await conn.query(
    `SELECT t.TABLE_NAME AS table_name,
            SUM(CASE WHEN c.COLUMN_NAME = 'idtenant' THEN 1 ELSE 0 END) AS has_idtenant
     FROM information_schema.TABLES t
     LEFT JOIN information_schema.COLUMNS c
       ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
     WHERE t.TABLE_SCHEMA = DATABASE()
       AND t.TABLE_TYPE = 'BASE TABLE'
     GROUP BY t.TABLE_NAME`
  );

  const names = rows
    .filter((row) => Number(row.has_idtenant || 0) > 0 || SPECIAL_TENANT_TABLES.has(row.table_name))
    .map((row) => row.table_name);
  return sortExportTables(names);
}

async function getTableColumns(conn, tableName) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS column_name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [tableName]
  );
  return rows.map((row) => row.column_name);
}

async function getTenantRows(conn, tableName, idtenant) {
  const table = escapeId(tableName);
  if (tableName === 'usermenu') {
    const [rows] = await conn.query(
      `SELECT um.*
       FROM ${table} um
       JOIN user u ON u.iduser = um.iduser
       WHERE u.idtenant = ?
       ORDER BY um.idusermenu`,
      [idtenant]
    );
    return rows;
  }
  if (tableName === 'userlokasi') {
    const [rows] = await conn.query(
      `SELECT ul.*
       FROM ${table} ul
       JOIN user u ON u.iduser = ul.iduser
       WHERE u.idtenant = ?
       ORDER BY ul.iduserlokasi`,
      [idtenant]
    );
    return rows;
  }

  const [rows] = await conn.query(`SELECT * FROM ${table} WHERE idtenant = ?`, [idtenant]);
  return rows;
}

function buildInsertStatements(tableName, columns, rows) {
  if (!rows.length) return [`-- ${tableName}: 0 rows`];

  const columnSql = columns.map(escapeId).join(', ');
  const lines = [`-- ${tableName}: ${rows.length} rows`];
  for (const row of rows) {
    const values = columns.map((column) => escapeSqlValue(row[column])).join(', ');
    lines.push(`INSERT INTO ${escapeId(tableName)} (${columnSql}) VALUES (${values});`);
  }
  return lines;
}

exports.index = async (req, res) => {
  try {
    const [tenants] = await pool.query(
      `SELECT t.*,
        (SELECT COUNT(*) FROM user WHERE idtenant = t.idtenant) as jml_user,
        (SELECT COUNT(*) FROM lokasi WHERE idtenant = t.idtenant) as jml_lokasi,
        (SELECT COUNT(*) FROM jual WHERE idtenant = t.idtenant) as jml_jual,
        (SELECT COUNT(*) FROM beli WHERE idtenant = t.idtenant) as jml_beli,
        (SELECT MAX(tgltrans) FROM jual WHERE idtenant = t.idtenant) as last_jual,
        (SELECT MAX(tgltrans) FROM beli WHERE idtenant = t.idtenant) as last_beli
       FROM tenant t ORDER BY t.idtenant`
    );

    res.render('layout', { view: 'tenants', 
      title: 'Tenant Overview',
      active: 'tenants',
      tenants
    });
  } catch (err) {
    res.render('layout', { view: 'tenants', 
      title: 'Tenant Overview',
      active: 'tenants',
      tenants: [],
      error: err.message
    });
  }
};

exports.downloadBackup = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const idtenant = Number(req.params.idtenant);
    if (!Number.isInteger(idtenant) || idtenant <= 0) {
      return res.status(400).send('Invalid tenant id');
    }

    const [[tenant]] = await conn.query('SELECT * FROM tenant WHERE idtenant = ? LIMIT 1', [idtenant]);
    if (!tenant) return res.status(404).send('Tenant not found');

    const tables = await getTenantExportTables(conn);
    const now = new Date();
    const dateStamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const safeTenantName = String(tenant.namatenant || `tenant-${idtenant}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `tenant-${idtenant}`;

    const sql = [
      `-- Grfyn POS tenant SQL backup`,
      `-- Tenant: ${tenant.namatenant || '-'} (#${idtenant})`,
      `-- Generated at: ${now.toISOString()}`,
      `SET FOREIGN_KEY_CHECKS=0;`,
      ``,
    ];

    for (const tableName of tables) {
      const columns = await getTableColumns(conn, tableName);
      if (!columns.length) continue;
      const rows = await getTenantRows(conn, tableName, idtenant);
      sql.push(...buildInsertStatements(tableName, columns, rows), '');
    }

    sql.push('SET FOREIGN_KEY_CHECKS=1;', '');

    await logger.history('DEV_TENANT_SQL_BACKUP', {
      idtenant,
      ref: `tenant-${idtenant}`,
      detail: { tables: tables.length },
      req,
    });

    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="grfyn-${safeTenantName}-${dateStamp}.sql"`);
    res.send(sql.join('\n'));
  } catch (err) {
    logger.error(err, { req });
    res.status(500).send(err.message);
  } finally {
    conn.release();
  }
};
