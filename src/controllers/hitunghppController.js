const { tenantQuery, tenantExecute, getConnection, getTenantContext, pool } = require('../config/db');
const { generateKodeHitungHPP } = require('../lib/kodetrans');
const logger = require('../lib/logger');

function getFirstDay(periodbulan) {
  return `${periodbulan}-01`;
}

function getLastDay(periodbulan) {
  const [y, m] = periodbulan.split('-').map(Number);
  const d = new Date(y, m, 0);
  return `${y}-${String(m).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getPrevMonth(periodbulan) {
  const [y, m] = periodbulan.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getNextMonth(periodbulan) {
  const [y, m] = periodbulan.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function getStokAt(conn, ctx, idbarang, beforeDate) {
  const [[latestSaldo]] = await conn.query(
    `SELECT ss.idsaldostok, ss.tgltrans FROM saldostok ss
     WHERE ss.idtenant = ? AND ss.idlokasi = ? AND ss.tgltrans <= ?
     ORDER BY ss.tgltrans DESC LIMIT 1`,
    [ctx.idtenant, ctx.idlokasi, beforeDate]
  );

  let stok = 0;
  let fromDate = null;

  if (latestSaldo) {
    const [[snap]] = await conn.query(
      `SELECT COALESCE(qty, 0) as qty FROM saldostokdtl
       WHERE idsaldostok = ? AND idtenant = ? AND idbarang = ?`,
      [latestSaldo.idsaldostok, ctx.idtenant, idbarang]
    );
    stok = snap ? parseFloat(snap.qty) : 0;
    fromDate = latestSaldo.tgltrans;
  }

  const params = [ctx.idtenant, ctx.idlokasi, idbarang];
  let dateCond = 'AND tgltrans <= ?';
  params.push(beforeDate);
  if (fromDate) {
    dateCond += ' AND tgltrans > ?';
    params.push(fromDate);
  }

  const [[masuk]] = await conn.query(
    `SELECT COALESCE(SUM(jml), 0) as total FROM kartustok
     WHERE idtenant = ? AND idlokasi = ? AND idbarang = ? AND jenis = 'M' ${dateCond}`,
    params
  );
  const [[keluar]] = await conn.query(
    `SELECT COALESCE(SUM(jml), 0) as total FROM kartustok
     WHERE idtenant = ? AND idlokasi = ? AND idbarang = ? AND jenis = 'K' ${dateCond}`,
    params
  );

  stok += parseFloat(masuk.total) - parseFloat(keluar.total);
  return stok;
}

async function calcHPPItem(conn, ctx, idbarang, periodbulan, tglawal, tglakhir) {
  const prevMonth = getPrevMonth(periodbulan);

  const [[prevHPP]] = await conn.query(
    `SELECT hd.saldoakhir_qty, hd.saldoakhir_nilai
     FROM hitunghpp h JOIN hitunghppdtl hd ON h.idhitunghpp = hd.idhitunghpp
     WHERE h.idtenant = ? AND h.idlokasi = ? AND h.periodbulan = ?
       AND h.status = 'AKTIF' AND hd.idbarang = ?`,
    [ctx.idtenant, ctx.idlokasi, prevMonth, idbarang]
  );

  let saldoAwalQty = 0, saldoAwalNilai = 0;
  if (prevHPP) {
    saldoAwalQty = parseFloat(prevHPP.saldoakhir_qty) || 0;
    saldoAwalNilai = parseFloat(prevHPP.saldoakhir_nilai) || 0;
  } else {
    const prevDay = new Date(tglawal);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayStr = prevDay.toISOString().slice(0, 10);
    saldoAwalQty = await getStokAt(conn, ctx, idbarang, prevDayStr);
    const [[hb]] = await conn.query(
      `SELECT hargabeli FROM hargabeli
       WHERE idtenant = ? AND idbarang = ? AND tgltrans <= ?
       ORDER BY tgltrans DESC, idhargabeli DESC LIMIT 1`,
      [ctx.idtenant, idbarang, tglawal]
    );
    saldoAwalNilai = saldoAwalQty * (hb ? parseFloat(hb.hargabeli) : 0);
  }

  const [[pem]] = await conn.query(
    `SELECT COALESCE(SUM(bd.jml), 0) as qty,
            COALESCE(SUM(bd.jml * bd.harga), 0) as nilai
     FROM belidtl bd JOIN beli b ON bd.idbeli = b.idbeli
     WHERE b.idtenant = ? AND b.idlokasi = ?
       AND b.status = 'AKTIF'
       AND b.tgltrans BETWEEN ? AND ?
       AND bd.idbarang = ?`,
    [ctx.idtenant, ctx.idlokasi, tglawal, tglakhir, idbarang]
  );

  const [[jl]] = await conn.query(
    `SELECT COALESCE(SUM(jd.jml), 0) as qty
     FROM jualdtl jd JOIN jual j ON jd.idjual = j.idjual
     WHERE j.idtenant = ? AND j.idlokasi = ?
       AND j.status = 'AKTIF'
       AND j.tgltrans BETWEEN ? AND ?
       AND jd.idbarang = ?`,
    [ctx.idtenant, ctx.idlokasi, tglawal, tglakhir, idbarang]
  );

  const [[adj]] = await conn.query(
    `SELECT
       COALESCE(SUM(CASE WHEN jenis='M' THEN jml ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN jenis='K' THEN jml ELSE 0 END), 0) as qty_net
     FROM kartustok
     WHERE idtenant = ? AND idlokasi = ?
       AND idbarang = ?
       AND jenisref = 'penyesuaianstok'
       AND tgltrans BETWEEN ? AND ?`,
    [ctx.idtenant, ctx.idlokasi, idbarang, tglawal, tglakhir]
  );

  const pembelianQty = parseFloat(pem.qty);
  const pembelianNilai = parseFloat(pem.nilai);
  const totalQty = saldoAwalQty + pembelianQty;
  const totalNilai = saldoAwalNilai + pembelianNilai;
  const hppPerUnit = totalQty > 0 ? totalNilai / totalQty : 0;
  const qtyJual = parseFloat(jl.qty);
  const hppJual = qtyJual * hppPerUnit;
  const qtyAdjust = parseFloat(adj.qty_net);
  const hppAdjust = qtyAdjust * hppPerUnit;
  const saldoAkhirQty = totalQty + qtyAdjust - qtyJual;
  const saldoAkhirNilai = saldoAkhirQty * hppPerUnit;

  return {
    idbarang,
    saldoawal_qty: saldoAwalQty,
    saldoawal_nilai: saldoAwalNilai,
    pembelian_qty: pembelianQty,
    pembelian_nilai: pembelianNilai,
    total_qty: totalQty,
    total_nilai: totalNilai,
    hpp_per_unit: hppPerUnit,
    qty_jual: qtyJual,
    hpp_jual: hppJual,
    qty_adjust: qtyAdjust,
    hpp_adjust: hppAdjust,
    saldoakhir_qty: saldoAkhirQty,
    saldoakhir_nilai: saldoAkhirNilai
  };
}

exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { status, tahun } = req.query;

    let sql = `SELECT h.*, u.namauser FROM hitunghpp h
      LEFT JOIN user u ON h.iduser = u.iduser
      WHERE h.idlokasi = ?`;
    const params = [ctx.idlokasi];

    if (status) { sql += ' AND h.status = ?'; params.push(status); }
    if (tahun) { sql += ' AND h.periodbulan LIKE ?'; params.push(`${tahun}-%`); }

    sql += ' ORDER BY h.periodbulan DESC, h.idhitunghpp DESC';

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
      `SELECT h.*, u.namauser FROM hitunghpp h
       LEFT JOIN user u ON h.iduser = u.iduser
       WHERE h.idhitunghpp = ? AND h.idlokasi = ?`,
      [req.params.id, ctx.idlokasi]
    );

    if (rows.length === 0) return res.status(404).json({ message: 'Data HPP tidak ditemukan' });

    const items = await tenantQuery(
      `SELECT hd.*, b.kodebarang, b.namabarang, b.satuankecil
       FROM hitunghppdtl hd
       JOIN barang b ON hd.idbarang = b.idbarang AND b.idtenant = hd.idtenant
       WHERE hd.idhitunghpp = ?
       ORDER BY b.kodebarang`,
      [req.params.id]
    );

    res.json({ ...rows[0], items });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

exports.checkPeriod = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { periodbulan } = req.params;

    if (!/^\d{4}-\d{2}$/.test(periodbulan)) {
      return res.status(400).json({ valid: false, reason: 'INVALID_FORMAT', message: 'Format periodbulan harus YYYY-MM' });
    }

    const tglawal = getFirstDay(periodbulan);
    const tglakhir = getLastDay(periodbulan);
    const today = new Date().toISOString().slice(0, 10);

    if (tglakhir > today) {
      return res.status(400).json({ valid: false, reason: 'FUTURE_PERIOD', message: 'Tidak bisa menghitung HPP untuk periode masa depan' });
    }

    const [[existing]] = await conn.query(
      "SELECT * FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan = ? AND status = 'AKTIF'",
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );
    if (existing) {
      return res.json({ valid: false, reason: 'ALREADY_POSTED', message: `Periode ${periodbulan} sudah dihitung`, existing: { idhitunghpp: existing.idhitunghpp, kodehitunghpp: existing.kodehitunghpp } });
    }

    const [[newerPeriod]] = await conn.query(
      "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan > ? AND status = 'AKTIF' ORDER BY periodbulan ASC LIMIT 1",
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );
    if (newerPeriod) {
      return res.json({ valid: false, reason: 'NOT_LATEST_PERIOD', message: `Sudah ada periode lebih baru yang dihitung: ${newerPeriod.periodbulan}` });
    }

    const [[anyPrevious]] = await conn.query(
      "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan < ? AND status = 'AKTIF' ORDER BY periodbulan DESC LIMIT 1",
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );

    if (anyPrevious) {
      const prevMonth = getPrevMonth(periodbulan);
      const [[prevPosted]] = await conn.query(
        "SELECT idhitunghpp FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan = ? AND status = 'AKTIF'",
        [ctx.idtenant, ctx.idlokasi, prevMonth]
      );
      if (!prevPosted) {
        return res.json({ valid: false, reason: 'PREVIOUS_NOT_POSTED', message: `Periode ${prevMonth} belum dihitung`, missing: prevMonth });
      }
    }

    const [[akunHPP]] = await conn.query(
      "SELECT idakun FROM akun WHERE idtenant = ? AND (namaakun = 'HPP' OR kodeakun LIKE 'HPP%') LIMIT 1",
      [ctx.idtenant]
    );
    const [[akunPersediaan]] = await conn.query(
      "SELECT idakun FROM akun WHERE idtenant = ? AND (namaakun = 'PERSEDIAAN' OR kodeakun LIKE 'PERS%') LIMIT 1",
      [ctx.idtenant]
    );
    if (!akunHPP || !akunPersediaan) {
      return res.json({ valid: false, reason: 'ACCOUNT_MISSING', message: 'Akun HPP atau PERSEDIAAN belum dibuat. Buat dulu di Master > Akun.' });
    }

    const [barangList] = await conn.query(
      `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil
       FROM barang b WHERE b.idtenant = ? AND b.status = 'AKTIF' ORDER BY b.kodebarang`,
      [ctx.idtenant]
    );

    const items = [];
    let totalPembelianSum = 0, totalHPPJualSum = 0, totalSaldoAkhirSum = 0;

    for (const b of barangList) {
      const calc = await calcHPPItem(conn, ctx, b.idbarang, periodbulan, tglawal, tglakhir);

      if (calc.saldoawal_qty === 0 && calc.pembelian_qty === 0 &&
          calc.qty_jual === 0 && calc.qty_adjust === 0) {
        continue;
      }

      items.push({
        ...calc,
        kodebarang: b.kodebarang,
        namabarang: b.namabarang,
        satuan: b.satuankecil
      });

      totalPembelianSum += calc.pembelian_nilai;
      totalHPPJualSum += calc.hpp_jual;
      totalSaldoAkhirSum += calc.saldoakhir_nilai;
    }

    res.json({
      valid: true,
      periodbulan,
      tglawal,
      tglakhir,
      total_pembelian: totalPembelianSum,
      total_hpp_jual: totalHPPJualSum,
      total_saldo_akhir: totalSaldoAkhirSum,
      items
    });
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
    const { periodbulan, catatan } = req.body;

    const tglawal = getFirstDay(periodbulan);
    const tglakhir = getLastDay(periodbulan);
    const today = new Date().toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}$/.test(periodbulan)) {
      return res.status(400).json({ message: 'Format periodbulan harus YYYY-MM' });
    }
    if (tglakhir > today) {
      return res.status(400).json({ message: 'Tidak bisa menghitung HPP untuk periode masa depan' });
    }

    await conn.beginTransaction();

    const [[existing]] = await conn.query(
      "SELECT * FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan = ? AND status = 'AKTIF' FOR UPDATE",
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );
    if (existing) {
      await conn.rollback();
      return res.status(400).json({ message: `Periode ${periodbulan} sudah dihitung. Cancel dulu jika mau hitung ulang.` });
    }

    const [[newerPeriod]] = await conn.query(
      "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan > ? AND status = 'AKTIF' ORDER BY periodbulan ASC LIMIT 1",
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );
    if (newerPeriod) {
      await conn.rollback();
      return res.status(400).json({ message: `Sudah ada periode lebih baru: ${newerPeriod.periodbulan}` });
    }

    const [[anyPrevious]] = await conn.query(
      "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan < ? AND status = 'AKTIF' ORDER BY periodbulan DESC LIMIT 1",
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );

    if (anyPrevious) {
      const prevMonth = getPrevMonth(periodbulan);
      const [[prevPosted]] = await conn.query(
        "SELECT idhitunghpp FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan = ? AND status = 'AKTIF'",
        [ctx.idtenant, ctx.idlokasi, prevMonth]
      );
      if (!prevPosted) {
        await conn.rollback();
        return res.status(400).json({ message: `Periode ${prevMonth} belum dihitung. Harus berurutan.` });
      }
    }

    const [[akunHPP]] = await conn.query(
      "SELECT idakun FROM akun WHERE idtenant = ? AND (namaakun = 'HPP' OR kodeakun LIKE 'HPP%') LIMIT 1",
      [ctx.idtenant]
    );
    const [[akunPersediaan]] = await conn.query(
      "SELECT idakun FROM akun WHERE idtenant = ? AND (namaakun = 'PERSEDIAAN' OR kodeakun LIKE 'PERS%') LIMIT 1",
      [ctx.idtenant]
    );
    if (!akunHPP || !akunPersediaan) {
      await conn.rollback();
      return res.status(400).json({ message: 'Akun HPP atau PERSEDIAAN belum dibuat. Buat dulu di Master > Akun.' });
    }

    const kodehitunghpp = await generateKodeHitungHPP(conn, ctx.idtenant, ctx.idlokasi, periodbulan);

    const [result] = await conn.query(
      `INSERT INTO hitunghpp (idtenant, idlokasi, kodehitunghpp, periodbulan, tglawal, tglakhir, iduser, catatan, status, userentry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AKTIF', ?)`,
      [ctx.idtenant, ctx.idlokasi, kodehitunghpp, periodbulan, tglawal, tglakhir, ctx.iduser, catatan || null, ctx.iduser]
    );
    const idhitunghpp = result.insertId;

    const [barangList] = await conn.query(
      `SELECT b.idbarang FROM barang b WHERE b.idtenant = ? AND b.status = 'AKTIF' ORDER BY b.kodebarang`,
      [ctx.idtenant]
    );

    let totalPembelianSum = 0, totalHPPJualSum = 0, totalSaldoAkhirSum = 0;

    for (const b of barangList) {
      const calc = await calcHPPItem(conn, ctx, b.idbarang, periodbulan, tglawal, tglakhir);

      if (calc.saldoawal_qty === 0 && calc.pembelian_qty === 0 &&
          calc.qty_jual === 0 && calc.qty_adjust === 0) {
        continue;
      }

      await conn.query(
        `INSERT INTO hitunghppdtl (idhitunghpp, idtenant, idbarang,
          saldoawal_qty, saldoawal_nilai,
          pembelian_qty, pembelian_nilai,
          total_qty, total_nilai, hpp_per_unit,
          qty_jual, hpp_jual,
          qty_adjust, hpp_adjust,
          saldoakhir_qty, saldoakhir_nilai)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [idhitunghpp, ctx.idtenant, b.idbarang,
         calc.saldoawal_qty, calc.saldoawal_nilai,
         calc.pembelian_qty, calc.pembelian_nilai,
         calc.total_qty, calc.total_nilai, calc.hpp_per_unit,
         calc.qty_jual, calc.hpp_jual,
         calc.qty_adjust, calc.hpp_adjust,
         calc.saldoakhir_qty, calc.saldoakhir_nilai]
      );

      totalPembelianSum += calc.pembelian_nilai;
      totalHPPJualSum += calc.hpp_jual;
      totalSaldoAkhirSum += calc.saldoakhir_nilai;
    }

    await conn.query(
      'UPDATE hitunghpp SET totalpembelian = ?, totalhppjual = ?, totalsaldoakhir = ? WHERE idhitunghpp = ?',
      [totalPembelianSum, totalHPPJualSum, totalSaldoAkhirSum, idhitunghpp]
    );

    await conn.query(
      'INSERT INTO jurnal (idtenant, idlokasi, idtrans, kodetrans, jenis, idakun, posisi, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ctx.idtenant, ctx.idlokasi, idhitunghpp, kodehitunghpp, 'hpp', akunHPP.idakun, 'DEBET', totalHPPJualSum]
    );
    await conn.query(
      'INSERT INTO jurnal (idtenant, idlokasi, idtrans, kodetrans, jenis, idakun, posisi, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ctx.idtenant, ctx.idlokasi, idhitunghpp, kodehitunghpp, 'hpp', akunPersediaan.idakun, 'KREDIT', totalHPPJualSum]
    );

    await conn.commit();

    await logger.history('HPP_CREATE', {
      idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser,
      ref: kodehitunghpp, detail: { periodbulan, total_hpp_jual: totalHPPJualSum }, req
    });

    res.status(201).json({ message: 'HPP berhasil diposting', idhitunghpp, kodehitunghpp, total_hpp_jual: totalHPPJualSum });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req, idtenant: ctx?.idtenant, iduser: ctx?.iduser, idlokasi: ctx?.idlokasi });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.cancel = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { id } = req.params;

    await conn.beginTransaction();

    const [[record]] = await conn.query(
      "SELECT * FROM hitunghpp WHERE idhitunghpp = ? AND idtenant = ? AND idlokasi = ? FOR UPDATE",
      [id, ctx.idtenant, ctx.idlokasi]
    );
    if (!record) {
      await conn.rollback();
      return res.status(404).json({ message: 'Data HPP tidak ditemukan' });
    }
    if (record.status !== 'AKTIF') {
      await conn.rollback();
      return res.status(400).json({ message: 'HPP sudah dibatalkan' });
    }

    const [[newerPosting]] = await conn.query(
      "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan > ? AND status = 'AKTIF' ORDER BY periodbulan ASC",
      [ctx.idtenant, ctx.idlokasi, record.periodbulan]
    );
    if (newerPosting) {
      await conn.rollback();
      const list = await conn.query(
        "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan > ? AND status = 'AKTIF' ORDER BY periodbulan ASC",
        [ctx.idtenant, ctx.idlokasi, record.periodbulan]
      );
      const periods = list[0].map(p => p.periodbulan).join(', ');
      return res.status(400).json({ message: `Tidak bisa cancel bulan tengah. Cancel dulu periode setelahnya: ${periods}` });
    }

    await conn.query("UPDATE hitunghpp SET status = 'VOID' WHERE idhitunghpp = ?", [id]);

    await conn.query(
      "UPDATE jurnal SET status = 'NONAKTIF' WHERE jenis = 'hpp' AND idtrans = ? AND idtenant = ? AND idlokasi = ?",
      [id, ctx.idtenant, ctx.idlokasi]
    );

    await conn.commit();

    await logger.history('HPP_CANCEL', {
      idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser,
      ref: record.kodehitunghpp, detail: { periodbulan: record.periodbulan }, req
    });

    res.json({ message: 'HPP berhasil dibatalkan' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req, idtenant: ctx?.idtenant, iduser: ctx?.iduser, idlokasi: ctx?.idlokasi });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
