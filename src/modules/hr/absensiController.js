const { tenantQuery, getConnection, getTenantContext } = require('../../config/db');
const { generateKodeAbsen } = require('../../lib/kodetrans');
const logger = require('../../lib/logger');

function shouldApprove(req) {
  return req.body.approve === true || req.body.status === 'APPROVED';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function validateJenis(conn, idtenant, items) {
  const jenis = [...new Set((items || []).map((i) => String(i.jenis || '').toUpperCase()))].filter(Boolean);
  if (!jenis.length) return;
  const [rows] = await conn.query(
    "SELECT kodejenis FROM jenisabsensi WHERE idtenant = ? AND kodejenis IN (?) AND status = 'AKTIF'",
    [idtenant, jenis]
  );
  const valid = new Set(rows.map((r) => r.kodejenis));
  const invalid = jenis.filter((j) => !valid.has(j));
  if (invalid.length) {
    const err = new Error(`Jenis absensi tidak valid: ${invalid.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
}

async function assertCanModify(conn, ctx, idabsen, expectedStatuses) {
  const [[row]] = await conn.query(
    'SELECT * FROM absen WHERE idabsen = ? AND idtenant = ? FOR UPDATE',
    [idabsen, ctx.idtenant]
  );
  if (!row) {
    const err = new Error('Absensi tidak ditemukan');
    err.statusCode = 404;
    throw err;
  }
  if (!expectedStatuses.includes(row.status)) {
    const err = new Error(`Absensi status ${row.status} tidak bisa diproses`);
    err.statusCode = 400;
    throw err;
  }
  return row;
}

async function assertNotUsedInGaji(conn, ctx, idabsen) {
  const [[used]] = await conn.query(
    `SELECT g.kodegaji
     FROM gajiabsendtl gad
     JOIN gaji g ON g.idgaji = gad.idgaji AND g.idtenant = gad.idtenant
     WHERE gad.idtenant = ? AND gad.idabsen = ? AND g.status <> 'CANCELLED'
     LIMIT 1`,
    [ctx.idtenant, idabsen]
  );
  if (used) {
    const err = new Error(`Absensi sudah dipakai di gaji ${used.kodegaji}`);
    err.statusCode = 400;
    throw err;
  }
}

async function replaceDetails(conn, ctx, idabsen, idlokasi, items) {
  if (!Array.isArray(items) || !items.length) {
    const err = new Error('Detail karyawan tidak boleh kosong');
    err.statusCode = 400;
    throw err;
  }

  const ids = items.map((i) => Number(i.idkaryawan)).filter(Boolean);
  if (ids.length !== items.length) {
    const err = new Error('Setiap detail wajib memiliki karyawan');
    err.statusCode = 400;
    throw err;
  }
  if (new Set(ids).size !== ids.length) {
    const err = new Error('Karyawan tidak boleh dobel dalam satu absensi');
    err.statusCode = 400;
    throw err;
  }

  await validateJenis(conn, ctx.idtenant, items);
  const [karyawanRows] = await conn.query(
    "SELECT idkaryawan FROM karyawan WHERE idtenant = ? AND idlokasi = ? AND status = 'AKTIF' AND idkaryawan IN (?)",
    [ctx.idtenant, idlokasi, ids]
  );
  if (karyawanRows.length !== ids.length) {
    const err = new Error('Ada karyawan yang tidak aktif atau bukan di lokasi ini');
    err.statusCode = 400;
    throw err;
  }

  await conn.query('DELETE FROM absendtl WHERE idabsen = ? AND idtenant = ?', [idabsen, ctx.idtenant]);
  for (const item of items) {
    await conn.query(
      `INSERT INTO absendtl (idabsen, idtenant, idkaryawan, jenis, catatan)
       VALUES (?, ?, ?, ?, ?)`,
      [idabsen, ctx.idtenant, item.idkaryawan, String(item.jenis || 'HADIR').toUpperCase(), item.catatan || null]
    );
  }
}

exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, status, idlokasi, search } = req.query;
    let sql = `SELECT a.*, DATE_FORMAT(a.tgltrans, '%Y-%m-%d') AS tgltrans,
        l.kodelokasi, l.namalokasi, u.namauser,
        COUNT(ad.idabsendtl) AS total_karyawan
      FROM absen a
      LEFT JOIN absendtl ad ON ad.idabsen = a.idabsen AND ad.idtenant = a.idtenant
      LEFT JOIN lokasi l ON l.idlokasi = a.idlokasi AND l.idtenant = a.idtenant
      LEFT JOIN user u ON u.iduser = a.iduser AND u.idtenant = a.idtenant
      WHERE a.idtenant = ?`;
    const params = [ctx.idtenant];
    if (idlokasi) { sql += ' AND a.idlokasi = ?'; params.push(idlokasi); }
    if (tglwal) { sql += ' AND a.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND a.tgltrans <= ?'; params.push(tglakhir); }
    if (status) { sql += ' AND a.status = ?'; params.push(status); }
    if (search) { sql += ' AND (a.kodeabsen LIKE ? OR l.namalokasi LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' GROUP BY a.idabsen ORDER BY a.tgltrans DESC, a.idabsen DESC LIMIT 300';
    const rows = await tenantQuery(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await tenantQuery(
      `SELECT a.*, DATE_FORMAT(a.tgltrans, '%Y-%m-%d') AS tgltrans,
        l.kodelokasi, l.namalokasi
       FROM absen a
       LEFT JOIN lokasi l ON l.idlokasi = a.idlokasi AND l.idtenant = a.idtenant
       WHERE a.idabsen = ? AND a.idtenant = ?`,
      [req.params.id, ctx.idtenant]
    );
    if (!rows.length) return res.status(404).json({ message: 'Absensi tidak ditemukan' });

    const details = await tenantQuery(
      `SELECT ad.*, k.kodekaryawan, k.namakaryawan
       FROM absendtl ad
       LEFT JOIN karyawan k ON k.idkaryawan = ad.idkaryawan AND k.idtenant = ad.idtenant
       WHERE ad.idabsen = ? AND ad.idtenant = ?
       ORDER BY k.namakaryawan`,
      [req.params.id, ctx.idtenant]
    );
    res.json({ ...rows[0], details });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const idlokasi = Number(req.body.idlokasi || ctx.idlokasi);
    const tgltrans = req.body.tgltrans || req.body.tglabsensi || today();
    const items = req.body.items || [];
    const status = shouldApprove(req) ? 'APPROVED' : 'DRAFT';
    if (!idlokasi) return res.status(400).json({ message: 'Lokasi wajib dipilih' });

    await conn.beginTransaction();
    const [[existing]] = await conn.query(
      "SELECT kodeabsen FROM absen WHERE idtenant = ? AND idlokasi = ? AND tgltrans = ? AND status <> 'CANCELLED' FOR UPDATE",
      [ctx.idtenant, idlokasi, tgltrans]
    );
    if (existing) {
      await conn.rollback();
      return res.status(409).json({ message: `Absensi tanggal ini sudah ada (${existing.kodeabsen})` });
    }

    const kodeabsen = await generateKodeAbsen(conn, ctx.idtenant, idlokasi);
    const [header] = await conn.query(
      `INSERT INTO absen (idtenant, idlokasi, kodeabsen, tgltrans, iduser, catatan, status, userentry, tglentry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [ctx.idtenant, idlokasi, kodeabsen, tgltrans, ctx.iduser, req.body.catatan || null, status, ctx.iduser]
    );
    await replaceDetails(conn, ctx, header.insertId, idlokasi, items);
    await conn.commit();
    await logger.history('ABSEN_CREATE', { idtenant: ctx.idtenant, idlokasi, iduser: ctx.iduser, ref: kodeabsen, req });
    res.status(201).json({ message: 'Absensi berhasil disimpan', idabsen: header.insertId, kodeabsen, status });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.update = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const row = await assertCanModify(conn, ctx, req.params.id, ['DRAFT']);
    const idlokasi = Number(req.body.idlokasi || row.idlokasi);
    const tgltrans = req.body.tgltrans || row.tgltrans;
    const status = shouldApprove(req) ? 'APPROVED' : 'DRAFT';

    const [[duplicate]] = await conn.query(
      "SELECT idabsen, kodeabsen FROM absen WHERE idtenant = ? AND idlokasi = ? AND tgltrans = ? AND status <> 'CANCELLED' AND idabsen <> ? LIMIT 1",
      [ctx.idtenant, idlokasi, tgltrans, req.params.id]
    );
    if (duplicate) {
      await conn.rollback();
      return res.status(409).json({ message: `Absensi tanggal ini sudah ada (${duplicate.kodeabsen})` });
    }

    await conn.query(
      'UPDATE absen SET idlokasi = ?, tgltrans = ?, catatan = ?, status = ? WHERE idabsen = ? AND idtenant = ?',
      [idlokasi, tgltrans, req.body.catatan || null, status, req.params.id, ctx.idtenant]
    );
    await replaceDetails(conn, ctx, req.params.id, idlokasi, req.body.items || []);

    await conn.commit();
    await logger.history('ABSEN_UPDATE', { idtenant: ctx.idtenant, idlokasi, iduser: ctx.iduser, ref: row.kodeabsen, req });
    res.json({ message: 'Absensi berhasil diupdate', status });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.approve = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const row = await assertCanModify(conn, ctx, req.params.id, ['DRAFT']);
    await conn.query("UPDATE absen SET status = 'APPROVED' WHERE idabsen = ? AND idtenant = ?", [req.params.id, ctx.idtenant]);
    await conn.commit();
    await logger.history('ABSEN_APPROVE', { idtenant: ctx.idtenant, idlokasi: row.idlokasi, iduser: ctx.iduser, ref: row.kodeabsen, req });
    res.json({ message: 'Absensi berhasil diapprove' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.unapprove = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const row = await assertCanModify(conn, ctx, req.params.id, ['APPROVED']);
    await assertNotUsedInGaji(conn, ctx, req.params.id);
    await conn.query("UPDATE absen SET status = 'DRAFT' WHERE idabsen = ? AND idtenant = ?", [req.params.id, ctx.idtenant]);
    await conn.commit();
    await logger.history('ABSEN_UNAPPROVE', { idtenant: ctx.idtenant, idlokasi: row.idlokasi, iduser: ctx.iduser, ref: row.kodeabsen, req });
    res.json({ message: 'Approve absensi berhasil dibatalkan' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.cancel = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const row = await assertCanModify(conn, ctx, req.params.id, ['DRAFT', 'APPROVED']);
    await assertNotUsedInGaji(conn, ctx, req.params.id);
    await conn.query("UPDATE absen SET status = 'CANCELLED' WHERE idabsen = ? AND idtenant = ?", [req.params.id, ctx.idtenant]);
    await conn.commit();
    await logger.history('ABSEN_CANCEL', { idtenant: ctx.idtenant, idlokasi: row.idlokasi, iduser: ctx.iduser, ref: row.kodeabsen, req });
    res.json({ message: 'Absensi berhasil dibatalkan' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.rekapBulanan = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { bulan, idlokasi } = req.query;
    if (!bulan) return res.status(400).json({ message: 'Parameter bulan wajib diisi (format: YYYY-MM)' });
    const rows = await tenantQuery(
      `SELECT k.idkaryawan, k.kodekaryawan, k.namakaryawan,
         COUNT(ad.idabsendtl) AS total_hari,
         SUM(CASE WHEN ad.jenis='HADIR' THEN 1 ELSE 0 END) AS hadir,
         SUM(CASE WHEN ad.jenis='IZIN' THEN 1 ELSE 0 END) AS izin,
         SUM(CASE WHEN ad.jenis='SAKIT' THEN 1 ELSE 0 END) AS sakit,
         SUM(CASE WHEN ad.jenis='CUTI' THEN 1 ELSE 0 END) AS cuti,
         SUM(CASE WHEN ad.jenis='ALPHA' THEN 1 ELSE 0 END) AS alpha
       FROM karyawan k
       LEFT JOIN absen a ON a.idtenant = k.idtenant AND a.idlokasi = k.idlokasi
         AND DATE_FORMAT(a.tgltrans, '%Y-%m') = ? AND a.status IN ('APPROVED','CONFIRMED')
       LEFT JOIN absendtl ad ON ad.idabsen = a.idabsen AND ad.idtenant = a.idtenant
         AND ad.idkaryawan = k.idkaryawan
       WHERE k.idtenant = ? AND k.status = 'AKTIF' AND k.idlokasi = ?
       GROUP BY k.idkaryawan ORDER BY k.namakaryawan`,
      [bulan, ctx.idtenant, idlokasi || ctx.idlokasi]
    );
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};
