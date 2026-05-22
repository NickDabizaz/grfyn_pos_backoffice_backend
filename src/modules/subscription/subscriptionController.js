const crypto = require('crypto');
const { pool, getConnection, getTenantContext } = require('../../config/db');
const logger = require('../../lib/logger');
const {
  PLAN_PRO,
  buildSubscriptionStatus,
  ensureSubscriptionSchema,
  getEffectiveSubscription,
  mapMidtransStatus,
} = require('../../lib/subscription');

const MIDTRANS_SNAP_PRODUCTION_URL = 'https://app.midtrans.com/snap/v1/transactions';

async function requireOwner(ctx) {
  const [[user]] = await pool.query(
    'SELECT isowner FROM user WHERE iduser = ? AND idtenant = ? LIMIT 1',
    [ctx.iduser, ctx.idtenant]
  );
  if (!user || Number(user.isowner) !== 1) {
    const err = new Error('Hanya owner tenant yang dapat mengelola subscription');
    err.statusCode = 403;
    throw err;
  }
}

async function callMidtransSnap(payload) {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  if (!serverKey) {
    const err = new Error('MIDTRANS_SERVER_KEY belum diisi di .env backend');
    err.statusCode = 500;
    throw err;
  }

  const response = await fetch(MIDTRANS_SNAP_PRODUCTION_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error_messages?.join(', ') || data.message || 'Gagal membuat transaksi Midtrans';
    const err = new Error(message);
    err.statusCode = response.status;
    err.midtrans = data;
    throw err;
  }
  return data;
}

function verifyMidtransSignature(body) {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  if (!serverKey) return false;
  const raw = `${body.order_id || ''}${body.status_code || ''}${body.gross_amount || ''}${serverKey}`;
  const expected = crypto.createHash('sha512').update(raw).digest('hex');
  return expected === body.signature_key;
}

function oneMonthFromNowExpression() {
  return 'DATE_ADD(GREATEST(COALESCE(subscription_expires_at, NOW()), NOW()), INTERVAL 1 MONTH)';
}

exports.getStatus = async (req, res) => {
  try {
    const ctx = getTenantContext();
    await ensureSubscriptionSchema();
    res.json(await buildSubscriptionStatus(pool, ctx.idtenant));
  } catch (err) {
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  }
};

exports.checkout = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await ensureSubscriptionSchema();
    await requireOwner(ctx);

    const [[plan]] = await conn.query(
      "SELECT * FROM subscription_plan WHERE kodeplan = 'PRO' AND status = 'AKTIF' LIMIT 1"
    );
    if (!plan) return res.status(404).json({ message: 'Plan PRO tidak ditemukan' });

    const amount = Math.round(Number(plan.harga || 0));
    if (amount <= 0) return res.status(400).json({ message: 'Harga subscription PRO belum valid di database' });

    const [[tenant]] = await conn.query('SELECT namatenant, email, hp FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
    const [[owner]] = await conn.query(
      'SELECT namauser, email, hp FROM user WHERE iduser = ? AND idtenant = ?',
      [ctx.iduser, ctx.idtenant]
    );

    const orderId = `SUB-${ctx.idtenant}-${Date.now()}`;

    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO subscription_payment
        (idtenant, order_id, plan_code, amount, status, userentry)
       VALUES (?, ?, ?, ?, 'PENDING', ?)`,
      [ctx.idtenant, orderId, PLAN_PRO, amount, ctx.iduser]
    );
    await conn.commit();

    const snapPayload = {
      transaction_details: {
        order_id: orderId,
        gross_amount: amount,
      },
      item_details: [
        {
          id: 'GRFYN-POS-PRO',
          price: amount,
          quantity: 1,
          name: 'Grfyn POS PRO - 1 Bulan',
        },
      ],
      customer_details: {
        first_name: owner?.namauser || tenant?.namatenant || 'Owner',
        email: owner?.email || tenant?.email || undefined,
        phone: owner?.hp || tenant?.hp || undefined,
      },
      credit_card: {
        secure: true,
      },
      custom_field1: String(ctx.idtenant),
      custom_field2: PLAN_PRO,
    };

    if (process.env.MIDTRANS_FINISH_URL) {
      snapPayload.callbacks = { finish: process.env.MIDTRANS_FINISH_URL };
    }

    const midtrans = await callMidtransSnap(snapPayload);

    await conn.query(
      `UPDATE subscription_payment
       SET midtrans_token = ?, midtrans_redirect_url = ?
       WHERE order_id = ? AND idtenant = ?`,
      [midtrans.token || null, midtrans.redirect_url || null, orderId, ctx.idtenant]
    );

    await logger.history('SUBSCRIPTION_CHECKOUT', {
      idtenant: ctx.idtenant,
      iduser: ctx.iduser,
      ref: orderId,
      detail: { amount },
      req,
    });

    res.status(201).json({
      order_id: orderId,
      token: midtrans.token,
      redirect_url: midtrans.redirect_url,
      amount,
      mode: 'production',
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message, midtrans: err.midtrans });
  } finally {
    conn.release();
  }
};

exports.midtransNotification = async (req, res) => {
  const conn = await getConnection();
  try {
    await ensureSubscriptionSchema();
    const body = req.body || {};
    if (!body.order_id) return res.status(400).json({ message: 'order_id tidak ditemukan' });
    if (!verifyMidtransSignature(body)) {
      return res.status(403).json({ message: 'Signature Midtrans tidak valid' });
    }

    await conn.beginTransaction();
    const [[payment]] = await conn.query(
      'SELECT * FROM subscription_payment WHERE order_id = ? FOR UPDATE',
      [body.order_id]
    );
    if (!payment) {
      await conn.rollback();
      return res.status(404).json({ message: 'Payment tidak ditemukan' });
    }

    const nextStatus = mapMidtransStatus(body);
    await conn.query(
      `UPDATE subscription_payment
       SET status = ?,
           midtrans_transaction_status = ?,
           midtrans_payment_type = ?,
           midtrans_fraud_status = ?,
           paid_at = IF(? = 'PAID', COALESCE(paid_at, NOW()), paid_at),
           expired_at = IF(? = 'FAILED' AND ? = 'expire', COALESCE(expired_at, NOW()), expired_at),
           raw_notification = ?
       WHERE idpayment = ?`,
      [
        nextStatus,
        body.transaction_status || null,
        body.payment_type || null,
        body.fraud_status || null,
        nextStatus,
        nextStatus,
        String(body.transaction_status || '').toLowerCase(),
        JSON.stringify(body),
        payment.idpayment,
      ]
    );

    if (nextStatus === 'PAID' && payment.plan_code === PLAN_PRO) {
      await conn.query(
        `UPDATE tenant
         SET subscription_plan = 'PRO',
             subscription_status = 'ACTIVE',
             subscription_started_at = COALESCE(subscription_started_at, NOW()),
             subscription_expires_at = ${oneMonthFromNowExpression()}
         WHERE idtenant = ?`,
        [payment.idtenant]
      );
    }

    await conn.commit();
    await logger.history('SUBSCRIPTION_NOTIFICATION', {
      idtenant: payment.idtenant,
      ref: body.order_id,
      detail: { status: nextStatus, midtrans_status: body.transaction_status },
      req,
    });
    res.json({ message: 'OK' });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.backup = async (req, res) => {
  try {
    const ctx = getTenantContext();
    await ensureSubscriptionSchema();
    await requireOwner(ctx);

    const { isPro } = await getEffectiveSubscription(pool, ctx.idtenant);
    if (!isPro) {
      return res.status(402).json({ message: 'Backup data hanya tersedia untuk subscription PRO' });
    }

    const tenantTables = [
      'tenant', 'lokasi', 'user', 'usermenu', 'userlokasi', 'config',
      'akun', 'customer', 'supplier', 'barang', 'hargajual', 'hargabeli',
      'jual', 'jualdtl', 'beli', 'belidtl', 'kartustok', 'kartupiutang',
      'kartuhutang', 'kas', 'kasdtl', 'jurnal',
    ];

    const backup = {
      exported_at: new Date().toISOString(),
      idtenant: ctx.idtenant,
      tables: {},
    };

    for (const table of tenantTables) {
      if (table === 'user') {
        const [rows] = await pool.query(
          'SELECT iduser, idtenant, username, namauser, email, hp, isowner, tokenversion, status, userentry, tglentry FROM user WHERE idtenant = ?',
          [ctx.idtenant]
        );
        backup.tables[table] = rows;
      } else if (table === 'usermenu') {
        const [rows] = await pool.query(
          `SELECT um.*
           FROM usermenu um
           JOIN user u ON u.iduser = um.iduser
           WHERE u.idtenant = ?`,
          [ctx.idtenant]
        );
        backup.tables[table] = rows;
      } else if (table === 'userlokasi') {
        const [rows] = await pool.query(
          `SELECT ul.*
           FROM userlokasi ul
           JOIN user u ON u.iduser = ul.iduser
           WHERE u.idtenant = ?`,
          [ctx.idtenant]
        );
        backup.tables[table] = rows;
      } else {
        const [rows] = await pool.query(`SELECT * FROM \`${table}\` WHERE idtenant = ?`, [ctx.idtenant]);
        backup.tables[table] = rows;
      }
    }

    const filename = `grfyn-backup-tenant-${ctx.idtenant}-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  }
};
