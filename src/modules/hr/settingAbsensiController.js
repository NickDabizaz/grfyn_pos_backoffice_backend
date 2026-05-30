const { tenantQuery, getConnection, getTenantContext } = require('../../config/db');
const { seedDefaultJenisAbsensi } = require('../../migrate');
const logger = require('../../lib/logger');

function normalizeKode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
}

exports.getAll = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await seedDefaultJenisAbsensi(conn, ctx.idtenant, ctx.iduser);
    const rows = await tenantQuery(
      `SELECT * FROM jenisabsensi
       WHERE idtenant = ?
       ORDER BY FIELD(kodejenis, 'HADIR', 'IZIN', 'SAKIT', 'CUTI', 'ALPHA'), kodejenis`,
      [ctx.idtenant]
    );
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const kodejenis = normalizeKode(req.body.kodejenis);
    const namajenis = String(req.body.namajenis || kodejenis).trim().toUpperCase();
    if (!kodejenis || !namajenis) return res.status(400).json({ message: 'Kode dan nama jenis wajib diisi' });

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO jenisabsensi (idtenant, kodejenis, namajenis, potonggaji, status, userentry)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        ctx.idtenant,
        kodejenis,
        namajenis,
        req.body.potonggaji ? 1 : 0,
        String(req.body.status || 'AKTIF').toUpperCase(),
        ctx.iduser,
      ]
    );
    await conn.commit();
    res.status(201).json({ message: 'Jenis absensi berhasil ditambah', idjenisabsensi: result.insertId });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Kode jenis absensi sudah ada' });
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
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      'SELECT * FROM jenisabsensi WHERE idjenisabsensi = ? AND idtenant = ?',
      [req.params.id, ctx.idtenant]
    );
    if (!row) {
      await conn.rollback();
      return res.status(404).json({ message: 'Jenis absensi tidak ditemukan' });
    }

    const kodejenis = normalizeKode(req.body.kodejenis || row.kodejenis);
    const namajenis = String(req.body.namajenis || row.namajenis).trim().toUpperCase();
    await conn.query(
      `UPDATE jenisabsensi
       SET kodejenis = ?, namajenis = ?, potonggaji = ?, status = ?
       WHERE idjenisabsensi = ? AND idtenant = ?`,
      [
        kodejenis,
        namajenis,
        req.body.potonggaji ? 1 : 0,
        String(req.body.status || row.status).toUpperCase(),
        req.params.id,
        ctx.idtenant,
      ]
    );

    await conn.commit();
    res.json({ message: 'Jenis absensi berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Kode jenis absensi sudah ada' });
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
