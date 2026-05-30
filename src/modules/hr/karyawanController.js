const { tenantQuery, getConnection, getTenantContext } = require('../../config/db');
const { generateKodeMaster } = require('../../lib/kodetrans');
const logger = require('../../lib/logger');

function normalizeStatus(status, fallback = 'AKTIF') {
  const value = String(status || fallback).toUpperCase();
  return value === 'TIDAK AKTIF' ? 'NONAKTIF' : value;
}

exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { status, search, idlokasi } = req.query;
    let sql = `SELECT k.*, l.kodelokasi, l.namalokasi
      FROM karyawan k
      LEFT JOIN lokasi l ON l.idlokasi = k.idlokasi AND l.idtenant = k.idtenant
      WHERE k.idtenant = ?`;
    const params = [ctx.idtenant];
    if (status) { sql += ' AND k.status = ?'; params.push(normalizeStatus(status)); }
    if (idlokasi) { sql += ' AND k.idlokasi = ?'; params.push(idlokasi); }
    if (search) {
      sql += ' AND (k.namakaryawan LIKE ? OR k.kodekaryawan LIKE ? OR k.email LIKE ? OR k.hp LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY k.namakaryawan';
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
      `SELECT k.*, l.kodelokasi, l.namalokasi
       FROM karyawan k
       LEFT JOIN lokasi l ON l.idlokasi = k.idlokasi AND l.idtenant = k.idtenant
       WHERE k.idkaryawan = ? AND k.idtenant = ?`,
      [req.params.id, ctx.idtenant]
    );
    if (!rows.length) return res.status(404).json({ message: 'Karyawan tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { namakaryawan, email, hp, nohp, gaji, idlokasi } = req.body;
    if (!namakaryawan) return res.status(400).json({ message: 'Nama karyawan wajib diisi' });
    if (!idlokasi) return res.status(400).json({ message: 'Lokasi wajib dipilih' });

    const [[lokasi]] = await conn.query(
      "SELECT idlokasi FROM lokasi WHERE idtenant = ? AND idlokasi = ? AND status = 'AKTIF'",
      [ctx.idtenant, idlokasi]
    );
    if (!lokasi) return res.status(400).json({ message: 'Lokasi tidak valid atau tidak aktif' });

    await conn.beginTransaction();
    const kodekaryawan = await generateKodeMaster(conn, 'KRY', ctx.idtenant, 'karyawan', 'kodekaryawan');
    const [result] = await conn.query(
      `INSERT INTO karyawan
        (idtenant, idlokasi, kodekaryawan, namakaryawan, email, hp, gaji, status, userentry, tglentry)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'AKTIF', ?, NOW())`,
      [ctx.idtenant, idlokasi, kodekaryawan, namakaryawan, email || null, hp || nohp || null, gaji || 0, ctx.iduser]
    );
    await conn.commit();
    await logger.history('KARYAWAN_CREATE', { idtenant: ctx.idtenant, idlokasi, iduser: ctx.iduser, ref: kodekaryawan, req });
    res.status(201).json({ message: 'Karyawan berhasil ditambah', idkaryawan: result.insertId, kodekaryawan });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.update = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { namakaryawan, email, hp, nohp, gaji, idlokasi, status } = req.body;

    await conn.beginTransaction();
    const [[row]] = await conn.query(
      'SELECT * FROM karyawan WHERE idkaryawan = ? AND idtenant = ?',
      [req.params.id, ctx.idtenant]
    );
    if (!row) {
      await conn.rollback();
      return res.status(404).json({ message: 'Karyawan tidak ditemukan' });
    }
    const nextLokasi = idlokasi || row.idlokasi;
    const [[lokasi]] = await conn.query(
      "SELECT idlokasi FROM lokasi WHERE idtenant = ? AND idlokasi = ? AND status = 'AKTIF'",
      [ctx.idtenant, nextLokasi]
    );
    if (!lokasi) {
      await conn.rollback();
      return res.status(400).json({ message: 'Lokasi tidak valid atau tidak aktif' });
    }

    await conn.query(
      `UPDATE karyawan
       SET idlokasi = ?, namakaryawan = ?, email = ?, hp = ?, gaji = ?, status = ?
       WHERE idkaryawan = ? AND idtenant = ?`,
      [
        nextLokasi,
        namakaryawan || row.namakaryawan,
        email ?? row.email,
        hp ?? nohp ?? row.hp,
        gaji !== undefined ? gaji : row.gaji,
        normalizeStatus(status, row.status),
        req.params.id,
        ctx.idtenant,
      ]
    );

    await conn.commit();
    await logger.history('KARYAWAN_UPDATE', { idtenant: ctx.idtenant, idlokasi: nextLokasi, iduser: ctx.iduser, ref: row.kodekaryawan, req });
    res.json({ message: 'Karyawan berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.remove = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      'SELECT * FROM karyawan WHERE idkaryawan = ? AND idtenant = ?',
      [req.params.id, ctx.idtenant]
    );
    if (!row) {
      await conn.rollback();
      return res.status(404).json({ message: 'Karyawan tidak ditemukan' });
    }

    await conn.query('DELETE FROM karyawan WHERE idkaryawan = ? AND idtenant = ?', [req.params.id, ctx.idtenant]);
    await conn.commit();
    await logger.history('KARYAWAN_DELETE', { idtenant: ctx.idtenant, idlokasi: row.idlokasi, iduser: ctx.iduser, ref: row.kodekaryawan, req });
    res.json({ message: 'Karyawan berhasil dihapus' });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_ROW_IS_REFERENCED' || err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451) {
      return res.status(400).json({ message: 'Karyawan sudah dipakai transaksi, tidak bisa dihapus' });
    }
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
