const { tenantQuery, getConnection, getTenantContext } = require('../config/db');
const { generateKodePelunasanHutang } = require('../lib/kodetrans');
const logger = require('../lib/logger');

exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idsupplier, tglwal, tglakhir } = req.query;
    let sql = `SELECT ph.*, s.namasupplier FROM pelunasanhutang ph LEFT JOIN supplier s ON ph.idsupplier = s.idsupplier AND s.idtenant = ph.idtenant WHERE 1=1`;
    const params = [];
    sql += ' AND ph.idtenant = ?'; params.push(ctx.idtenant);
    sql += ' AND ph.idlokasi = ?'; params.push(ctx.idlokasi);
    if (idsupplier) { sql += ' AND ph.idsupplier = ?'; params.push(idsupplier); }
    if (tglwal) { sql += ' AND ph.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND ph.tgltrans <= ?'; params.push(tglakhir); }
    sql += ' ORDER BY ph.tgltrans DESC, ph.idpelunasan DESC';
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
      `SELECT ph.*, s.namasupplier FROM pelunasanhutang ph LEFT JOIN supplier s ON ph.idsupplier = s.idsupplier AND s.idtenant = ph.idtenant WHERE ph.idpelunasan = ? AND ph.idlokasi = ?`,
      [req.params.id, ctx.idlokasi]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Pelunasan hutang tidak ditemukan' });

    const details = await tenantQuery(
      'SELECT * FROM pelunasanhutangdtl WHERE idpelunasan = ?',
      [req.params.id]
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
    await conn.beginTransaction();
    const { idsupplier, tgltrans, total_amount, metodbayar, catatan, details } = req.body;

    if (!idsupplier) return res.status(400).json({ message: 'Supplier harus dipilih' });
    if (!details || !details.length) return res.status(400).json({ message: 'Detail pelunasan tidak boleh kosong' });

    const totalDetail = details.reduce((sum, d) => sum + parseFloat(d.amount), 0);
    if (Math.abs(totalDetail - parseFloat(total_amount)) > 0.01) {
      return res.status(400).json({ message: 'Total amount tidak sesuai dengan jumlah detail' });
    }

    const kodepelunasan = await generateKodePelunasanHutang(conn, ctx.idtenant, ctx.idlokasi);

    const [result] = await conn.query(
      'INSERT INTO pelunasanhutang (idtenant, idlokasi, idsupplier, kodepelunasan, tgltrans, total_amount, metodbayar, catatan, userentry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ctx.idtenant, ctx.idlokasi, idsupplier, kodepelunasan, tgltrans, total_amount, metodbayar || 'TUNAI', catatan || '', ctx.iduser]
    );
    const idpelunasan = result.insertId;

    for (const d of details) {
      await conn.query(
        'INSERT INTO pelunasanhutangdtl (idpelunasan, kodetrans, amount) VALUES (?, ?, ?)',
        [idpelunasan, d.kodetrans, d.amount]
      );

      await conn.query(
        'INSERT INTO kartuhutang (idtenant, idlokasi, idsupplier, kodetrans, jenis, kodetransreferensi, amount, tgltrans, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [ctx.idtenant, ctx.idlokasi, idsupplier, d.kodetrans, 'PELUNASAN', kodepelunasan, -Math.abs(d.amount), tgltrans, 'OPEN']
      );

      const [[hutang]] = await conn.query(
        "SELECT kodetrans, SUM(amount) as sisa FROM kartuhutang WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? GROUP BY kodetrans",
        [d.kodetrans, ctx.idtenant, ctx.idlokasi]
      );

      if (hutang && Math.abs(parseFloat(hutang.sisa) - Math.abs(d.amount)) < 0.01) {
        await conn.query(
          "UPDATE kartuhutang SET status = 'LUNAS' WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? AND jenis = 'BELI'",
          [d.kodetrans, ctx.idtenant, ctx.idlokasi]
        );
      }
    }

    await conn.commit();
    await logger.history('PELUNASAN_HUTANG_CREATE', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: kodepelunasan, req });
    res.status(201).json({ message: 'Pelunasan hutang berhasil ditambah', idpelunasan, kodepelunasan });
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
    const { id } = req.params;

    const [[pelunasan]] = await conn.query(
      'SELECT * FROM pelunasanhutang WHERE idpelunasan = ? AND idtenant = ? AND idlokasi = ?',
      [id, ctx.idtenant, ctx.idlokasi]
    );
    if (!pelunasan) return res.status(404).json({ message: 'Pelunasan hutang tidak ditemukan' });

    const [details] = await conn.query(
      'SELECT * FROM pelunasanhutangdtl WHERE idpelunasan = ?',
      [id]
    );

    for (const d of details) {
      await conn.query(
        "UPDATE kartuhutang SET status = 'OPEN' WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? AND jenis = 'BELI'",
        [d.kodetrans, ctx.idtenant, ctx.idlokasi]
      );

      await conn.query(
        "DELETE FROM kartuhutang WHERE kodetransreferensi = ? AND idtenant = ? AND idlokasi = ? AND jenis = 'PELUNASAN'",
        [pelunasan.kodepelunasan, ctx.idtenant, ctx.idlokasi]
      );
    }

    await conn.query('DELETE FROM pelunasanhutangdtl WHERE idpelunasan = ?', [id]);
    await conn.query('DELETE FROM pelunasanhutang WHERE idpelunasan = ? AND idtenant = ? AND idlokasi = ?', [id, ctx.idtenant, ctx.idlokasi]);

    await conn.commit();
    await logger.history('PELUNASAN_HUTANG_DELETE', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: pelunasan.kodepelunasan, req });
    res.json({ message: 'Pelunasan hutang berhasil dihapus' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};