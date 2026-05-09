const { tenantQuery, getConnection, getTenantContext } = require('../config/db');
const { generateKodePelunasanPiutang } = require('../lib/kodetrans');
const logger = require('../lib/logger');

exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idcustomer, tglwal, tglakhir } = req.query;
    let sql = `SELECT pp.*, c.namacustomer FROM pelunasanpiutang pp LEFT JOIN customer c ON pp.idcustomer = c.idcustomer AND c.idtenant = pp.idtenant WHERE 1=1`;
    const params = [];
    sql += ' AND pp.idtenant = ?'; params.push(ctx.idtenant);
    sql += ' AND pp.idlokasi = ?'; params.push(ctx.idlokasi);
    if (idcustomer) { sql += ' AND pp.idcustomer = ?'; params.push(idcustomer); }
    if (tglwal) { sql += ' AND pp.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND pp.tgltrans <= ?'; params.push(tglakhir); }
    sql += ' ORDER BY pp.tgltrans DESC, pp.idpelunasan DESC';
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
      `SELECT pp.*, c.namacustomer FROM pelunasanpiutang pp LEFT JOIN customer c ON pp.idcustomer = c.idcustomer AND c.idtenant = pp.idtenant WHERE pp.idpelunasan = ? AND pp.idlokasi = ?`,
      [req.params.id, ctx.idlokasi]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Pelunasan piutang tidak ditemukan' });

    const details = await tenantQuery(
      'SELECT * FROM pelunasanpiutangdtl WHERE idpelunasan = ?',
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
    const { idcustomer, tgltrans, total_amount, metodbayar, catatan, details } = req.body;

    if (!idcustomer) return res.status(400).json({ message: 'Customer harus dipilih' });
    if (!details || !details.length) return res.status(400).json({ message: 'Detail pelunasan tidak boleh kosong' });

    const totalDetail = details.reduce((sum, d) => sum + parseFloat(d.amount), 0);
    if (Math.abs(totalDetail - parseFloat(total_amount)) > 0.01) {
      return res.status(400).json({ message: 'Total amount tidak sesuai dengan jumlah detail' });
    }

    const kodepelunasan = await generateKodePelunasanPiutang(conn, ctx.idtenant, ctx.idlokasi);

    const [result] = await conn.query(
      'INSERT INTO pelunasanpiutang (idtenant, idlokasi, idcustomer, kodepelunasan, tgltrans, total_amount, metodbayar, catatan, userentry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ctx.idtenant, ctx.idlokasi, idcustomer, kodepelunasan, tgltrans, total_amount, metodbayar || 'TUNAI', catatan || '', ctx.iduser]
    );
    const idpelunasan = result.insertId;

    for (const d of details) {
      await conn.query(
        'INSERT INTO pelunasanpiutangdtl (idpelunasan, kodetrans, amount) VALUES (?, ?, ?)',
        [idpelunasan, d.kodetrans, d.amount]
      );

      await conn.query(
        'INSERT INTO kartupiutang (idtenant, idlokasi, idcustomer, kodetrans, jenis, kodetransreferensi, amount, tgltrans, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [ctx.idtenant, ctx.idlokasi, idcustomer, d.kodetrans, 'PELUNASAN', kodepelunasan, -Math.abs(d.amount), tgltrans, 'OPEN']
      );

      const [[piutang]] = await conn.query(
        "SELECT kodetrans, SUM(amount) as sisa FROM kartupiutang WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? GROUP BY kodetrans",
        [d.kodetrans, ctx.idtenant, ctx.idlokasi]
      );

      if (piutang && Math.abs(parseFloat(piutang.sisa) - Math.abs(d.amount)) < 0.01) {
        await conn.query(
          "UPDATE kartupiutang SET status = 'LUNAS' WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? AND jenis = 'JUAL'",
          [d.kodetrans, ctx.idtenant, ctx.idlokasi]
        );
      }
    }

    await conn.commit();
    await logger.history('PELUNASAN_PIUTANG_CREATE', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: kodepelunasan, req });
    res.status(201).json({ message: 'Pelunasan piutang berhasil ditambah', idpelunasan, kodepelunasan });
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
      'SELECT * FROM pelunasanpiutang WHERE idpelunasan = ? AND idtenant = ? AND idlokasi = ?',
      [id, ctx.idtenant, ctx.idlokasi]
    );
    if (!pelunasan) return res.status(404).json({ message: 'Pelunasan piutang tidak ditemukan' });

    const [details] = await conn.query(
      'SELECT * FROM pelunasanpiutangdtl WHERE idpelunasan = ?',
      [id]
    );

    for (const d of details) {
      await conn.query(
        "UPDATE kartupiutang SET status = 'OPEN' WHERE kodetrans = ? AND idtenant = ? AND idlokasi = ? AND jenis = 'JUAL'",
        [d.kodetrans, ctx.idtenant, ctx.idlokasi]
      );

      await conn.query(
        "DELETE FROM kartupiutang WHERE kodetransreferensi = ? AND idtenant = ? AND idlokasi = ? AND jenis = 'PELUNASAN'",
        [pelunasan.kodepelunasan, ctx.idtenant, ctx.idlokasi]
      );
    }

    await conn.query('DELETE FROM pelunasanpiutangdtl WHERE idpelunasan = ?', [id]);
    await conn.query('DELETE FROM pelunasanpiutang WHERE idpelunasan = ? AND idtenant = ? AND idlokasi = ?', [id, ctx.idtenant, ctx.idlokasi]);

    await conn.commit();
    await logger.history('PELUNASAN_PIUTANG_DELETE', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: pelunasan.kodepelunasan, req });
    res.json({ message: 'Pelunasan piutang berhasil dihapus' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};