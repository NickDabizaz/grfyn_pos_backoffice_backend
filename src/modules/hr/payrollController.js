const { tenantQuery, getConnection, getTenantContext } = require('../../config/db');
const { generateKodeGaji } = require('../../lib/kodetrans');
const { getDefaultAkunJurnal, postJurnal, hapusJurnal, round2 } = require('../../lib/jurnalhelper');
const logger = require('../../lib/logger');

function getPeriod(input, tahunInput) {
  let periodbulan = input;
  if (tahunInput && input) {
    periodbulan = `${tahunInput}-${String(input).padStart(2, '0')}`;
  }
  if (!periodbulan) periodbulan = new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(periodbulan)) {
    const err = new Error('Format periode harus YYYY-MM');
    err.statusCode = 400;
    throw err;
  }
  const [tahun, bulan] = periodbulan.split('-').map(Number);
  const tglawal = `${tahun}-${String(bulan).padStart(2, '0')}-01`;
  const lastDay = new Date(tahun, bulan, 0).getDate();
  const tglakhir = `${tahun}-${String(bulan).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { periodbulan, tahun, bulan, tglawal, tglakhir };
}

async function findPayrollAccounts(conn, idtenant) {
  const akun = await getDefaultAkunJurnal(conn, idtenant);
  const [[beban]] = await conn.query(
    "SELECT idakun FROM akun WHERE idtenant = ? AND status = 'AKTIF' AND (kodeakun = '5-1003' OR namaakun LIKE '%Beban Gaji%') LIMIT 1",
    [idtenant]
  );
  if (!beban?.idakun) {
    const err = new Error('Akun Beban Gaji belum tersedia');
    err.statusCode = 400;
    throw err;
  }
  if (!akun.akunKas || !akun.akunBank) {
    const err = new Error('Harap Setting Akun Default Kas dan Bank di Master Akun');
    err.statusCode = 400;
    throw err;
  }
  return { beban: beban.idakun, kas: akun.akunKas, bank: akun.akunBank };
}

async function recalcTotals(conn, ctx, idgaji) {
  const [[tot]] = await conn.query(
    `SELECT
       COALESCE(SUM(gaji), 0) AS totalgaji,
       COALESCE(SUM(bonus), 0) AS totalbonus,
       COALESCE(SUM(total), 0) AS total,
       COALESCE(SUM(bayarcash), 0) AS totalcash,
       COALESCE(SUM(bayarbank), 0) AS totalbank
     FROM gajidtl WHERE idgaji = ? AND idtenant = ?`,
    [idgaji, ctx.idtenant]
  );
  await conn.query(
    `UPDATE gaji SET totalgaji = ?, totalbonus = ?, total = ?, totalcash = ?, totalbank = ?
     WHERE idgaji = ? AND idtenant = ?`,
    [tot.totalgaji, tot.totalbonus, tot.total, tot.totalcash, tot.totalbank, idgaji, ctx.idtenant]
  );
  return tot;
}

async function getAbsenIdsForGaji(conn, ctx, idgaji) {
  const [rows] = await conn.query(
    'SELECT DISTINCT idabsen FROM gajiabsendtl WHERE idgaji = ? AND idtenant = ?',
    [idgaji, ctx.idtenant]
  );
  return rows.map((r) => r.idabsen);
}

exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { status, periodbulan, bulan, idlokasi } = req.query;
    let sql = `SELECT g.*, DATE_FORMAT(g.tglawal, '%Y-%m-%d') AS tglawal,
        DATE_FORMAT(g.tglakhir, '%Y-%m-%d') AS tglakhir,
        l.kodelokasi, l.namalokasi, u.namauser,
        COUNT(gd.idgajidtl) AS total_karyawan
      FROM gaji g
      LEFT JOIN gajidtl gd ON gd.idgaji = g.idgaji AND gd.idtenant = g.idtenant
      LEFT JOIN lokasi l ON l.idlokasi = g.idlokasi AND l.idtenant = g.idtenant
      LEFT JOIN user u ON u.iduser = g.iduser AND u.idtenant = g.idtenant
      WHERE g.idtenant = ?`;
    const params = [ctx.idtenant];
    if (idlokasi) { sql += ' AND g.idlokasi = ?'; params.push(idlokasi); }
    if (status) { sql += ' AND g.status = ?'; params.push(status); }
    if (periodbulan || bulan) { sql += ' AND g.periodbulan = ?'; params.push(periodbulan || bulan); }
    sql += ' GROUP BY g.idgaji ORDER BY g.periodbulan DESC, g.idgaji DESC LIMIT 200';
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
      `SELECT g.*, DATE_FORMAT(g.tglawal, '%Y-%m-%d') AS tglawal,
        DATE_FORMAT(g.tglakhir, '%Y-%m-%d') AS tglakhir,
        l.kodelokasi, l.namalokasi
       FROM gaji g
       LEFT JOIN lokasi l ON l.idlokasi = g.idlokasi AND l.idtenant = g.idtenant
       WHERE g.idgaji = ? AND g.idtenant = ?`,
      [req.params.id, ctx.idtenant]
    );
    if (!rows.length) return res.status(404).json({ message: 'Gaji tidak ditemukan' });

    const details = await tenantQuery(
      `SELECT gd.*, k.kodekaryawan, k.namakaryawan
       FROM gajidtl gd
       LEFT JOIN karyawan k ON k.idkaryawan = gd.idkaryawan AND k.idtenant = gd.idtenant
       WHERE gd.idgaji = ? AND gd.idtenant = ?
       ORDER BY k.namakaryawan`,
      [req.params.id, ctx.idtenant]
    );
    res.json({ ...rows[0], details });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

exports.generate = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const idlokasi = Number(req.body.idlokasi || ctx.idlokasi);
    const { periodbulan, tahun, bulan, tglawal, tglakhir } = getPeriod(req.body.periodbulan || req.body.bulanpayroll || req.body.bulan, req.body.tahun);
    if (!idlokasi) return res.status(400).json({ message: 'Lokasi wajib dipilih' });

    await conn.beginTransaction();
    const [[existing]] = await conn.query(
      "SELECT kodegaji FROM gaji WHERE idtenant = ? AND idlokasi = ? AND periodbulan = ? AND status IN ('DRAFT','APPROVED','CONFIRMED') FOR UPDATE",
      [ctx.idtenant, idlokasi, periodbulan]
    );
    if (existing) {
      await conn.rollback();
      return res.status(409).json({ message: `Gaji periode ini sudah ada (${existing.kodegaji}). Batalkan dulu jika ingin hitung ulang.` });
    }

    const kodegaji = await generateKodeGaji(conn, ctx.idtenant, idlokasi, periodbulan);
    const [header] = await conn.query(
      `INSERT INTO gaji
        (idtenant, idlokasi, kodegaji, periodbulan, bulan, tahun, tglawal, tglakhir, iduser, catatan, status, userentry, tglentry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, NOW())`,
      [ctx.idtenant, idlokasi, kodegaji, periodbulan, bulan, tahun, tglawal, tglakhir, ctx.iduser, req.body.catatan || null, ctx.iduser]
    );
    const idgaji = header.insertId;

    const [karyawan] = await conn.query(
      "SELECT * FROM karyawan WHERE idtenant = ? AND idlokasi = ? AND status = 'AKTIF' ORDER BY namakaryawan",
      [ctx.idtenant, idlokasi]
    );
    let inserted = 0;

    for (const kar of karyawan) {
      const [absensi] = await conn.query(
        `SELECT ad.idabsendtl, ad.idabsen, ad.jenis, COALESCE(ja.potonggaji, 0) AS potonggaji
         FROM absendtl ad
         JOIN absen a ON a.idabsen = ad.idabsen AND a.idtenant = ad.idtenant
         LEFT JOIN jenisabsensi ja ON ja.idtenant = ad.idtenant AND ja.kodejenis = ad.jenis
         WHERE ad.idtenant = ? AND ad.idkaryawan = ? AND a.idlokasi = ?
           AND a.tgltrans BETWEEN ? AND ? AND a.status = 'APPROVED'
         ORDER BY a.tgltrans, ad.idabsendtl`,
        [ctx.idtenant, kar.idkaryawan, idlokasi, tglawal, tglakhir]
      );
      const totalabsen = absensi.length;
      if (!totalabsen) continue;

      const totalpotongabsen = absensi.filter((a) => Number(a.potonggaji) === 1).length;
      const gajimaster = round2(kar.gaji);
      const gajiharian = round2(gajimaster / totalabsen);
      const potonganabsen = round2(gajiharian * totalpotongabsen);
      const nilaiGaji = Math.max(round2(gajimaster - potonganabsen), 0);

      const [detail] = await conn.query(
        `INSERT INTO gajidtl
          (idgaji, idtenant, idkaryawan, gajimaster, totalabsen, totalpotongabsen,
           gajiharian, potonganabsen, gaji, bonus, total, bayarcash, bayarbank, catatan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, NULL)`,
        [idgaji, ctx.idtenant, kar.idkaryawan, gajimaster, totalabsen, totalpotongabsen, gajiharian, potonganabsen, nilaiGaji, nilaiGaji, nilaiGaji]
      );

      for (const ab of absensi) {
        await conn.query(
          `INSERT INTO gajiabsendtl (idgaji, idgajidtl, idtenant, idabsen, idabsendtl)
           VALUES (?, ?, ?, ?, ?)`,
          [idgaji, detail.insertId, ctx.idtenant, ab.idabsen, ab.idabsendtl]
        );
      }
      inserted++;
    }

    if (!inserted) {
      await conn.rollback();
      return res.status(400).json({ message: 'Tidak ada absensi APPROVED untuk periode dan lokasi ini' });
    }

    const totals = await recalcTotals(conn, ctx, idgaji);
    await conn.commit();
    await logger.history('GAJI_GENERATE', { idtenant: ctx.idtenant, idlokasi, iduser: ctx.iduser, ref: kodegaji, req });
    res.status(201).json({ message: 'Gaji berhasil digenerate', idgaji, kodegaji, ...totals });
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
    const [[gaji]] = await conn.query(
      'SELECT * FROM gaji WHERE idgaji = ? AND idtenant = ? FOR UPDATE',
      [req.params.id, ctx.idtenant]
    );
    if (!gaji) {
      await conn.rollback();
      return res.status(404).json({ message: 'Gaji tidak ditemukan' });
    }
    if (gaji.status !== 'DRAFT') {
      await conn.rollback();
      return res.status(400).json({ message: 'Hanya gaji DRAFT yang bisa diedit' });
    }

    const details = Array.isArray(req.body.details) ? req.body.details : [];
    for (const item of details) {
      const [[row]] = await conn.query(
        'SELECT * FROM gajidtl WHERE idgajidtl = ? AND idgaji = ? AND idtenant = ?',
        [item.idgajidtl, req.params.id, ctx.idtenant]
      );
      if (!row) continue;
      const bonus = round2(item.bonus ?? row.bonus);
      const total = round2(Number(row.gaji) + bonus);
      const bayarcash = round2(item.bayarcash ?? total);
      const bayarbank = round2(item.bayarbank ?? 0);
      if (Math.abs(round2(bayarcash + bayarbank) - total) > 0.01) {
        await conn.rollback();
        return res.status(400).json({ message: `Split pembayaran ${row.idgajidtl} tidak sama dengan total gaji` });
      }
      await conn.query(
        `UPDATE gajidtl
         SET bonus = ?, total = ?, bayarcash = ?, bayarbank = ?, catatan = ?
         WHERE idgajidtl = ? AND idtenant = ?`,
        [bonus, total, bayarcash, bayarbank, item.catatan ?? row.catatan, item.idgajidtl, ctx.idtenant]
      );
    }

    const totals = await recalcTotals(conn, ctx, req.params.id);
    await conn.query('UPDATE gaji SET catatan = ? WHERE idgaji = ? AND idtenant = ?', [req.body.catatan ?? gaji.catatan, req.params.id, ctx.idtenant]);
    await conn.commit();
    res.json({ message: 'Gaji berhasil diupdate', ...totals });
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
    const [[gaji]] = await conn.query(
      'SELECT * FROM gaji WHERE idgaji = ? AND idtenant = ? FOR UPDATE',
      [req.params.id, ctx.idtenant]
    );
    if (!gaji) {
      await conn.rollback();
      return res.status(404).json({ message: 'Gaji tidak ditemukan' });
    }
    if (gaji.status !== 'DRAFT') {
      await conn.rollback();
      return res.status(400).json({ message: 'Hanya gaji DRAFT yang bisa diapprove' });
    }

    const totals = await recalcTotals(conn, ctx, req.params.id);
    const total = round2(totals.total);
    const cash = round2(totals.totalcash);
    const bank = round2(totals.totalbank);
    if (Math.abs(round2(cash + bank) - total) > 0.01) {
      await conn.rollback();
      return res.status(400).json({ message: 'Total cash + bank tidak sama dengan total gaji' });
    }

    const akun = await findPayrollAccounts(conn, ctx.idtenant);
    await postJurnal(conn, {
      idtenant: ctx.idtenant,
      idlokasi: gaji.idlokasi,
      idtrans: gaji.idgaji,
      kodetrans: gaji.kodegaji,
      jenis: 'gaji',
      tgltrans: gaji.tglakhir,
      lines: [
        { idakun: akun.beban, posisi: 'DEBET', amount: total },
        { idakun: akun.kas, posisi: 'KREDIT', amount: cash },
        { idakun: akun.bank, posisi: 'KREDIT', amount: bank },
      ],
    });

    const absenIds = await getAbsenIdsForGaji(conn, ctx, req.params.id);
    if (absenIds.length) {
      await conn.query(
        "UPDATE absen SET status = 'CONFIRMED' WHERE idtenant = ? AND idabsen IN (?) AND status = 'APPROVED'",
        [ctx.idtenant, absenIds]
      );
    }
    await conn.query(
      "UPDATE gaji SET status = 'APPROVED', idakun_beban = ?, idakun_kas = ?, idakun_bank = ? WHERE idgaji = ? AND idtenant = ?",
      [akun.beban, akun.kas, akun.bank, req.params.id, ctx.idtenant]
    );

    await conn.commit();
    await logger.history('GAJI_APPROVE', { idtenant: ctx.idtenant, idlokasi: gaji.idlokasi, iduser: ctx.iduser, ref: gaji.kodegaji, req });
    res.json({ message: 'Gaji berhasil diapprove' });
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
    const [[gaji]] = await conn.query(
      'SELECT * FROM gaji WHERE idgaji = ? AND idtenant = ? FOR UPDATE',
      [req.params.id, ctx.idtenant]
    );
    if (!gaji) {
      await conn.rollback();
      return res.status(404).json({ message: 'Gaji tidak ditemukan' });
    }
    if (gaji.status !== 'APPROVED') {
      await conn.rollback();
      return res.status(400).json({ message: 'Hanya gaji APPROVED yang bisa batal approve' });
    }

    await hapusJurnal(conn, ctx.idtenant, gaji.kodegaji);
    const absenIds = await getAbsenIdsForGaji(conn, ctx, req.params.id);
    if (absenIds.length) {
      await conn.query(
        "UPDATE absen SET status = 'APPROVED' WHERE idtenant = ? AND idabsen IN (?) AND status = 'CONFIRMED'",
        [ctx.idtenant, absenIds]
      );
    }
    await conn.query(
      "UPDATE gaji SET status = 'DRAFT', idakun_beban = NULL, idakun_kas = NULL, idakun_bank = NULL WHERE idgaji = ? AND idtenant = ?",
      [req.params.id, ctx.idtenant]
    );
    await conn.commit();
    await logger.history('GAJI_UNAPPROVE', { idtenant: ctx.idtenant, idlokasi: gaji.idlokasi, iduser: ctx.iduser, ref: gaji.kodegaji, req });
    res.json({ message: 'Approve gaji berhasil dibatalkan' });
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
    const [[gaji]] = await conn.query(
      'SELECT * FROM gaji WHERE idgaji = ? AND idtenant = ? FOR UPDATE',
      [req.params.id, ctx.idtenant]
    );
    if (!gaji) {
      await conn.rollback();
      return res.status(404).json({ message: 'Gaji tidak ditemukan' });
    }
    if (!['DRAFT', 'APPROVED'].includes(gaji.status)) {
      await conn.rollback();
      return res.status(400).json({ message: `Gaji status ${gaji.status} tidak bisa dibatalkan` });
    }
    if (gaji.status === 'APPROVED') {
      await hapusJurnal(conn, ctx.idtenant, gaji.kodegaji);
      const absenIds = await getAbsenIdsForGaji(conn, ctx, req.params.id);
      if (absenIds.length) {
        await conn.query(
          "UPDATE absen SET status = 'APPROVED' WHERE idtenant = ? AND idabsen IN (?) AND status = 'CONFIRMED'",
          [ctx.idtenant, absenIds]
        );
      }
    }
    await conn.query("UPDATE gaji SET status = 'CANCELLED' WHERE idgaji = ? AND idtenant = ?", [req.params.id, ctx.idtenant]);
    await conn.commit();
    await logger.history('GAJI_CANCEL', { idtenant: ctx.idtenant, idlokasi: gaji.idlokasi, iduser: ctx.iduser, ref: gaji.kodegaji, req });
    res.json({ message: 'Gaji berhasil dibatalkan' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(err.statusCode || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
