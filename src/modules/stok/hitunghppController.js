/**
 * Controller untuk perhitungan HPP (Harga Pokok Penjualan) metode rata-rata.
 * Menghitung saldo awal, pembelian, HPP per unit, penjualan, penyesuaian, dan saldo akhir per periode bulanan.
 * Endpoint: GET /api/hitunghpp, GET .../:id, GET .../check/:periodbulan, POST /api/hitunghpp, PUT .../:id/cancel
 */
const { tenantQuery, tenantExecute, getConnection, getTenantContext, pool } = require('../../config/db');
const { generateKodeHitungHPP } = require('../../lib/kodetrans');
const logger = require('../../lib/logger');

// Mendapatkan tanggal awal bulan dari string YYYY-MM
function getFirstDay(periodbulan) {
  return `${periodbulan}-01`;
}

// Mendapatkan tanggal akhir bulan dari string YYYY-MM
function getLastDay(periodbulan) {
  const [y, m] = periodbulan.split('-').map(Number);
  const d = new Date(y, m, 0);
  return `${y}-${String(m).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Mendapatkan periode bulan sebelumnya dari string YYYY-MM
function getPrevMonth(periodbulan) {
  const [y, m] = periodbulan.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Mendapatkan periode bulan berikutnya dari string YYYY-MM
function getNextMonth(periodbulan) {
  const [y, m] = periodbulan.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Menghitung stok barang pada suatu tanggal (beforeDate)
// Mencari saldo snapshot terdekat <= beforeDate, lalu menambahkan mutasi kartustok setelahnya
async function getStokAt(conn, ctx, idbarang, beforeDate) {
  // Cari saldo stok snapshot terbaru sebelum atau pada beforeDate
  let sql1 = `SELECT ss.idsaldostok, ss.tgltrans FROM saldostok ss
     WHERE ss.idtenant = ? AND ss.idlokasi = ? AND ss.tgltrans <= ?
     ORDER BY ss.tgltrans DESC LIMIT 1`;
  const [[latestSaldo]] = await conn.query(sql1, [ctx.idtenant, ctx.idlokasi, beforeDate]);

  let stok = 0;
  let fromDate = null;

  // Jika ada saldo snapshot, ambil stok dari detailnya dan jadikan titik awal (fromDate)
  if (latestSaldo) {
    let sql2 = `SELECT COALESCE(qty, 0) as qty FROM saldostokdtl
       WHERE idsaldostok = ? AND idtenant = ? AND idbarang = ?`;
    const [[snap]] = await conn.query(sql2, [latestSaldo.idsaldostok, ctx.idtenant, idbarang]);
    stok = snap ? parseFloat(snap.qty) : 0;
    fromDate = latestSaldo.tgltrans;
  }

  // Mutasi setelah snapshot: jumlahkan masuk (M) - keluar (K) dari kartustok
  const params = [ctx.idtenant, ctx.idlokasi, idbarang];
  let dateCond = 'AND tgltrans <= ?';
  params.push(beforeDate);
  if (fromDate) {
    dateCond += ' AND tgltrans > ?';
    params.push(fromDate);
  }

  let sql3 = `SELECT COALESCE(SUM(jml), 0) as total FROM kartustok
     WHERE idtenant = ? AND idlokasi = ? AND idbarang = ? AND jenis = 'M' ${dateCond}`;
  const [[masuk]] = await conn.query(sql3, params);
  let sql4 = `SELECT COALESCE(SUM(jml), 0) as total FROM kartustok
     WHERE idtenant = ? AND idlokasi = ? AND idbarang = ? AND jenis = 'K' ${dateCond}`;
  const [[keluar]] = await conn.query(sql4, params);

  stok += parseFloat(masuk.total) - parseFloat(keluar.total);
  return stok;
}

// Fungsi inti: menghitung HPP untuk satu barang pada satu periode
// Rumus: (saldoAwal + pembelian) / (qtyAwal + qtyBeli) = HPP per unit
// HPP Penjualan = qtyJual * HPP per unit
// Saldo Akhir = (totalQty + adjustment - penjualan) * HPP per unit
async function calcHPPItem(conn, ctx, idbarang, periodbulan, tglawal, tglakhir) {
  const prevMonth = getPrevMonth(periodbulan);

  // Ambil saldo akhir HPP dari periode sebelumnya (jika ada)
  let sql1 = `SELECT hd.saldoakhir_qty, hd.saldoakhir_nilai
     FROM hitunghpp h JOIN hitunghppdtl hd ON h.idhitunghpp = hd.idhitunghpp
     WHERE h.idtenant = ? AND h.idlokasi = ? AND h.periodbulan = ?
       AND h.status = 'AKTIF' AND hd.idbarang = ?`;
  const [[prevHPP]] = await conn.query(sql1,
    [ctx.idtenant, ctx.idlokasi, prevMonth, idbarang]
  );

  let saldoAwalQty = 0, saldoAwalNilai = 0;
  if (prevHPP) {
    // Gunakan saldo akhir periode sebelumnya sebagai saldo awal
    saldoAwalQty = parseFloat(prevHPP.saldoakhir_qty) || 0;
    saldoAwalNilai = parseFloat(prevHPP.saldoakhir_nilai) || 0;
  } else {
    // Jika belum pernah ada HPP, hitung saldo awal dari stok + harga beli terakhir
    const prevDay = new Date(tglawal);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayStr = prevDay.toISOString().slice(0, 10);
    saldoAwalQty = await getStokAt(conn, ctx, idbarang, prevDayStr);
    let sql2 = `SELECT hargabeli FROM hargabeli
       WHERE idtenant = ? AND idbarang = ? AND tgltrans <= ?
       ORDER BY tgltrans DESC, idhargabeli DESC LIMIT 1`;
    const [[hb]] = await conn.query(sql2,
      [ctx.idtenant, idbarang, tglawal]
    );
    saldoAwalNilai = saldoAwalQty * (hb ? parseFloat(hb.hargabeli) : 0);
  }

  // Hitung total pembelian (qty dan nilai) dalam periode
  let sql3 = `SELECT COALESCE(SUM(bd.jml), 0) as qty,
            COALESCE(SUM(bd.jml * bd.harga), 0) as nilai
     FROM belidtl bd JOIN beli b ON bd.idbeli = b.idbeli
     WHERE b.idtenant = ? AND b.idlokasi = ?
       AND b.status = 'AKTIF'
       AND b.tgltrans BETWEEN ? AND ?
       AND bd.idbarang = ?`;
  const [[pem]] = await conn.query(sql3,
    [ctx.idtenant, ctx.idlokasi, tglawal, tglakhir, idbarang]
  );

  // Hitung total penjualan (qty) dalam periode
  let sql4 = `SELECT COALESCE(SUM(jd.jml), 0) as qty
     FROM jualdtl jd JOIN jual j ON jd.idjual = j.idjual
     WHERE j.idtenant = ? AND j.idlokasi = ?
       AND j.status = 'AKTIF'
       AND j.tgltrans BETWEEN ? AND ?
       AND jd.idbarang = ?`;
  const [[jl]] = await conn.query(sql4,
    [ctx.idtenant, ctx.idlokasi, tglawal, tglakhir, idbarang]
  );

  // Hitung penyesuaian stok (masuk - keluar) dari kartustok dengan jenistransaksi 'PENYESUAIANSTOK'
  let sql5 = `SELECT
       COALESCE(SUM(CASE WHEN jenis='M' THEN jml ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN jenis='K' THEN jml ELSE 0 END), 0) as qty_net
     FROM kartustok
     WHERE idtenant = ? AND idlokasi = ?
       AND idbarang = ?
       AND jenistransaksi = 'PENYESUAIANSTOK'
       AND tgltrans BETWEEN ? AND ?`;
  const [[adj]] = await conn.query(sql5,
    [ctx.idtenant, ctx.idlokasi, idbarang, tglawal, tglakhir]
  );

  // Kalkulasi HPP: (saldoAwal + pembelian) / totalQty = HPP/unit
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

// GET /api/hitunghpp — Menampilkan daftar HPP dengan filter status dan tahun
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

// GET /api/hitunghpp/:id — Menampilkan detail HPP beserta item per barang
exports.getOne = async (req, res) => {
  try {
    const ctx = getTenantContext();
    let sql1 = `SELECT h.*, u.namauser FROM hitunghpp h
       LEFT JOIN user u ON h.iduser = u.iduser
       WHERE h.idhitunghpp = ? AND h.idlokasi = ?`;
    const rows = await tenantQuery(sql1,
      [req.params.id, ctx.idlokasi]
    );

    if (rows.length === 0) return res.status(404).json({ message: 'Data HPP tidak ditemukan' });

    let sql2 = `SELECT hd.*, b.kodebarang, b.namabarang, b.satuankecil
       FROM hitunghppdtl hd
       JOIN barang b ON hd.idbarang = b.idbarang AND b.idtenant = hd.idtenant
       WHERE hd.idhitunghpp = ?
       ORDER BY b.kodebarang`;
    const items = await tenantQuery(sql2,
      [req.params.id]
    );

    res.json({ ...rows[0], items });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/hitunghpp/check/:periodbulan — Mengecek apakah suatu periode valid untuk dihitung HPP-nya
// Validasi: format, bukan periode masa depan, belum ada posting, urutan bulan harus benar, akun wajib ada
exports.checkPeriod = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { periodbulan } = req.params;

    // Validasi format YYYY-MM
    if (!/^\d{4}-\d{2}$/.test(periodbulan)) {
      return res.status(400).json({ valid: false, reason: 'INVALID_FORMAT', message: 'Format periodbulan harus YYYY-MM' });
    }

    const tglawal = getFirstDay(periodbulan);
    const tglakhir = getLastDay(periodbulan);
    const today = new Date().toISOString().slice(0, 10);

    // Cek periode masa depan
    if (tglakhir > today) {
      return res.status(400).json({ valid: false, reason: 'FUTURE_PERIOD', message: 'Tidak bisa menghitung HPP untuk periode masa depan' });
    }

    // Cek apakah periode sudah pernah diposting
    let sql1 = "SELECT * FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan = ? AND status = 'AKTIF'";
    const [[existing]] = await conn.query(sql1,
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );
    if (existing) {
      return res.json({ valid: false, reason: 'ALREADY_POSTED', message: `Periode ${periodbulan} sudah dihitung`, existing: { idhitunghpp: existing.idhitunghpp, kodehitunghpp: existing.kodehitunghpp } });
    }

    // Cek apakah ada periode lebih baru yang sudah diposting (harus cancel dari yang terbaru dulu)
    let sql2 = "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan > ? AND status = 'AKTIF' ORDER BY periodbulan ASC LIMIT 1";
    const [[newerPeriod]] = await conn.query(sql2,
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );
    if (newerPeriod) {
      return res.json({ valid: false, reason: 'NOT_LATEST_PERIOD', message: `Sudah ada periode lebih baru yang dihitung: ${newerPeriod.periodbulan}` });
    }

    let sql3 = "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan < ? AND status = 'AKTIF' ORDER BY periodbulan DESC LIMIT 1";
    const [[anyPrevious]] = await conn.query(sql3,
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );

    // Cek apakah bulan sebelumnya sudah diposting (harus berurutan)
    if (anyPrevious) {
      const prevMonth = getPrevMonth(periodbulan);
      let sql4 = "SELECT idhitunghpp FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan = ? AND status = 'AKTIF'";
      const [[prevPosted]] = await conn.query(sql4,
        [ctx.idtenant, ctx.idlokasi, prevMonth]
      );
      if (!prevPosted) {
        return res.json({ valid: false, reason: 'PREVIOUS_NOT_POSTED', message: `Periode ${prevMonth} belum dihitung`, missing: prevMonth });
      }
    }

    // Validasi akun HPP dan PERSEDIAAN wajib ada untuk membuat jurnal
    let sql5 = "SELECT idakun FROM akun WHERE idtenant = ? AND (namaakun = 'HPP' OR kodeakun LIKE 'HPP%') LIMIT 1";
    const [[akunHPP]] = await conn.query(sql5,
      [ctx.idtenant]
    );
    let sql6 = "SELECT idakun FROM akun WHERE idtenant = ? AND (namaakun = 'PERSEDIAAN' OR kodeakun LIKE 'PERS%') LIMIT 1";
    const [[akunPersediaan]] = await conn.query(sql6,
      [ctx.idtenant]
    );
    if (!akunHPP || !akunPersediaan) {
      return res.json({ valid: false, reason: 'ACCOUNT_MISSING', message: 'Akun HPP atau PERSEDIAAN belum dibuat. Buat dulu di Master > Akun.' });
    }

    let sql7 = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil
       FROM barang b WHERE b.idtenant = ? AND b.status = 'AKTIF' ORDER BY b.kodebarang`;
    const [barangList] = await conn.query(sql7,
      [ctx.idtenant]
    );

    // Iterasi semua barang, hitung HPP masing-masing, skip yang tidak ada aktivitas
    const items = [];
    let totalPembelianSum = 0, totalHPPJualSum = 0, totalSaldoAkhirSum = 0;

    for (const b of barangList) {
      const calc = await calcHPPItem(conn, ctx, b.idbarang, periodbulan, tglawal, tglakhir);

      // Skip barang yang tidak ada aktivitas sama sekali
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

// POST /api/hitunghpp — Memposting HPP untuk suatu periode
// Melakukan: validasi, generate kode, insert header + detail, update total, insert jurnal (HPP & PERSEDIAAN)
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

    // Cek apakah periode sudah diposting (pakai FOR UPDATE untuk lock row)
    let sql1 = "SELECT * FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan = ? AND status = 'AKTIF' FOR UPDATE";
    const [[existing]] = await conn.query(sql1,
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );
    if (existing) {
      await conn.rollback();
      return res.status(400).json({ message: `Periode ${periodbulan} sudah dihitung. Cancel dulu jika mau hitung ulang.` });
    }

    let sql2 = "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan > ? AND status = 'AKTIF' ORDER BY periodbulan ASC LIMIT 1";
    const [[newerPeriod]] = await conn.query(sql2,
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );
    if (newerPeriod) {
      await conn.rollback();
      return res.status(400).json({ message: `Sudah ada periode lebih baru: ${newerPeriod.periodbulan}` });
    }

    let sql3 = "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan < ? AND status = 'AKTIF' ORDER BY periodbulan DESC LIMIT 1";
    const [[anyPrevious]] = await conn.query(sql3,
      [ctx.idtenant, ctx.idlokasi, periodbulan]
    );

    if (anyPrevious) {
      const prevMonth = getPrevMonth(periodbulan);
      let sql4 = "SELECT idhitunghpp FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan = ? AND status = 'AKTIF'";
      const [[prevPosted]] = await conn.query(sql4,
        [ctx.idtenant, ctx.idlokasi, prevMonth]
      );
      if (!prevPosted) {
        await conn.rollback();
        return res.status(400).json({ message: `Periode ${prevMonth} belum dihitung. Harus berurutan.` });
      }
    }

    let sql5 = "SELECT idakun FROM akun WHERE idtenant = ? AND (namaakun = 'HPP' OR kodeakun LIKE 'HPP%') LIMIT 1";
    const [[akunHPP]] = await conn.query(sql5,
      [ctx.idtenant]
    );
    let sql6 = "SELECT idakun FROM akun WHERE idtenant = ? AND (namaakun = 'PERSEDIAAN' OR kodeakun LIKE 'PERS%') LIMIT 1";
    const [[akunPersediaan]] = await conn.query(sql6,
      [ctx.idtenant]
    );
    if (!akunHPP || !akunPersediaan) {
      await conn.rollback();
      return res.status(400).json({ message: 'Akun HPP atau PERSEDIAAN belum dibuat. Buat dulu di Master > Akun.' });
    }

    // Generate kode HPP, insert header
    const kodehitunghpp = await generateKodeHitungHPP(conn, ctx.idtenant, ctx.idlokasi, periodbulan);

    let sql7 = `INSERT INTO hitunghpp (idtenant, idlokasi, kodehitunghpp, periodbulan, tglawal, tglakhir, iduser, catatan, status, userentry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AKTIF', ?)`;
    const [result] = await conn.query(sql7,
      [ctx.idtenant, ctx.idlokasi, kodehitunghpp, periodbulan, tglawal, tglakhir, ctx.iduser, catatan || null, ctx.iduser]
    );
    const idhitunghpp = result.insertId;

    let sql8 = `SELECT b.idbarang FROM barang b WHERE b.idtenant = ? AND b.status = 'AKTIF' ORDER BY b.kodebarang`;
    const [barangList] = await conn.query(sql8,
      [ctx.idtenant]
    );

    let totalPembelianSum = 0, totalHPPJualSum = 0, totalSaldoAkhirSum = 0;

    for (const b of barangList) {
      const calc = await calcHPPItem(conn, ctx, b.idbarang, periodbulan, tglawal, tglakhir);

      if (calc.saldoawal_qty === 0 && calc.pembelian_qty === 0 &&
          calc.qty_jual === 0 && calc.qty_adjust === 0) {
        continue;
      }

      let sql9 = `INSERT INTO hitunghppdtl (idhitunghpp, idtenant, idbarang,
          saldoawal_qty, saldoawal_nilai,
          pembelian_qty, pembelian_nilai,
          total_qty, total_nilai, hpp_per_unit,
          qty_jual, hpp_jual,
          qty_adjust, hpp_adjust,
          saldoakhir_qty, saldoakhir_nilai)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      await conn.query(sql9,
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

    // Update total di header
    let sql10 = 'UPDATE hitunghpp SET totalpembelian = ?, totalhppjual = ?, totalsaldoakhir = ? WHERE idhitunghpp = ?';
    await conn.query(sql10,
      [totalPembelianSum, totalHPPJualSum, totalSaldoAkhirSum, idhitunghpp]
    );

    // Insert jurnal: DEBET HPP, KREDIT PERSEDIAAN
    let sql11 = 'INSERT INTO jurnal (idtenant, idlokasi, idtrans, kodetrans, jenis, idakun, posisi, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    await conn.query(sql11,
      [ctx.idtenant, ctx.idlokasi, idhitunghpp, kodehitunghpp, 'hpp', akunHPP.idakun, 'DEBET', totalHPPJualSum]
    );
    let sql12 = 'INSERT INTO jurnal (idtenant, idlokasi, idtrans, kodetrans, jenis, idakun, posisi, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    await conn.query(sql12,
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

// PUT /api/hitunghpp/:id/cancel — Membatalkan posting HPP
// Syarat: HPP yang lebih baru harus dicancel dulu, tidak bisa cancel bulan tengah
exports.cancel = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    const { id } = req.params;

    await conn.beginTransaction();

    // Cek status HPP: harus AKTIF, tidak boleh sudah VOID
    let sql1 = "SELECT * FROM hitunghpp WHERE idhitunghpp = ? AND idtenant = ? AND idlokasi = ? FOR UPDATE";
    const [[record]] = await conn.query(sql1,
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

    // Cek tidak boleh cancel jika ada periode lebih baru yang masih AKTIF
    let sql2 = "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan > ? AND status = 'AKTIF' ORDER BY periodbulan ASC";
    const [[newerPosting]] = await conn.query(sql2,
      [ctx.idtenant, ctx.idlokasi, record.periodbulan]
    );
    if (newerPosting) {
      await conn.rollback();
      let sql3 = "SELECT periodbulan FROM hitunghpp WHERE idtenant = ? AND idlokasi = ? AND periodbulan > ? AND status = 'AKTIF' ORDER BY periodbulan ASC";
      const list = await conn.query(sql3,
        [ctx.idtenant, ctx.idlokasi, record.periodbulan]
      );
      const periods = list[0].map(p => p.periodbulan).join(', ');
      return res.status(400).json({ message: `Tidak bisa cancel bulan tengah. Cancel dulu periode setelahnya: ${periods}` });
    }

    // Update status HPP ke VOID dan jurnal ke NONAKTIF
    let sql4 = "UPDATE hitunghpp SET status = 'VOID' WHERE idhitunghpp = ?";
    await conn.query(sql4, [id]);

    let sql5 = "UPDATE jurnal SET status = 'NONAKTIF' WHERE jenis = 'hpp' AND idtrans = ? AND idtenant = ? AND idlokasi = ?";
    await conn.query(sql5,
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
