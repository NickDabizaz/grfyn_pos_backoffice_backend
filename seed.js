require('dotenv').config();

const bcrypt = require('bcryptjs');
const { getConnection } = require('./src/config/db');
const { setConfigValue } = require('./src/lib/confighelper');
const {
  seedDefaultCOA,
  seedDefaultCustomer,
  seedDefaultJurnalSettings,
  seedDefaultJenisAbsensi,
} = require('./src/migrate');

const DEMO_USER = {
  username: 'demo@grfyn.id',
  password: 'pass123',
  namauser: 'Demo Public',
  email: 'demo@grfyn.id',
  hp: '080000000000',
};

const DEMO_TENANT = {
  namatenant: 'GRFYN DEMO PUBLIC',
  alamat: 'DEMO PUBLIC',
  hp: '080000000000',
  email: 'demo@grfyn.id',
  npwp: null,
  ppn: 11,
};

const DEMO_LOKASI = {
  kodelokasi: 'DEMO',
  namalokasi: 'TOKO DEMO',
  alamat: 'DEMO PUBLIC',
  hp: '080000000000',
};

async function ensureCurrency(conn) {
  await conn.query(
    `INSERT INTO currency (kodecurrency, namacurrency, simbol, kurs, status)
     VALUES ('IDR', 'Rupiah', 'Rp', 1.0000, 'AKTIF')
     ON DUPLICATE KEY UPDATE
       namacurrency = VALUES(namacurrency),
       simbol = VALUES(simbol),
       kurs = VALUES(kurs),
       status = VALUES(status)`
  );

  const [[currency]] = await conn.query(
    'SELECT idcurrency FROM currency WHERE kodecurrency = ? LIMIT 1',
    ['IDR']
  );
  return currency.idcurrency;
}

async function ensureDemoTenant(conn, idcurrency) {
  const [[existingUser]] = await conn.query(
    'SELECT idtenant FROM user WHERE username = ? LIMIT 1',
    [DEMO_USER.username]
  );

  if (existingUser) return existingUser.idtenant;

  const [result] = await conn.query(
    `INSERT INTO tenant
      (namatenant, alamat, hp, email, npwp, ppn, idcurrency, status, userentry)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'AKTIF', 0)`,
    [
      DEMO_TENANT.namatenant,
      DEMO_TENANT.alamat,
      DEMO_TENANT.hp,
      DEMO_TENANT.email,
      DEMO_TENANT.npwp,
      DEMO_TENANT.ppn,
      idcurrency,
    ]
  );

  return result.insertId;
}

async function ensureDemoLocation(conn, idtenant) {
  const [[existingDefault]] = await conn.query(
    `SELECT idlokasi
     FROM lokasi
     WHERE idtenant = ? AND (kodelokasi = ? OR isdefault = 1)
     ORDER BY isdefault DESC, idlokasi ASC
     LIMIT 1`,
    [idtenant, DEMO_LOKASI.kodelokasi]
  );

  if (existingDefault) {
    await conn.query(
      `UPDATE lokasi
       SET kodelokasi = ?, namalokasi = ?, alamat = ?, hp = ?, isdefault = 1, status = 'AKTIF'
       WHERE idlokasi = ?`,
      [
        DEMO_LOKASI.kodelokasi,
        DEMO_LOKASI.namalokasi,
        DEMO_LOKASI.alamat,
        DEMO_LOKASI.hp,
        existingDefault.idlokasi,
      ]
    );
    return existingDefault.idlokasi;
  }

  const [result] = await conn.query(
    `INSERT INTO lokasi
      (idtenant, kodelokasi, namalokasi, alamat, hp, isdefault, status, userentry)
     VALUES (?, ?, ?, ?, ?, 1, 'AKTIF', 0)`,
    [
      idtenant,
      DEMO_LOKASI.kodelokasi,
      DEMO_LOKASI.namalokasi,
      DEMO_LOKASI.alamat,
      DEMO_LOKASI.hp,
    ]
  );

  return result.insertId;
}

async function ensureDemoUser(conn, idtenant, idlokasi) {
  const hash = await bcrypt.hash(DEMO_USER.password, 10);
  const [[existingUser]] = await conn.query(
    'SELECT iduser FROM user WHERE username = ? LIMIT 1',
    [DEMO_USER.username]
  );

  if (existingUser) {
    await conn.query(
      `UPDATE user
       SET idtenant = ?, pass = ?, namauser = ?, email = ?, hp = ?, isowner = 1,
           tokenversion = tokenversion + 1, status = 'AKTIF'
       WHERE iduser = ?`,
      [
        idtenant,
        hash,
        DEMO_USER.namauser,
        DEMO_USER.email,
        DEMO_USER.hp,
        existingUser.iduser,
      ]
    );
    await conn.query('UPDATE tenant SET userentry = ? WHERE idtenant = ?', [existingUser.iduser, idtenant]);
    await conn.query('UPDATE lokasi SET userentry = ? WHERE idlokasi = ?', [existingUser.iduser, idlokasi]);
    return existingUser.iduser;
  }

  const [result] = await conn.query(
    `INSERT INTO user
      (idtenant, username, pass, namauser, email, hp, isowner, tokenversion, status, userentry)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'AKTIF', 0)`,
    [idtenant, DEMO_USER.username, hash, DEMO_USER.namauser, DEMO_USER.email, DEMO_USER.hp]
  );

  await conn.query('UPDATE tenant SET userentry = ? WHERE idtenant = ?', [result.insertId, idtenant]);
  await conn.query('UPDATE lokasi SET userentry = ? WHERE idlokasi = ?', [result.insertId, idlokasi]);
  await conn.query('UPDATE user SET userentry = ? WHERE iduser = ?', [result.insertId, result.insertId]);

  return result.insertId;
}

async function ensureAccess(conn, iduser, idlokasi) {
  await conn.query(
    `INSERT INTO userlokasi (iduser, idlokasi, status, userentry)
     VALUES (?, ?, 'AKTIF', ?)
     ON DUPLICATE KEY UPDATE status = 'AKTIF', userentry = VALUES(userentry)`,
    [iduser, idlokasi, iduser]
  );

  const [menus] = await conn.query('SELECT idmenu FROM menu');
  for (const menu of menus) {
    await conn.query(
      `INSERT INTO usermenu
        (iduser, idmenu, hakakses, tambah, ubah, approve, batalapprove, bataltransaksi, cetak, status, userentry)
       VALUES (?, ?, 1, 1, 1, 1, 1, 1, 1, 'AKTIF', ?)
       ON DUPLICATE KEY UPDATE
         hakakses = 1,
         tambah = 1,
         ubah = 1,
         approve = 1,
         batalapprove = 1,
         bataltransaksi = 1,
         cetak = 1,
         status = 'AKTIF',
         userentry = VALUES(userentry)`,
      [iduser, menu.idmenu, iduser]
    );
  }
}

async function seedDemoMasterData(conn, idtenant, iduser) {
  await seedDefaultCOA(conn, idtenant, iduser);
  await seedDefaultCustomer(conn, idtenant, iduser);
  await seedDefaultJenisAbsensi(conn, idtenant, iduser);

  await conn.query(
    `INSERT INTO customer (idtenant, kodecustomer, namacustomer, alamat, hp, status, userentry)
     VALUES (?, 'DEMO-CUST', 'CUSTOMER DEMO', 'DEMO PUBLIC', '080000000001', 'AKTIF', ?)
     ON DUPLICATE KEY UPDATE namacustomer = VALUES(namacustomer), status = 'AKTIF'`,
    [idtenant, iduser]
  );

  await conn.query(
    `INSERT INTO supplier (idtenant, kodesupplier, namasupplier, alamat, hp, status, userentry)
     VALUES (?, 'DEMO-SUP', 'SUPPLIER DEMO', 'DEMO PUBLIC', '080000000002', 'AKTIF', ?)
     ON DUPLICATE KEY UPDATE namasupplier = VALUES(namasupplier), status = 'AKTIF'`,
    [idtenant, iduser]
  );

  await conn.query(
    `INSERT INTO barang
      (idtenant, kodebarang, namabarang, satuanbesar, satuansedang, satuankecil,
       konversi1, konversi2, jenis, stokmin, status, userentry)
     VALUES
      (?, 'DEMO-001', 'BARANG DEMO 001', 'DUS', 'PACK', 'PCS', 12, 1, 'BARANG JADI', 5, 'AKTIF', ?),
      (?, 'DEMO-002', 'BARANG DEMO 002', 'DUS', 'PACK', 'PCS', 24, 1, 'BARANG JADI', 5, 'AKTIF', ?)
     ON DUPLICATE KEY UPDATE status = 'AKTIF', userentry = VALUES(userentry)`,
    [idtenant, iduser, idtenant, iduser]
  );

  const [items] = await conn.query(
    `SELECT idbarang, kodebarang
     FROM barang
     WHERE idtenant = ? AND kodebarang IN ('DEMO-001', 'DEMO-002')`,
    [idtenant]
  );

  for (const item of items) {
    const price = item.kodebarang === 'DEMO-001' ? 15000 : 25000;
    const [[existingPrice]] = await conn.query(
      `SELECT idhargajual
       FROM hargajual
       WHERE idtenant = ? AND idbarang = ? AND koderef = 'SEED-DEMO' AND jenisref = 'SEED'
       LIMIT 1`,
      [idtenant, item.idbarang]
    );

    if (existingPrice) {
      await conn.query(
        `UPDATE hargajual
         SET hargajual = ?, tgltrans = CURDATE(), status = 'AKTIF'
         WHERE idhargajual = ?`,
        [price, existingPrice.idhargajual]
      );
    } else {
      await conn.query(
        `INSERT INTO hargajual
          (idtenant, idbarang, hargajual, tgltrans, koderef, jenisref, status)
         VALUES (?, ?, ?, CURDATE(), 'SEED-DEMO', 'SEED', 'AKTIF')`,
        [idtenant, item.idbarang, price]
      );
    }
  }
}

async function seedConfig(conn, idtenant) {
  await setConfigValue(conn, idtenant, 'GLOBAL', 'CEKMINUS', 'TIDAK', 1);
  await setConfigValue(conn, idtenant, 'BARANG', 'PAKAIBAHANBAKU', 'YA', 1);
  await setConfigValue(conn, idtenant, 'GLOBAL', 'PAKAIPPN', 'YA', 1);
  await setConfigValue(conn, idtenant, 'POS', 'HARGA_INCLUDE_PPN', 'YA', 1);
  await seedDefaultJurnalSettings(conn, idtenant, { overwrite: true });
}

async function seed() {
  const conn = await getConnection();

  try {
    await conn.beginTransaction();

    const idcurrency = await ensureCurrency(conn);
    const idtenant = await ensureDemoTenant(conn, idcurrency);
    const idlokasi = await ensureDemoLocation(conn, idtenant);
    const iduser = await ensureDemoUser(conn, idtenant, idlokasi);

    await ensureAccess(conn, iduser, idlokasi);
    await seedDemoMasterData(conn, idtenant, iduser);
    await seedConfig(conn, idtenant);

    await conn.commit();

    console.log('Demo seed completed');
    console.log(`Username: ${DEMO_USER.username}`);
    console.log(`Password: ${DEMO_USER.password}`);
  } catch (err) {
    await conn.rollback();
    console.error('Demo seed failed:', err);
    process.exitCode = 1;
  } finally {
    conn.release();
  }
}

if (require.main === module) {
  seed().then(() => process.exit(process.exitCode || 0));
}

module.exports = { seed };
