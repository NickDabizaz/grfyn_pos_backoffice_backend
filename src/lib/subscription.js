const { pool } = require('../config/db');

let schemaReadyPromise = null;

const PLAN_FREE = 'FREE';
const PLAN_PRO = 'PRO';
const PAYMENT_PAID_STATUSES = new Set(['settlement', 'capture']);
const PAYMENT_FAILED_STATUSES = new Set(['deny', 'cancel', 'expire', 'failure']);

const TRANSACTION_USAGE_SOURCES = [
  { table: 'jual', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'beli', dateColumn: 'tgltrans', statusColumn: 'status' },
  {
    table: 'pelunasanpiutang',
    dateColumn: 'tgltrans',
    extraWhere: "AND COALESCE(catatan, '') NOT LIKE 'Pelunasan POS %' AND COALESCE(catatan, '') NOT LIKE 'Pelunasan Langsung Jual %' AND COALESCE(catatan, '') NOT LIKE 'Pelunasan Langsung Edit Jual %'",
  },
  {
    table: 'pelunasanhutang',
    dateColumn: 'tgltrans',
    extraWhere: "AND COALESCE(catatan, '') NOT LIKE 'Pelunasan Langsung Beli %' AND COALESCE(catatan, '') NOT LIKE 'Pelunasan Langsung Edit Beli %'",
  },
  { table: 'kas', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'returjual', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'returbeli', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'salesorder', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'purchaseorder', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'bpk', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'bpb', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'transferstok', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'stockopname', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'saldostok', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'penyesuaianstok', dateColumn: 'tgltrans', statusColumn: 'status' },
  { table: 'produksi', dateColumn: 'tgltrans', statusColumn: 'status' },
  {
    table: 'hitunghpp',
    dateExpression: "STR_TO_DATE(CONCAT(periodbulan, '-01'), '%Y-%m-%d')",
    statusColumn: 'status',
  },
  { table: 'absensi', dateColumn: 'tglabsensi' },
  {
    table: 'payroll',
    dateExpression: "STR_TO_DATE(CONCAT(periodbulan, '-01'), '%Y-%m-%d')",
    statusColumn: 'status',
  },
];

async function columnExists(conn, tableName, columnName) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(row.cnt) > 0;
}

async function addColumnIfMissing(conn, tableName, columnName, definition) {
  if (await columnExists(conn, tableName, columnName)) return;
  await conn.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${definition}`);
}

async function ensureSubscriptionSchema(conn = pool) {
  if (schemaReadyPromise && conn === pool) return schemaReadyPromise;

  const run = async () => {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS subscription_plan (
        idplan INT AUTO_INCREMENT PRIMARY KEY,
        kodeplan VARCHAR(20) NOT NULL UNIQUE,
        namaplan VARCHAR(50) NOT NULL,
        harga DECIMAL(15,2) NOT NULL DEFAULT 0,
        monthly_transaction_limit INT DEFAULT NULL,
        max_users INT DEFAULT NULL,
        has_backup TINYINT(1) NOT NULL DEFAULT 0,
        has_support TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'AKTIF',
        userentry INT NOT NULL DEFAULT 0,
        tglentry TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    await addColumnIfMissing(conn, 'tenant', 'subscription_plan', "subscription_plan VARCHAR(20) NOT NULL DEFAULT 'FREE' AFTER logo");
    await addColumnIfMissing(conn, 'tenant', 'subscription_status', "subscription_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' AFTER subscription_plan");
    await addColumnIfMissing(conn, 'tenant', 'subscription_started_at', 'subscription_started_at DATETIME DEFAULT NULL AFTER subscription_status');
    await addColumnIfMissing(conn, 'tenant', 'subscription_expires_at', 'subscription_expires_at DATETIME DEFAULT NULL AFTER subscription_started_at');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS subscription_payment (
        idpayment INT AUTO_INCREMENT PRIMARY KEY,
        idtenant INT NOT NULL,
        order_id VARCHAR(100) NOT NULL UNIQUE,
        plan_code VARCHAR(20) NOT NULL,
        amount DECIMAL(15,2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        midtrans_token VARCHAR(255) DEFAULT NULL,
        midtrans_redirect_url VARCHAR(500) DEFAULT NULL,
        midtrans_transaction_status VARCHAR(50) DEFAULT NULL,
        midtrans_payment_type VARCHAR(50) DEFAULT NULL,
        midtrans_fraud_status VARCHAR(50) DEFAULT NULL,
        paid_at DATETIME DEFAULT NULL,
        expired_at DATETIME DEFAULT NULL,
        raw_notification TEXT DEFAULT NULL,
        userentry INT NOT NULL DEFAULT 0,
        tglentry TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (idtenant) REFERENCES tenant(idtenant),
        INDEX idx_subscription_payment_tenant (idtenant),
        INDEX idx_subscription_payment_status (status)
      ) ENGINE=InnoDB
    `);

    await conn.query(
      `INSERT INTO subscription_plan
        (kodeplan, namaplan, harga, monthly_transaction_limit, max_users, has_backup, has_support, status, userentry)
       VALUES
        ('FREE', 'Free', 0, 50, 1, 0, 0, 'AKTIF', 0),
        ('PRO', 'Pro', 99000, NULL, NULL, 1, 1, 'AKTIF', 0)
       ON DUPLICATE KEY UPDATE
        namaplan = VALUES(namaplan),
        monthly_transaction_limit = VALUES(monthly_transaction_limit),
        max_users = VALUES(max_users),
        has_backup = VALUES(has_backup),
        has_support = VALUES(has_support),
        status = VALUES(status)`
    );

    await conn.query(`
      UPDATE tenant
      SET subscription_plan = COALESCE(NULLIF(subscription_plan, ''), 'FREE'),
          subscription_status = COALESCE(NULLIF(subscription_status, ''), 'ACTIVE')
    `);
  };

  if (conn === pool) {
    schemaReadyPromise = run().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
    return schemaReadyPromise;
  }
  return run();
}

async function getPlan(conn, planCode) {
  conn = conn || pool;
  await ensureSubscriptionSchema();
  const [[plan]] = await conn.query(
    'SELECT * FROM subscription_plan WHERE kodeplan = ? AND status = ? LIMIT 1',
    [planCode, 'AKTIF']
  );
  return plan || null;
}

async function getEffectiveSubscription(conn, idtenant) {
  conn = conn || pool;
  await ensureSubscriptionSchema();
  const [[tenant]] = await conn.query(
    `SELECT idtenant, subscription_plan, subscription_status,
            subscription_started_at, subscription_expires_at
     FROM tenant WHERE idtenant = ?`,
    [idtenant]
  );
  if (!tenant) {
    const err = new Error('Tenant tidak ditemukan');
    err.statusCode = 404;
    throw err;
  }

  let planCode = String(tenant.subscription_plan || PLAN_FREE).toUpperCase();
  let isActive = String(tenant.subscription_status || 'ACTIVE').toUpperCase() === 'ACTIVE';
  if (planCode === PLAN_PRO && tenant.subscription_expires_at) {
    isActive = isActive && new Date(tenant.subscription_expires_at).getTime() > Date.now();
  }
  if (planCode !== PLAN_PRO || !isActive) planCode = PLAN_FREE;

  const plan = await getPlan(conn, planCode);
  const effectivePlan = plan || await getPlan(conn, PLAN_FREE);
  return {
    tenant,
    plan: effectivePlan,
    planCode,
    isPro: planCode === PLAN_PRO,
  };
}

async function getMonthlyTransactionUsage(conn, idtenant) {
  conn = conn || pool;
  await ensureSubscriptionSchema();
  const unions = TRANSACTION_USAGE_SOURCES.map((source) => {
    const dateExpr = source.dateExpression || `\`${source.dateColumn}\``;
    const statusFilter = source.statusColumn
      ? `AND COALESCE(\`${source.statusColumn}\`, '') NOT IN ('CANCELLED', 'BATAL')`
      : '';
    return `SELECT COUNT(*) AS cnt
            FROM \`${source.table}\`
            WHERE idtenant = ?
              ${statusFilter}
              ${source.extraWhere || ''}
              AND ${dateExpr} >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
              AND ${dateExpr} < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`;
  }).join(' UNION ALL ');

  const params = TRANSACTION_USAGE_SOURCES.map(() => idtenant);
  const [[row]] = await conn.query(`SELECT COALESCE(SUM(cnt), 0) AS used FROM (${unions}) usage_rows`, params);
  return Number(row?.used || 0);
}

async function getActiveUserCount(conn, idtenant, excludeIduser = null) {
  conn = conn || pool;
  await ensureSubscriptionSchema();
  const params = [idtenant];
  let sql = "SELECT COUNT(*) AS used FROM user WHERE idtenant = ? AND status = 'AKTIF'";
  if (excludeIduser) {
    sql += ' AND iduser <> ?';
    params.push(excludeIduser);
  }
  const [[row]] = await conn.query(sql, params);
  return Number(row?.used || 0);
}

async function assertCanCreateSalesTransaction(conn, idtenant) {
  conn = conn || pool;
  const { plan, isPro } = await getEffectiveSubscription(conn, idtenant);
  if (isPro || plan.monthly_transaction_limit === null || plan.monthly_transaction_limit === undefined) return;

  const used = await getMonthlyTransactionUsage(conn, idtenant);
  const limit = Number(plan.monthly_transaction_limit || 0);
  if (limit > 0 && used >= limit) {
    const err = new Error(`Limit FREE tercapai: maksimal ${limit} transaksi per bulan. Silakan upgrade ke PRO untuk transaksi unlimited.`);
    err.statusCode = 402;
    err.code = 'SUBSCRIPTION_TRANSACTION_LIMIT';
    err.details = { plan: PLAN_FREE, used, limit };
    throw err;
  }
}

const assertCanCreateTransaction = assertCanCreateSalesTransaction;

async function assertCanApproveSalesTransaction(conn, idtenant, idjual) {
  conn = conn || pool;
  const { plan, isPro } = await getEffectiveSubscription(conn, idtenant);
  if (isPro || plan.monthly_transaction_limit === null || plan.monthly_transaction_limit === undefined) return;

  const used = await getMonthlyTransactionUsage(conn, idtenant);
  const limit = Number(plan.monthly_transaction_limit || 0);
  if (limit > 0 && used >= limit) {
    const err = new Error(`Limit FREE tercapai: maksimal ${limit} transaksi per bulan. Silakan upgrade ke PRO untuk transaksi unlimited.`);
    err.statusCode = 402;
    err.code = 'SUBSCRIPTION_TRANSACTION_LIMIT';
    err.details = { plan: PLAN_FREE, used, limit };
    throw err;
  }
}

async function assertCanHaveActiveUser(conn, idtenant, targetIduser = null) {
  conn = conn || pool;
  const { plan, isPro } = await getEffectiveSubscription(conn, idtenant);
  if (isPro || plan.max_users === null || plan.max_users === undefined) return;

  const used = await getActiveUserCount(conn, idtenant, targetIduser);
  const limit = Number(plan.max_users || 0);
  if (limit > 0 && used >= limit) {
    const err = new Error(`Limit FREE tercapai: maksimal ${limit} user aktif. Silakan upgrade ke PRO untuk menambah user.`);
    err.statusCode = 402;
    err.code = 'SUBSCRIPTION_USER_LIMIT';
    err.details = { plan: PLAN_FREE, used, limit };
    throw err;
  }
}

async function buildSubscriptionStatus(conn, idtenant) {
  const { tenant, plan, planCode, isPro } = await getEffectiveSubscription(conn, idtenant);
  const usedTransactions = await getMonthlyTransactionUsage(conn, idtenant);
  const usedUsers = await getActiveUserCount(conn, idtenant);
  const [[proPlan]] = await conn.query(
    "SELECT * FROM subscription_plan WHERE kodeplan = 'PRO' AND status = 'AKTIF' LIMIT 1"
  );
  const [payments] = await conn.query(
    `SELECT idpayment, order_id, plan_code, amount, status, midtrans_redirect_url,
            midtrans_transaction_status, paid_at, expired_at, tglentry, updated_at
     FROM subscription_payment
     WHERE idtenant = ?
     ORDER BY idpayment DESC
     LIMIT 10`,
    [idtenant]
  );

  return {
    plan: {
      code: planCode,
      name: plan?.namaplan || planCode,
      is_pro: isPro,
      price: Number(plan?.harga || 0),
      started_at: tenant.subscription_started_at,
      expires_at: tenant.subscription_expires_at,
      status: tenant.subscription_status || 'ACTIVE',
      benefits: {
        transaction_limit: plan?.monthly_transaction_limit === null ? null : Number(plan?.monthly_transaction_limit || 0),
        max_users: plan?.max_users === null ? null : Number(plan?.max_users || 0),
        backup: Number(plan?.has_backup || 0) === 1,
        support: Number(plan?.has_support || 0) === 1,
      },
    },
    pro_plan: proPlan ? {
      code: 'PRO',
      price: Number(proPlan.harga || 0),
      transaction_limit: proPlan.monthly_transaction_limit === null ? null : Number(proPlan.monthly_transaction_limit || 0),
      max_users: proPlan.max_users === null ? null : Number(proPlan.max_users || 0),
      backup: Number(proPlan.has_backup || 0) === 1,
      support: Number(proPlan.has_support || 0) === 1,
    } : null,
    usage: {
      transactions_this_month: usedTransactions,
      active_users: usedUsers,
    },
    support: isPro ? {
      url: process.env.ADMIN_SUPPORT_URL || null,
      email: process.env.ADMIN_SUPPORT_EMAIL || null,
    } : null,
    recent_payments: payments,
  };
}

function mapMidtransStatus(notification) {
  const txStatus = String(notification.transaction_status || '').toLowerCase();
  const fraud = String(notification.fraud_status || '').toLowerCase();
  if (txStatus === 'capture' && fraud && fraud !== 'accept') return 'PENDING';
  if (PAYMENT_PAID_STATUSES.has(txStatus)) return 'PAID';
  if (PAYMENT_FAILED_STATUSES.has(txStatus)) return 'FAILED';
  return 'PENDING';
}

module.exports = {
  PLAN_FREE,
  PLAN_PRO,
  ensureSubscriptionSchema,
  getEffectiveSubscription,
  getMonthlyTransactionUsage,
  getActiveUserCount,
  assertCanCreateTransaction,
  assertCanCreateSalesTransaction,
  assertCanApproveSalesTransaction,
  assertCanHaveActiveUser,
  buildSubscriptionStatus,
  mapMidtransStatus,
};
