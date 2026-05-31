/**
 * Controller untuk berbagai laporan: penjualan (transaksi, per customer, per barang, per lokasi, rekap),
 * pembelian (transaksi, per supplier, per lokasi, per barang, rekap), stok, kartu stok, struk, dan faktur.
 * Mendukung output format JSON (default) dan HTML (render EJS).
 * Endpoint: GET /api/laporan/*
 */
const { tenantQuery, getTenantContext, pool } = require('../../config/db');
const logger = require('../../lib/logger');

const REPORT_PREVIEW_QUERY_LIMIT = 1000;

function withPreviewLimit(req, sql) {
  if (req.query.format !== 'html' || req.fullReportExport || /\bLIMIT\s+\d+/i.test(sql)) {
    return sql;
  }
  return `${sql} LIMIT ${REPORT_PREVIEW_QUERY_LIMIT}`;
}

// GET /api/laporan/jenistransaksi-kartustok
exports.getJenisTransaksiKartuStok = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const sql = `SELECT DISTINCT jenistransaksi FROM kartustok WHERE idtenant = ? AND jenistransaksi IS NOT NULL AND jenistransaksi != '' ORDER BY jenistransaksi`;
    const rows = await tenantQuery(sql, [ctx.idtenant]);
    res.json(rows.map(r => r.jenistransaksi));
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};
exports.getJenisRef = exports.getJenisTransaksiKartuStok;


// Helper: buildAdvancedFilter — terima JSON [{field, op, value}], hasilkan {clause, params}
// Logic: entri dengan field sama → OR; antar grup field berbeda → AND
function buildAdvancedFilter(filtersJson) {
  if (!filtersJson) return { clause: '', params: [] };
  let parsed;
  try { parsed = JSON.parse(filtersJson); } catch { return { clause: '', params: [] }; }
  if (!Array.isArray(parsed) || parsed.length === 0) return { clause: '', params: [] };

  const FIELD_COL = {
    namacustomer  : 'c.namacustomer',
    kodecustomer  : 'c.kodecustomer',
    alamatcustomer: 'c.alamat',
    namasupplier  : 's.namasupplier',
    kodesupplier  : 's.kodesupplier',
    alamatsupplier: 's.alamat',
    namabarang    : 'b.namabarang',
    kodebarang    : 'b.kodebarang',
  };

  const groups = {};
  for (const f of parsed) {
    const col = FIELD_COL[f.field];
    if (!col || !f.value) continue;
    if (!groups[f.field]) groups[f.field] = [];
    groups[f.field].push({ col, op: f.op, value: f.value });
  }

  const groupClauses = [];
  const allParams = [];

  for (const entries of Object.values(groups)) {
    const orParts = entries.map(({ col, op, value }) => {
      if (op === 'ADALAH') { allParams.push(value); return `${col} = ?`; }
      else { allParams.push(`%${value}%`); return `${col} LIKE ?`; }
    });
    groupClauses.push(`(${orParts.join(' OR ')})`);
  }

  if (groupClauses.length === 0) return { clause: '', params: [] };
  return { clause: groupClauses.join(' AND '), params: allParams };
}

// Helper: membuat klausa LIKE multi-value untuk filter (misal "A,B,C" -> kodelokasi LIKE '%A%' OR kodelokasi LIKE '%B%')
function multiLike(column, raw) {
  const vals = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!vals.length) return { clause: '', params: [] };
  const likes = vals.map(() => `${column} LIKE ?`);
  return { clause: `(${likes.join(' OR ')})`, params: vals.map(v => `%${v}%`) };
}

// Helper: membuat klausa IN multi-ID (misal "1,2,3" -> column IN (1,2,3))
function multiIdIn(column, raw) {
  const vals = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!vals.length) return { clause: '', params: [] };
  if (vals.length === 1) return { clause: `${column} = ?`, params: [vals[0]] };
  const placeholders = vals.map(() => '?').join(',');
  return { clause: `${column} IN (${placeholders})`, params: vals };
}



/**
 * GET /api/laporan/sales-transaksi
 * Controller untuk menghasilkan laporan detail transaksi penjualan (per item).
 * Mendukung format output JSON untuk API dan HTML untuk kebutuhan cetak (Print).
 */
exports.salesTransaksi = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const {
      tglwal, tglakhir, kodelokasi, namalokasi,
      kodecustomer, namacustomer, statusLunas,
      idlokasi, filters
    } = req.query;
    
    // Default format adalah JSON jika tidak secara eksplisit di-request 'html'
    const format = req.query.format || 'json';

    // 1. PERSIAPAN BASE QUERY
    // Mengambil data header penjualan, detail item, serta informasi pelunasan piutang jika ada.
    let sql = `
    SELECT 
      j.kodejual, j.tgltrans, l.namalokasi,
      c.kodecustomer, c.namacustomer,
      b.kodebarang, b.namabarang,
      jdtl.idjualdtl, jdtl.jml, jdtl.satuan, jdtl.harga, jdtl.ppn, jdtl.subtotal, j.grandtotal, j.jenistransaksi AS jenis,
      pp.tgltrans AS tglpelunasan, kp.terbayar as amount, kp.sisa
    FROM jual j
      JOIN jualdtl jdtl ON j.idjual = jdtl.idjual AND jdtl.idtenant = j.idtenant
      JOIN lokasi l ON l.idlokasi = j.idlokasi AND l.idtenant = j.idtenant
      JOIN customer c ON c.idcustomer = j.idcustomer AND c.idtenant = j.idtenant
      JOIN barang b ON b.idbarang = jdtl.idbarang AND b.idtenant = j.idtenant
      LEFT JOIN kartupiutang kp ON kp.kodetrans = j.kodejual AND kp.jenis = 'JUAL'
      LEFT JOIN pelunasanpiutangdtl ppdtl ON ppdtl.kodetrans = kp.kodetrans
      LEFT JOIN pelunasanpiutang pp ON pp.idpelunasan = ppdtl.idpelunasan
    WHERE j.idtenant = ? AND j.status IN ('APPROVED', 'CONFIRMED')`;
    
    const params = [ctx.idtenant];

    // 2. TERAPKAN FILTER PENCARIAN (DYNAMIC QUERY)
    if (tglwal) { 
      sql += ' AND j.tgltrans >= ?'; 
      params.push(tglwal); 
    }
    if (tglakhir) { 
      sql += ' AND j.tgltrans <= ?'; 
      params.push(tglakhir); 
    }

    if (kodelokasi) {
      const { clause, params: p } = multiLike('l.kodelokasi', kodelokasi);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (namalokasi) {
      const { clause, params: p } = multiLike('l.namalokasi', namalokasi);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (kodecustomer) {
      const { clause, params: p } = multiLike('c.kodecustomer', kodecustomer);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (namacustomer) {
      const { clause, params: p } = multiLike('c.namacustomer', namacustomer);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }

    // New: idlokasi multi-ID and advanced filters from LaporanPage
    if (idlokasi) { const r = multiIdIn('j.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    const af0 = buildAdvancedFilter(filters);
    if (af0.clause) { sql += ' AND ' + af0.clause; params.push(...af0.params); }

    if (statusLunas === 'lunas') {
      sql += ' AND kp.sisa <= 0';
    } else if (statusLunas === 'belum') {
      sql += ' AND (kp.sisa > 0 OR kp.sisa IS NULL)';
    }

    // 3. GROUPING & SORTING
    sql += ' GROUP BY jdtl.idjualdtl ORDER BY j.tgltrans DESC, j.kodejual DESC, jdtl.idjualdtl ASC';

    // 4. EKSEKUSI QUERY
    const rows = await tenantQuery(withPreviewLimit(req, sql), params);

    // 5. FORMATTING: KELOMPOKKAN ITEM KE DALAM TRANSAKSI MASING-MASING
    const transactions = [];
    let currentKode = null;
    let currentGroup = null;
    const seenKodejual = new Set();

    for (const row of rows) {
      // Jika kodejual beda dengan sebelumnya, buat grup parent transaksi baru
      if (row.kodejual !== currentKode) {
        currentKode = row.kodejual;
        const sisaVal = parseFloat(row.sisa) || 0;
        
        currentGroup = {
          kodejual    : row.kodejual,
          tgltrans    : row.tgltrans,
          namalokasi  : row.namalokasi,
          kodecustomer: row.kodecustomer,
          namacustomer: row.namacustomer,
          grandtotal  : parseFloat(row.grandtotal) || 0,
          tglpelunasan: row.tglpelunasan,
          amount      : parseFloat(row.amount) || 0,
          sisa        : sisaVal,
          statusLunas : sisaVal <= 0 ? 'LUNAS' : 'Belum Lunas', // <-- [FIX]: Safety check untuk status lunas
          jenis       : row.jenis,
          items       : [] // Array untuk menampung baris detail barang
        };
        
        transactions.push(currentGroup);
        seenKodejual.add(row.kodejual);
      }
      
      // Masukkan baris item/barang ke dalam parent transaksi saat ini
      currentGroup.items.push({
        kodebarang: row.kodebarang,
        namabarang: row.namabarang,
        jml       : row.jml,
        satuan    : row.satuan,
        harga     : parseFloat(row.harga) || 0,
        ppn       : parseFloat(row.ppn) || 0,
        subtotal  : parseFloat(row.subtotal) || 0
      });
    }

    // Kalkulasi rekapitulasi data
    const totalTransaksi = seenKodejual.size;
    const totalPenjualan = transactions.reduce((sum, t) => sum + t.grandtotal, 0);

    // 6. TANGANI RESPONSE BERDASARKAN FORMAT YANG DIMINTA
    if (format === 'html') {
      // Query tambahan untuk header cetakan (informasi toko/tenant)
      const sqlTenant = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenant, [ctx.idtenant]);
      
      const sqlLokasi = 'SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?';
      const [[lokasi]] = await pool.query(sqlLokasi, [ctx.idlokasi, ctx.idtenant]);
      
      return res.render('laporan_sales_transaksi', {
        transactions,
        totalTransaksi,
        totalPenjualan,
        tglwal      : tglwal || '-',
        tglakhir    : tglakhir || '-',
        statusLunas : statusLunas || '',
        kodelokasi  : kodelokasi || '',
        namalokasi  : namalokasi || '',
        kodecustomer: kodecustomer || '',
        namacustomer: namacustomer || '',
        namatoko    : tenant?.namatenant || 'Grfyn POS',
        alamat      : lokasi?.alamat || '',
        hp          : lokasi?.hp || '',
        logo        : tenant?.logo || '',
        tglcetak    : new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    // Response default (JSON) untuk dikonsumsi frontend (React/Vue/dsb)
    return res.json({ transactions, totalTransaksi, totalPenjualan });

  } catch (err) {
    // Logging error yang informatif di sisi server
    logger.error(`[API Laporan Sales Transaksi] Error: ${err.message}`, { req });
    return res.status(500).json({ 
      message: "Terjadi kesalahan server saat memuat laporan.",
      error: err.message // Opsional: Hapus line ini di production agar aman
    });
  }
};
// GET /api/laporan/sales-per-customer — Laporan penjualan dikelompokkan per customer
// GET /api/laporan/sales-per-customer — Laporan penjualan detail per customer
exports.salesPerCustomer = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { 
      tglwal, tglakhir, kodelokasi, namalokasi, 
      kodecustomer, namacustomer, statusLunas 
    } = req.query;
    
    const format = req.query.format || 'json';

    // 1. BASE QUERY (Ambil detail barang seperti sales transaksi)
    let sql = `
    SELECT 
      j.kodejual, j.tgltrans, l.namalokasi,
      c.kodecustomer, c.namacustomer,
      b.kodebarang, b.namabarang,
      jdtl.jml, jdtl.satuan, jdtl.harga, jdtl.ppn, jdtl.subtotal, j.grandtotal, j.jenistransaksi AS jenis,
      kp.terbayar as amount, kp.sisa
    FROM jual j
      JOIN jualdtl jdtl ON j.idjual = jdtl.idjual AND jdtl.idtenant = j.idtenant
      JOIN lokasi l ON l.idlokasi = j.idlokasi AND l.idtenant = j.idtenant
      JOIN customer c ON c.idcustomer = j.idcustomer AND c.idtenant = j.idtenant
      JOIN barang b ON b.idbarang = jdtl.idbarang AND b.idtenant = j.idtenant
      LEFT JOIN kartupiutang kp ON kp.kodetrans = j.kodejual AND kp.jenis = 'JUAL'
    WHERE j.idtenant = ? AND j.status IN ('APPROVED', 'CONFIRMED')`;

    const params = [ctx.idtenant];

    // 2. FILTERING
    if (tglwal) { sql += ' AND j.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND j.tgltrans <= ?'; params.push(tglakhir); }

    if (kodelokasi) {
      const { clause, params: p } = multiLike('l.kodelokasi', kodelokasi);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (namalokasi) {
      const { clause, params: p } = multiLike('l.namalokasi', namalokasi);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (kodecustomer) {
      const { clause, params: p } = multiLike('c.kodecustomer', kodecustomer);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (namacustomer) {
      const { clause, params: p } = multiLike('c.namacustomer', namacustomer);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }

    if (statusLunas === 'lunas') {
      sql += ' AND (kp.sisa <= 0 OR kp.sisa IS NULL)';
    } else if (statusLunas === 'belum') {
      sql += ' AND kp.sisa > 0';
    }

    // 3. SORTING (PENTING: Harus urut customer dulu baru kodejual)
    sql += ' ORDER BY c.namacustomer ASC, j.tgltrans DESC, j.kodejual DESC, jdtl.idjualdtl ASC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);

    // 4. FORMATTING: Grouping Item ke dalam Transaksi
    const transactions = [];
    let currentKodejual = null;
    let currentGroupTrx = null;

    for (const row of rows) {
      if (row.kodejual !== currentKodejual) {
        currentKodejual = row.kodejual;
        const sisaVal = parseFloat(row.sisa) || 0;

        currentGroupTrx = {
          kodejual    : row.kodejual,
          tgltrans    : row.tgltrans,
          namalokasi  : row.namalokasi,
          kodecustomer: row.kodecustomer,
          namacustomer: row.namacustomer,
          grandtotal  : parseFloat(row.grandtotal) || 0,
          amount      : parseFloat(row.amount) || 0,
          sisa        : sisaVal,
          statusLunas : sisaVal <= 0 ? 'LUNAS' : 'BELUM LUNAS',
          jenis       : row.jenis,
          items       : []
        };
        transactions.push(currentGroupTrx);
      }

      currentGroupTrx.items.push({
        kodebarang: row.kodebarang,
        namabarang: row.namabarang,
        jml       : row.jml,
        satuan    : row.satuan,
        harga     : parseFloat(row.harga) || 0,
        ppn       : parseFloat(row.ppn) || 0,
        subtotal  : parseFloat(row.subtotal) || 0
      });
    }

    // Hitung Grand Total Penjualan (Berdasarkan unique transaksi)
    const totalPenjualan = transactions.reduce((sum, t) => sum + t.grandtotal, 0);

    // 5. RESPONSE
    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);

      return res.render('laporan_sales_per_customer', {
        transactions, // Data yang sudah di-group per transaksi
        totalPenjualan,
        tglwal      : tglwal || '-',
        tglakhir    : tglakhir || '-',
        statusLunas : statusLunas || '',
        kodelokasi  : kodelokasi || '',
        namalokasi  : namalokasi || '',
        kodecustomer: kodecustomer || '',
        namacustomer: namacustomer || '',
        namatoko    : tenant?.namatenant || 'Grfyn POS',
        alamat      : lokasi?.alamat || '',
        hp          : lokasi?.hp || '',
        logo        : tenant?.logo || '',
        tglcetak    : new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ transactions, totalPenjualan });

  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/sales-per-barang — Laporan penjualan dikelompokkan per barang
exports.salesPerBarang = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, kodelokasi, namalokasi, kodecustomer, namacustomer, statusLunas } = req.query;
    const format = req.query.format || 'json';

    if (format === 'html') {
      // Query detail-level per item penjualan untuk HTML grouping
      let sqlDetail = `
      SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil as satuan,
        j.kodejual, j.tgltrans, j.jenistransaksi AS jenis, c.namacustomer, l.namalokasi,
        jd.jml, jd.harga, jd.subtotal,
        kp.sisa
      FROM barang b
        JOIN jualdtl jd ON b.idbarang = jd.idbarang AND b.idtenant = jd.idtenant
        JOIN jual j ON jd.idjual = j.idjual AND j.idtenant = jd.idtenant AND j.status IN ('APPROVED', 'CONFIRMED')
        LEFT JOIN customer c ON j.idcustomer = c.idcustomer AND c.idtenant = j.idtenant
        LEFT JOIN lokasi l ON j.idlokasi = l.idlokasi AND l.idtenant = j.idtenant
        LEFT JOIN kartupiutang kp ON kp.kodetrans = j.kodejual AND kp.jenis = 'JUAL'
      WHERE b.idtenant = ?`;
      const detailParams = [ctx.idtenant];

      if (tglwal) { sqlDetail += ' AND j.tgltrans >= ?'; detailParams.push(tglwal); }
      if (tglakhir) { sqlDetail += ' AND j.tgltrans <= ?'; detailParams.push(tglakhir); }
      if (kodelokasi) {
        sqlDetail += ` AND j.idlokasi IN (SELECT idlokasi FROM lokasi WHERE idtenant = b.idtenant AND (`;
        const vals = kodelokasi.split(',').map(s => s.trim()).filter(Boolean);
        sqlDetail += vals.map(() => 'kodelokasi LIKE ?').join(' OR ');
        sqlDetail += '))';
        vals.forEach(v => detailParams.push(`%${v}%`));
      }
      if (namalokasi) {
        sqlDetail += ` AND j.idlokasi IN (SELECT idlokasi FROM lokasi WHERE idtenant = b.idtenant AND (`;
        const vals = namalokasi.split(',').map(s => s.trim()).filter(Boolean);
        sqlDetail += vals.map(() => 'namalokasi LIKE ?').join(' OR ');
        sqlDetail += '))';
        vals.forEach(v => detailParams.push(`%${v}%`));
      }
      if (kodecustomer) {
        sqlDetail += ` AND j.idcustomer IN (SELECT idcustomer FROM customer WHERE idtenant = b.idtenant AND (`;
        const vals = kodecustomer.split(',').map(s => s.trim()).filter(Boolean);
        sqlDetail += vals.map(() => 'kodecustomer LIKE ?').join(' OR ');
        sqlDetail += '))';
        vals.forEach(v => detailParams.push(`%${v}%`));
      }
      if (namacustomer) {
        sqlDetail += ` AND j.idcustomer IN (SELECT idcustomer FROM customer WHERE idtenant = b.idtenant AND (`;
        const vals = namacustomer.split(',').map(s => s.trim()).filter(Boolean);
        sqlDetail += vals.map(() => 'namacustomer LIKE ?').join(' OR ');
        sqlDetail += '))';
        vals.forEach(v => detailParams.push(`%${v}%`));
      }
      if (statusLunas === 'lunas') {
        sqlDetail += ' AND kp.sisa <= 0';
      } else if (statusLunas === 'belum') {
        sqlDetail += ' AND (kp.sisa > 0 OR kp.sisa IS NULL)';
      }
      sqlDetail += ' ORDER BY b.namabarang ASC, j.tgltrans DESC';

      const detailRows = await tenantQuery(withPreviewLimit(req, sqlDetail), detailParams);
      const grandTotal = detailRows.reduce((sum, r) => sum + parseFloat(r.subtotal || 0), 0);

      let sqlTenant3 = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenant3, [ctx.idtenant]);
      return res.render('laporan_sales_per_barang', {
        data        : detailRows,                        grandTotal,
        tglwal      : tglwal || '-',                     tglakhir    : tglakhir || '-',
        statusLunas : statusLunas || '',
        kodelokasi  : kodelokasi || '',                  namalokasi  : namalokasi || '',
        kodecustomer: kodecustomer || '',                namacustomer: namacustomer || '',
        namatoko    : tenant?.namatenant || 'Grfyn POS',
        alamat      : '',                                hp          : '',                 logo: tenant?.logo || '',
        tglcetak    : new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    // JSON: tetap gunakan query agregasi
    let sql = `
    SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil as satuan,
      COALESCE(SUM(jd.jml), 0) as total_qty,
      COALESCE(SUM(jd.subtotal), 0) as total_nilai
    FROM barang b
      LEFT JOIN jualdtl jd ON b.idbarang = jd.idbarang AND b.idtenant = jd.idtenant
      LEFT JOIN jual j ON jd.idjual = j.idjual AND j.idtenant = jd.idtenant AND j.status = 'AKTIF'
      LEFT JOIN kartupiutang kp ON kp.kodetrans = j.kodejual AND kp.jenis = 'JUAL'
    WHERE b.idtenant = ?`;
    const params = [ctx.idtenant];

    if (tglwal) { sql += ' AND j.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND j.tgltrans <= ?'; params.push(tglakhir); }
    if (kodelokasi) {
      sql += ` AND j.idlokasi IN (SELECT idlokasi FROM lokasi WHERE idtenant = b.idtenant AND (`;
      const vals = kodelokasi.split(',').map(s => s.trim()).filter(Boolean);
      sql += vals.map(() => 'kodelokasi LIKE ?').join(' OR ');
      sql += '))';
      vals.forEach(v => params.push(`%${v}%`));
    }
    if (namalokasi) {
      sql += ` AND j.idlokasi IN (SELECT idlokasi FROM lokasi WHERE idtenant = b.idtenant AND (`;
      const vals = namalokasi.split(',').map(s => s.trim()).filter(Boolean);
      sql += vals.map(() => 'namalokasi LIKE ?').join(' OR ');
      sql += '))';
      vals.forEach(v => params.push(`%${v}%`));
    }
    if (kodecustomer) {
      sql += ` AND j.idcustomer IN (SELECT idcustomer FROM customer WHERE idtenant = b.idtenant AND (`;
      const vals = kodecustomer.split(',').map(s => s.trim()).filter(Boolean);
      sql += vals.map(() => 'kodecustomer LIKE ?').join(' OR ');
      sql += '))';
      vals.forEach(v => params.push(`%${v}%`));
    }
    if (namacustomer) {
      sql += ` AND j.idcustomer IN (SELECT idcustomer FROM customer WHERE idtenant = b.idtenant AND (`;
      const vals = namacustomer.split(',').map(s => s.trim()).filter(Boolean);
      sql += vals.map(() => 'namacustomer LIKE ?').join(' OR ');
      sql += '))';
      vals.forEach(v => params.push(`%${v}%`));
    }
    if (statusLunas === 'lunas') {
      sql += ' AND kp.sisa <= 0';
    } else if (statusLunas === 'belum') {
      sql += ' AND (kp.sisa > 0 OR kp.sisa IS NULL)';
    }
    sql += ' GROUP BY b.idbarang, b.kodebarang, b.namabarang, b.satuankecil ORDER BY total_nilai DESC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const grandTotal = rows.reduce((sum, r) => sum + parseFloat(r.total_nilai || 0), 0);
    res.json({ data: rows, grandTotal });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/pembelian — Laporan daftar transaksi pembelian
exports.pembelian = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idsupplier } = req.query;
    const format = req.query.format || 'json';

    let sql = `SELECT b.*, s.namasupplier FROM beli b
      LEFT JOIN supplier s ON b.idsupplier = s.idsupplier AND s.idtenant = b.idtenant
      WHERE 1=1 and b.status IN ('APPROVED', 'CONFIRMED')`;
    const params = [];
    if (ctx.idlokasi) { sql += ' AND b.idlokasi = ?'; params.push(ctx.idlokasi); }
    if (tglwal) { sql += ' AND b.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND b.tgltrans <= ?'; params.push(tglakhir); }
    if (idsupplier) {
      const { clause, params: p } = multiIdIn('b.idsupplier', idsupplier);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    sql += ' ORDER BY b.tgltrans DESC, b.idbeli DESC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const totalPembelian = rows.reduce((sum, r) => sum + parseFloat(r.grandtotal || 0), 0);

    if (format === 'html') {
      // Ambil detail item per transaksi pembelian
      let sqlDetail = `
        SELECT b.idbeli, b.kodebeli, b.tgltrans, b.grandtotal, b.bayar, b.status,
          s.kodesupplier, s.namasupplier,
          l.namalokasi,
          bg.kodebarang, bg.namabarang, bg.satuankecil as satuan,
          bd.idbeli as bd_idbeli, bd.jml, bd.harga, bd.ppn, bd.subtotal
        FROM beli b
          LEFT JOIN supplier s ON b.idsupplier = s.idsupplier AND s.idtenant = b.idtenant
          LEFT JOIN lokasi l ON b.idlokasi = l.idlokasi AND l.idtenant = b.idtenant
          LEFT JOIN belidtl bd ON b.idbeli = bd.idbeli AND bd.idtenant = b.idtenant
          LEFT JOIN barang bg ON bd.idbarang = bg.idbarang AND bg.idtenant = b.idtenant
        WHERE b.status IN ('APPROVED', 'CONFIRMED')`;
      const detailParams = [];
      if (ctx.idlokasi) { sqlDetail += ' AND b.idlokasi = ?'; detailParams.push(ctx.idlokasi); }
      if (tglwal) { sqlDetail += ' AND b.tgltrans >= ?'; detailParams.push(tglwal); }
      if (tglakhir) { sqlDetail += ' AND b.tgltrans <= ?'; detailParams.push(tglakhir); }
      if (idsupplier) {
        const { clause, params: p } = multiIdIn('b.idsupplier', idsupplier);
        if (clause) { sqlDetail += ' AND ' + clause; detailParams.push(...p); }
      }
      sqlDetail += ' ORDER BY b.tgltrans DESC, b.idbeli DESC, bd.idbelidtl ASC';

      const detailRows = await tenantQuery(withPreviewLimit(req, sqlDetail), detailParams);

      // Kelompokkan item ke dalam transaksi masing-masing
      const transactions = [];
      let currentKode = null;
      let currentGroup = null;
      for (const row of detailRows) {
        if (row.kodebeli !== currentKode) {
          currentKode = row.kodebeli;
          const sisa = parseFloat(row.grandtotal || 0) - parseFloat(row.bayar || 0);
          currentGroup = {
            kodebeli    : row.kodebeli,
            tgltrans    : row.tgltrans,
            namalokasi  : row.namalokasi,
            kodesupplier: row.kodesupplier,
            namasupplier: row.namasupplier,
            grandtotal  : parseFloat(row.grandtotal) || 0,
            bayar       : parseFloat(row.bayar) || 0,
            sisa        : sisa,
            statusLunas : sisa <= 0 ? 'LUNAS' : 'Belum Lunas',
            items       : []
          };
          transactions.push(currentGroup);
        }
        if (row.kodebarang) {
          currentGroup.items.push({
            kodebarang: row.kodebarang,
            namabarang: row.namabarang,
            jml       : row.jml,
            satuan    : row.satuan,
            harga     : parseFloat(row.harga) || 0,
            ppn       : parseFloat(row.ppn) || 0,
            subtotal  : parseFloat(row.subtotal) || 0
          });
        }
      }

      const totalTransaksi = transactions.length;
      let sqlTenant4 = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenant4, [ctx.idtenant]);
      const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);
      return res.render('laporan_pembelian', {
        transactions, totalTransaksi, totalPembelian,
        tglwal  : tglwal || '-',   tglakhir: tglakhir || '-',
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat  : lokasi?.alamat || '', hp: lokasi?.hp || '', logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: rows, totalPembelian });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/sales-per-lokasi — Laporan penjualan dikelompokkan per lokasi/cabang
exports.salesPerLokasi = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, kodelokasi, namalokasi, kodecustomer, namacustomer, statusLunas } = req.query;
    const format = req.query.format || 'json';

    if (format === 'html') {
      // Query detail-level per item penjualan untuk HTML grouping
      let sqlDetail = `
      SELECT l.idlokasi, l.kodelokasi, l.namalokasi,
        j.kodejual, j.tgltrans, c.namacustomer, j.grandtotal, j.jenistransaksi AS jenis, kp.sisa,
        b.kodebarang, b.namabarang, jd.jml, jd.satuan, jd.harga, jd.ppn, jd.subtotal
      FROM lokasi l
        JOIN jual j ON l.idlokasi = j.idlokasi AND j.idtenant = l.idtenant AND j.status IN ('APPROVED', 'CONFIRMED')
        JOIN jualdtl jd ON j.idjual = jd.idjual AND jd.idtenant = j.idtenant
        JOIN barang b ON b.idbarang = jd.idbarang AND b.idtenant = j.idtenant
        LEFT JOIN customer c ON j.idcustomer = c.idcustomer AND c.idtenant = j.idtenant
        LEFT JOIN kartupiutang kp ON kp.kodetrans = j.kodejual AND kp.jenis = 'JUAL'
      WHERE l.idtenant = ?`;
      const detailParams = [ctx.idtenant];

      if (tglwal) { sqlDetail += ' AND j.tgltrans >= ?'; detailParams.push(tglwal); }
      if (tglakhir) { sqlDetail += ' AND j.tgltrans <= ?'; detailParams.push(tglakhir); }
      if (kodelokasi) {
        const { clause, params: p } = multiLike('l.kodelokasi', kodelokasi);
        if (clause) { sqlDetail += ' AND ' + clause; detailParams.push(...p); }
      }
      if (namalokasi) {
        const { clause, params: p } = multiLike('l.namalokasi', namalokasi);
        if (clause) { sqlDetail += ' AND ' + clause; detailParams.push(...p); }
      }
      if (kodecustomer) {
        sqlDetail += ` AND j.idcustomer IN (SELECT idcustomer FROM customer WHERE idtenant = l.idtenant AND (`;
        const vals = kodecustomer.split(',').map(s => s.trim()).filter(Boolean);
        sqlDetail += vals.map(() => 'kodecustomer LIKE ?').join(' OR ');
        sqlDetail += '))';
        vals.forEach(v => detailParams.push(`%${v}%`));
      }
      if (namacustomer) {
        sqlDetail += ` AND j.idcustomer IN (SELECT idcustomer FROM customer WHERE idtenant = l.idtenant AND (`;
        const vals = namacustomer.split(',').map(s => s.trim()).filter(Boolean);
        sqlDetail += vals.map(() => 'namacustomer LIKE ?').join(' OR ');
        sqlDetail += '))';
        vals.forEach(v => detailParams.push(`%${v}%`));
      }
      if (statusLunas === 'lunas') {
        sqlDetail += ' AND kp.sisa <= 0';
      } else if (statusLunas === 'belum') {
        sqlDetail += ' AND (kp.sisa > 0 OR kp.sisa IS NULL)';
      }
      sqlDetail += ' ORDER BY l.namalokasi ASC, j.tgltrans DESC, j.kodejual DESC, jd.idjualdtl ASC';

      const detailRows = await tenantQuery(withPreviewLimit(req, sqlDetail), detailParams);

      // Grouping item ke dalam transaksi
      const transactions = [];
      let currentKode = null;
      let currentGroup = null;
      for (const row of detailRows) {
        if (row.kodejual !== currentKode) {
          currentKode = row.kodejual;
          const sisaVal = parseFloat(row.sisa) || 0;
          currentGroup = {
            kodejual    : row.kodejual,
            tgltrans    : row.tgltrans,
            namalokasi  : row.namalokasi,
            kodelokasi  : row.kodelokasi,
            namacustomer: row.namacustomer,
            grandtotal  : parseFloat(row.grandtotal) || 0,
            jenis       : row.jenis,
            sisa        : sisaVal,
            statusLunas : sisaVal <= 0 ? 'LUNAS' : 'Belum Lunas',
            items       : []
          };
          transactions.push(currentGroup);
        }
        currentGroup.items.push({
          kodebarang: row.kodebarang,
          namabarang: row.namabarang,
          jml       : row.jml,
          satuan    : row.satuan,
          harga     : parseFloat(row.harga) || 0,
          ppn       : parseFloat(row.ppn) || 0,
          subtotal  : parseFloat(row.subtotal) || 0
        });
      }

      const grandTotal = transactions.reduce((sum, t) => sum + t.grandtotal, 0);

      let sqlTenant5 = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenant5, [ctx.idtenant]);
      return res.render('laporan_sales_per_lokasi', {
        transactions,
        grandTotal,
        tglwal      : tglwal || '-',                     tglakhir    : tglakhir || '-',
        statusLunas : statusLunas || '',
        kodelokasi  : kodelokasi || '',                  namalokasi  : namalokasi || '',
        kodecustomer: kodecustomer || '',                namacustomer: namacustomer || '',
        namatoko    : tenant?.namatenant || 'Grfyn POS',
        alamat      : '',                                hp          : '',                 logo: tenant?.logo || '',
        tglcetak    : new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    // JSON: tetap gunakan query agregasi
    let sql = `
    SELECT l.idlokasi, l.kodelokasi, l.namalokasi,
      COUNT(DISTINCT j.kodejual) as total_transaksi,
      COALESCE(SUM(j.grandtotal), 0) as total_penjualan,
      COALESCE(SUM(CASE WHEN kp.sisa <= 0 OR kp.sisa IS NULL THEN j.grandtotal ELSE 0 END), 0) as total_lunas,
      COALESCE(SUM(CASE WHEN kp.sisa > 0 THEN kp.sisa ELSE 0 END), 0) as total_piutang
    FROM lokasi l
      LEFT JOIN jual j ON l.idlokasi = j.idlokasi AND j.idtenant = l.idtenant AND j.status IN ('APPROVED', 'CONFIRMED')
      LEFT JOIN kartupiutang kp ON kp.kodetrans = j.kodejual AND kp.jenis = 'JUAL'
    WHERE l.idtenant = ?`;
    const params = [ctx.idtenant];

    if (tglwal) { sql += ' AND j.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND j.tgltrans <= ?'; params.push(tglakhir); }
    if (kodelokasi) {
      const { clause, params: p } = multiLike('l.kodelokasi', kodelokasi);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (namalokasi) {
      const { clause, params: p } = multiLike('l.namalokasi', namalokasi);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (kodecustomer) {
      sql += ` AND j.idcustomer IN (SELECT idcustomer FROM customer WHERE idtenant = l.idtenant AND (`;
      const vals = kodecustomer.split(',').map(s => s.trim()).filter(Boolean);
      sql += vals.map(() => 'kodecustomer LIKE ?').join(' OR ');
      sql += '))';
      vals.forEach(v => params.push(`%${v}%`));
    }
    if (namacustomer) {
      sql += ` AND j.idcustomer IN (SELECT idcustomer FROM customer WHERE idtenant = l.idtenant AND (`;
      const vals = namacustomer.split(',').map(s => s.trim()).filter(Boolean);
      sql += vals.map(() => 'namacustomer LIKE ?').join(' OR ');
      sql += '))';
      vals.forEach(v => params.push(`%${v}%`));
    }
    if (statusLunas === 'lunas') {
      sql += ' AND kp.sisa <= 0';
    } else if (statusLunas === 'belum') {
      sql += ' AND (kp.sisa > 0 OR kp.sisa IS NULL)';
    }
    sql += ' GROUP BY l.idlokasi, l.kodelokasi, l.namalokasi ORDER BY total_penjualan DESC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const grandTotal = rows.reduce((sum, r) => sum + parseFloat(r.total_penjualan || 0), 0);
    res.json({ data: rows, grandTotal });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/pembelian-per-supplier — Laporan pembelian dikelompokkan per supplier
exports.pembelianPerSupplier = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idsupplier } = req.query;
    const format = req.query.format || 'json';

    let sql = `
      SELECT s.idsupplier, s.kodesupplier, s.namasupplier,
        COUNT(b.idbeli) as total_transaksi,
        COALESCE(SUM(b.grandtotal), 0) as total_pembelian
      FROM supplier s
      LEFT JOIN beli b ON s.idsupplier = b.idsupplier AND b.idtenant = s.idtenant AND b.status IN ('APPROVED', 'CONFIRMED')`;
    const params = [];
    if (ctx.idlokasi) { sql += ' AND b.idlokasi = ?'; params.push(ctx.idlokasi); }
    if (tglwal) { sql += ' AND b.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND b.tgltrans <= ?'; params.push(tglakhir); }
    sql += ' WHERE s.idtenant = ?';
    params.push(ctx.idtenant);
    if (idsupplier) {
      const { clause, params: p } = multiIdIn('s.idsupplier', idsupplier);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    sql += ' GROUP BY s.idsupplier, s.kodesupplier, s.namasupplier ORDER BY total_pembelian DESC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const grandTotal = rows.reduce((sum, r) => sum + parseFloat(r.total_pembelian || 0), 0);

    if (format === 'html') {
      // Query detail-level per transaksi beli untuk HTML grouping per supplier
      let sqlDetail = `SELECT s.idsupplier, s.kodesupplier, s.namasupplier,
        b.kodebeli, b.tgltrans, l.namalokasi,
        bg.kodebarang, bg.namabarang, bg.satuankecil as satuan,
        bd.jml, bd.harga, bd.ppn, bd.subtotal, b.grandtotal, b.bayar
        FROM supplier s
          JOIN beli b ON s.idsupplier = b.idsupplier AND b.idtenant = s.idtenant AND b.status IN ('APPROVED', 'CONFIRMED')
          JOIN belidtl bd ON b.idbeli = bd.idbeli AND bd.idtenant = b.idtenant
          JOIN barang bg ON bd.idbarang = bg.idbarang AND bg.idtenant = b.idtenant
          JOIN lokasi l ON b.idlokasi = l.idlokasi AND l.idtenant = b.idtenant
        WHERE s.idtenant = ?`;
      const detailParams = [ctx.idtenant];
      if (ctx.idlokasi) { sqlDetail += ' AND b.idlokasi = ?'; detailParams.push(ctx.idlokasi); }
      if (tglwal) { sqlDetail += ' AND b.tgltrans >= ?'; detailParams.push(tglwal); }
      if (tglakhir) { sqlDetail += ' AND b.tgltrans <= ?'; detailParams.push(tglakhir); }
      if (idsupplier) {
        const { clause, params: p } = multiIdIn('s.idsupplier', idsupplier);
        if (clause) { sqlDetail += ' AND ' + clause; detailParams.push(...p); }
      }
      sqlDetail += ' ORDER BY s.namasupplier ASC, b.tgltrans DESC, b.kodebeli DESC, bd.idbelidtl ASC';

      const detailRows = await tenantQuery(withPreviewLimit(req, sqlDetail), detailParams);
      const grandTotal = detailRows.reduce((sum, r) => sum + parseFloat(r.grandtotal || 0), 0);

      // Grouping item ke dalam transaksi masing-masing
      const transactions = [];
      let currentKode = null;
      let currentGroup = null;
      for (const row of detailRows) {
        if (row.kodebeli !== currentKode) {
          currentKode = row.kodebeli;
          const sisa = parseFloat(row.grandtotal || 0) - parseFloat(row.bayar || 0);
          currentGroup = {
            kodebeli    : row.kodebeli,
            tgltrans    : row.tgltrans,
            namalokasi  : row.namalokasi,
            kodesupplier: row.kodesupplier,
            namasupplier: row.namasupplier,
            grandtotal  : parseFloat(row.grandtotal) || 0,
            bayar       : parseFloat(row.bayar) || 0,
            sisa        : sisa,
            statusLunas : sisa <= 0 ? 'LUNAS' : 'Belum Lunas',
            items       : []
          };
          transactions.push(currentGroup);
        }
        currentGroup.items.push({
          kodebarang: row.kodebarang,
          namabarang: row.namabarang,
          jml       : row.jml,
          satuan    : row.satuan,
          harga     : parseFloat(row.harga) || 0,
          ppn       : parseFloat(row.ppn) || 0,
          subtotal  : parseFloat(row.subtotal) || 0
        });
      }

      let sqlTenant6 = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenant6, [ctx.idtenant]);
      return res.render('laporan_pembelian_per_supplier', {
        transactions, grandTotal,
        tglwal: tglwal || '-', tglakhir: tglakhir || '-',
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: '', hp: '', logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: rows, grandTotal });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/pembelian-per-lokasi — Laporan pembelian dikelompokkan per lokasi/cabang
exports.pembelianPerLokasi = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir } = req.query;
    const format = req.query.format || 'json';

    if (format === 'html') {
      // Query detail-level per item pembelian untuk HTML grouping
      let sqlDetail = `SELECT l.idlokasi, l.kodelokasi, l.namalokasi,
        bl.kodebeli, bl.tgltrans, s.namasupplier, bl.grandtotal, bl.bayar,
        bg.kodebarang, bg.namabarang, bg.satuankecil as satuan,
        bd.jml, bd.harga, bd.ppn, bd.subtotal
        FROM lokasi l
        JOIN beli bl ON l.idlokasi = bl.idlokasi AND bl.idtenant = l.idtenant AND bl.status IN ('APPROVED', 'CONFIRMED')
        JOIN belidtl bd ON bl.idbeli = bd.idbeli AND bd.idtenant = bl.idtenant
        JOIN barang bg ON bd.idbarang = bg.idbarang AND bg.idtenant = bl.idtenant
        LEFT JOIN supplier s ON bl.idsupplier = s.idsupplier AND s.idtenant = bl.idtenant
        WHERE l.idtenant = ?`;
      const detailParams = [ctx.idtenant];
      if (tglwal) { sqlDetail += ' AND bl.tgltrans >= ?'; detailParams.push(tglwal); }
      if (tglakhir) { sqlDetail += ' AND bl.tgltrans <= ?'; detailParams.push(tglakhir); }
      sqlDetail += ' ORDER BY l.namalokasi ASC, bl.tgltrans DESC, bl.kodebeli DESC, bd.idbelidtl ASC';

      const detailRows = await tenantQuery(withPreviewLimit(req, sqlDetail), detailParams);

      // Grouping item ke dalam transaksi
      const transactions = [];
      let currentKode = null;
      let currentGroup = null;
      for (const row of detailRows) {
        if (row.kodebeli !== currentKode) {
          currentKode = row.kodebeli;
          const sisa = parseFloat(row.grandtotal || 0) - parseFloat(row.bayar || 0);
          currentGroup = {
            kodebeli    : row.kodebeli,
            tgltrans    : row.tgltrans,
            kodelokasi  : row.kodelokasi,
            namalokasi  : row.namalokasi,
            namasupplier: row.namasupplier,
            grandtotal  : parseFloat(row.grandtotal) || 0,
            bayar       : parseFloat(row.bayar) || 0,
            sisa        : sisa,
            statusLunas : sisa <= 0 ? 'LUNAS' : 'Belum Lunas',
            items       : []
          };
          transactions.push(currentGroup);
        }
        currentGroup.items.push({
          kodebarang: row.kodebarang,
          namabarang: row.namabarang,
          jml       : row.jml,
          satuan    : row.satuan,
          harga     : parseFloat(row.harga) || 0,
          ppn       : parseFloat(row.ppn) || 0,
          subtotal  : parseFloat(row.subtotal) || 0
        });
      }

      const grandTotal = transactions.reduce((sum, t) => sum + t.grandtotal, 0);

      let sqlTenant7 = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenant7, [ctx.idtenant]);
      return res.render('laporan_pembelian_per_lokasi', {
        transactions, grandTotal,
        tglwal: tglwal || '-', tglakhir: tglakhir || '-',
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: '', hp: '', logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    // JSON: tetap gunakan query agregasi
    let sql = `SELECT l.idlokasi, l.kodelokasi, l.namalokasi,
      COUNT(b.idbeli) as total_transaksi,
      COALESCE(SUM(b.grandtotal), 0) as total_pembelian
      FROM lokasi l
      LEFT JOIN beli b ON l.idlokasi = b.idlokasi AND b.idtenant = l.idtenant AND b.status IN ('APPROVED', 'CONFIRMED')`;
    const params = [];
    if (tglwal) { sql += ' AND b.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND b.tgltrans <= ?'; params.push(tglakhir); }
    sql += ' WHERE l.idtenant = ? GROUP BY l.idlokasi, l.kodelokasi, l.namalokasi ORDER BY total_pembelian DESC';
    params.push(ctx.idtenant);

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const grandTotal = rows.reduce((sum, r) => sum + parseFloat(r.total_pembelian || 0), 0);
    res.json({ data: rows, grandTotal });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/pembelian-per-barang — Laporan pembelian dikelompokkan per barang
exports.pembelianPerBarang = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idbarang } = req.query;
    const format = req.query.format || 'json';

    if (format === 'html') {
      // Query detail-level untuk HTML grouping view
      let sqlDetail = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil as satuan,
        bl.kodebeli, bl.tgltrans, s.namasupplier,
        bd.jml, bd.harga, bd.subtotal
        FROM barang b
        JOIN belidtl bd ON b.idbarang = bd.idbarang AND b.idtenant = bd.idtenant
        JOIN beli bl ON bd.idbeli = bl.idbeli AND bl.idtenant = bd.idtenant AND bl.status IN ('APPROVED', 'CONFIRMED')
        LEFT JOIN supplier s ON bl.idsupplier = s.idsupplier AND s.idtenant = bl.idtenant`;
      const detailParams = [];
      if (ctx.idlokasi) { sqlDetail += ' AND bl.idlokasi = ?'; detailParams.push(ctx.idlokasi); }
      const detailConds = [];
      if (tglwal) { detailConds.push('bl.tgltrans >= ?'); detailParams.push(tglwal); }
      if (tglakhir) { detailConds.push('bl.tgltrans <= ?'); detailParams.push(tglakhir); }
      if (idbarang) {
        const { clause, params: p } = multiIdIn('b.idbarang', idbarang);
        if (clause) { detailConds.push(clause); detailParams.push(...p); }
      }
      if (detailConds.length) sqlDetail += ' AND ' + detailConds.join(' AND ');
      sqlDetail += ' ORDER BY b.namabarang ASC, bl.tgltrans DESC';

      const detailRows = await tenantQuery(withPreviewLimit(req, sqlDetail), detailParams);
      const grandTotal = detailRows.reduce((sum, r) => sum + parseFloat(r.subtotal || 0), 0);

      let sqlTenant8 = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenant8, [ctx.idtenant]);
      return res.render('laporan_pembelian_per_barang', {
        data    : detailRows,                        grandTotal,
        tglwal  : tglwal || '-',                     tglakhir  : tglakhir || '-',
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat  : '',                                hp        : '',              logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    // JSON: tetap gunakan query agregasi
    let sql = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil as satuan,
      COALESCE(SUM(bd.jml), 0) as total_qty,
      COALESCE(SUM(bd.subtotal), 0) as total_nilai
      FROM barang b
      LEFT JOIN belidtl bd ON b.idbarang = bd.idbarang AND b.idtenant = bd.idtenant
      LEFT JOIN beli bl ON bd.idbeli = bl.idbeli AND bl.idtenant = bd.idtenant AND bl.status IN ('APPROVED', 'CONFIRMED')`;
    const params = [];
    if (ctx.idlokasi) { sql += ' AND bl.idlokasi = ?'; params.push(ctx.idlokasi); }
    const conditions = [];
    if (tglwal) { conditions.push('bl.tgltrans >= ?'); params.push(tglwal); }
    if (tglakhir) { conditions.push('bl.tgltrans <= ?'); params.push(tglakhir); }
    if (idbarang) {
      const { clause, params: p } = multiIdIn('b.idbarang', idbarang);
      if (clause) { conditions.push(clause); params.push(...p); }
    }
    if (conditions.length > 0) { sql += ' WHERE ' + conditions.join(' AND '); }
    sql += ' GROUP BY b.idbarang, b.kodebarang, b.namabarang, b.satuankecil ORDER BY total_nilai DESC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const grandTotal = rows.reduce((sum, r) => sum + parseFloat(r.total_nilai || 0), 0);
    res.json({ data: rows, grandTotal });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/pembelian-rekap — Rekap pembelian (total transaksi, total pembelian, total dibayar, total hutang)
exports.pembelianRekap = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idsupplier } = req.query;

    let sql = `SELECT
      COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as total_transaksi,
      COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN grandtotal ELSE 0 END), 0) as total_pembelian,
      COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN bayar ELSE 0 END), 0) as total_dibayar,
      COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN GREATEST(grandtotal - bayar, 0) ELSE 0 END), 0) as total_hutang
      FROM beli WHERE idlokasi = ?`;
    const params = [ctx.idlokasi];
    if (tglwal) { sql += ' AND tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND tgltrans <= ?'; params.push(tglakhir); }
    if (idsupplier) {
      const { clause, params: p } = multiIdIn('idsupplier', idsupplier);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);

    if (req.query.format === 'html') {
      let sqlTenant9 = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenant9, [ctx.idtenant]);
      return res.render('laporan_pembelian_rekap', {
        data: rows[0],
        tglwal: tglwal || '-', tglakhir: tglakhir || '-',
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: '', hp: '', logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json(rows[0]);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/stok — Laporan stok terkini per barang
exports.stok = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tgl } = req.query;
    const format = req.query.format || 'json';

    // Cari saldo stok snapshot terbaru
    let sqlSaldo = "SELECT idsaldostok, kodesaldostok, tgltrans FROM saldostok WHERE idtenant = ? AND idlokasi = ? AND status IN ('APPROVED', 'AKTIF') ORDER BY tgltrans DESC, idsaldostok DESC LIMIT 1";
    const [[latestSaldo]] = await pool.query(
      sqlSaldo,
      [ctx.idtenant, ctx.idlokasi]
    );

    let sql;
    const params = [];

    // Jika ada snapshot: stok = saldo snapshot + mutasi masuk - mutasi keluar setelahnya
    if (latestSaldo) {
      sql = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil as satuan, b.stokmin,
        COALESCE(sd.qty, 0) + COALESCE(km.masuk, 0) - COALESCE(km.keluar, 0) as stok
        FROM barang b
        LEFT JOIN saldostokdtl sd ON sd.idbarang = b.idbarang AND sd.idsaldostok = ?
        LEFT JOIN (
          SELECT idbarang,
            COALESCE(SUM(CASE WHEN jenis = 'M' THEN jml ELSE 0 END), 0) as masuk,
            COALESCE(SUM(CASE WHEN jenis = 'K' THEN jml ELSE 0 END), 0) as keluar
          FROM kartustok WHERE idtenant = ? AND idlokasi = ? AND tgltrans > ? GROUP BY idbarang
        ) km ON km.idbarang = b.idbarang
        WHERE b.status = 'AKTIF' ORDER BY b.namabarang`;
      params.push(latestSaldo.idsaldostok, ctx.idtenant, ctx.idlokasi, latestSaldo.tgltrans);
    // Jika tidak ada snapshot: stok langsung dari kartustok (masuk - keluar)
    } else {
      sql = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil as satuan, b.stokmin,
        COALESCE(m.total, 0) - COALESCE(k.total, 0) as stok
        FROM barang b
        LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'M' AND idtenant = ? AND idlokasi = ? GROUP BY idbarang) m ON b.idbarang = m.idbarang
        LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'K' AND idtenant = ? AND idlokasi = ? GROUP BY idbarang) k ON b.idbarang = k.idbarang
        WHERE b.status = 'AKTIF' ORDER BY b.namabarang`;
      params.push(ctx.idtenant, ctx.idlokasi, ctx.idtenant, ctx.idlokasi);
    }

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const totalBarang = rows.length;
    const totalStok = rows.reduce((sum, r) => sum + (parseInt(r.stok) || 0), 0);

    if (format === 'html') {
      let sqlTenantStok = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenantStok, [ctx.idtenant]);
      return res.render('laporan_stok', {
        data: rows, totalBarang, totalStok,
        periodSaldo: latestSaldo ? latestSaldo.tgltrans : '-',
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: '', hp: '', logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: rows, totalBarang, totalStok, periodSaldo: latestSaldo?.tgltrans });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/kartu-stok — Laporan mutasi stok (kartu stok) per barang
exports.kartuStok = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { idbarang, tglwal, tglakhir, jenistransaksi, jenisref, idlokasi } = req.query;
    const format = req.query.format || 'json';
    const selectedBarangFilter = idbarang ? multiIdIn('ks.idbarang', idbarang) : null;
    const selectedLokasiFilter = idlokasi ? multiIdIn('ks.idlokasi', idlokasi) : null;

    let sql = `SELECT ks.*, b.kodebarang, b.namabarang, b.satuankecil as satuan, l.namalokasi
      FROM kartustok ks
      LEFT JOIN barang b ON ks.idbarang = b.idbarang AND b.idtenant = ks.idtenant
      LEFT JOIN lokasi l ON l.idlokasi = ks.idlokasi AND l.idtenant = ks.idtenant
      WHERE 1=1`;
    const params = [];
    sql += ' AND ks.idtenant = ?'; params.push(ctx.idtenant);
    if (selectedLokasiFilter?.clause) {
      sql += ` AND ${selectedLokasiFilter.clause}`;
      params.push(...selectedLokasiFilter.params);
    }
    if (selectedBarangFilter?.clause) {
      sql += ` AND ${selectedBarangFilter.clause}`;
      params.push(...selectedBarangFilter.params);
    }
    if (tglwal) { sql += ' AND ks.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND ks.tgltrans <= ?'; params.push(tglakhir); }
    const jenisFilter = jenistransaksi || jenisref;
    if (jenisFilter) {
      const vals = jenisFilter.split(',').map(s => s.trim()).filter(Boolean);
      if (vals.length) {
        sql += ` AND ks.jenistransaksi IN (${vals.map(() => '?').join(',')})`;
        params.push(...vals);
      }
    }
    sql += ' ORDER BY b.namabarang ASC, ks.tgltrans ASC, ks.idkartustok ASC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const selectedBarangIds = idbarang ? idbarang.split(',').map(s => s.trim()).filter(Boolean) : [];
    const barangIds = [...new Set([...selectedBarangIds, ...rows.map(row => String(row.idbarang))])];
    let latestSaldo = null;
    let saldoAwalByBarang = {};
    let barangById = {};
    const lokasiFilterIds = idlokasi ? idlokasi.split(',').map(s => s.trim()).filter(Boolean) : [];
    const lokasiWhere = lokasiFilterIds.length ? ` AND idlokasi IN (${lokasiFilterIds.map(() => '?').join(',')})` : '';
    const [lokasiRows] = await pool.query(
      `SELECT idlokasi, namalokasi FROM lokasi WHERE idtenant = ?${lokasiWhere} ORDER BY namalokasi`,
      [ctx.idtenant, ...lokasiFilterIds]
    );
    const namalokasiReport = lokasiRows.map(l => l.namalokasi).join(', ') || '-';

    const [[latestSaldoRow]] = await pool.query(
      `SELECT idsaldostok, tgltrans
       FROM saldostok
       WHERE idtenant = ?${lokasiWhere} AND status IN ('APPROVED', 'AKTIF')
       ORDER BY tgltrans DESC, idsaldostok DESC
       LIMIT 1`,
      [ctx.idtenant, ...lokasiFilterIds]
    );
    latestSaldo = latestSaldoRow || null;

    if (barangIds.length) {
      const barangPlaceholders = barangIds.map(() => '?').join(',');
      const barangRows = await tenantQuery(
        `SELECT idbarang, kodebarang, namabarang, satuankecil as satuan
         FROM barang
         WHERE idbarang IN (${barangPlaceholders})
         ORDER BY namabarang`,
        barangIds
      );
      barangById = barangRows.reduce((acc, row) => {
        acc[String(row.idbarang)] = row;
        return acc;
      }, {});

      if (latestSaldo) {
        const saldoRows = await tenantQuery(
          `SELECT idbarang, qty
           FROM saldostokdtl
           WHERE idsaldostok = ? AND idbarang IN (${barangPlaceholders})`,
          [latestSaldo.idsaldostok, ...barangIds]
        );
        saldoAwalByBarang = saldoRows.reduce((acc, row) => {
          acc[String(row.idbarang)] = parseFloat(row.qty || 0);
          return acc;
        }, {});
      }
    }

    const groupedMap = new Map();
    for (const id of barangIds) {
      const barang = barangById[String(id)] || rows.find(row => String(row.idbarang) === String(id)) || {};
      groupedMap.set(String(id), {
        idbarang: id,
        kodebarang: barang.kodebarang || '',
        namabarang: barang.namabarang || '-',
        satuan: barang.satuan || '',
        saldoAwal: saldoAwalByBarang[String(id)] || 0,
        rows: []
      });
    }
    for (const row of rows) {
      const key = String(row.idbarang);
      if (!groupedMap.has(key)) {
        groupedMap.set(key, {
          idbarang: row.idbarang,
          kodebarang: row.kodebarang || '',
          namabarang: row.namabarang || '-',
          satuan: row.satuan || '',
          saldoAwal: saldoAwalByBarang[key] || 0,
          rows: []
        });
      }
      groupedMap.get(key).rows.push(row);
    }
    const groupedData = Array.from(groupedMap.values()).sort((a, b) => a.namabarang.localeCompare(b.namabarang));

    if (format === 'html') {
      let sqlTenantKartu = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenantKartu, [ctx.idtenant]);
      return res.render('laporan_kartu_stok', {
        data: rows,
        groupedData,
        periodSaldo: latestSaldo ? latestSaldo.tgltrans : '-',
        namalokasi: namalokasiReport,
        tglwal: tglwal || '-', tglakhir: tglakhir || '-',
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: '', hp: '', logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: rows, groupedData, periodSaldo: latestSaldo?.tgltrans || null, namalokasi: namalokasiReport });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function sendSimpleStokReport(res, title, rows, meta) {
  const grouped = [];
  const map = new Map();
  for (const row of rows) {
    const key = row.kode || '-';
    if (!map.has(key)) {
      const trx = {
        kode: row.kode,
        tgltrans: row.tgltrans,
        lokasi: row.lokasi,
        lokasi_tujuan: row.lokasi_tujuan,
        status: row.status,
        items: [],
      };
      map.set(key, trx);
      grouped.push(trx);
    }
    map.get(key).items.push(row);
  }

  let no = 0;
  const bodyRows = grouped.map((trx) => {
    no += 1;
    const rowspan = Math.max(trx.items.length, 1);
    return trx.items.map((item, idx) => `
      <tr>
        ${idx === 0 ? `<td class="center rs" rowspan="${rowspan}">${no}</td>
        <td class="rs" rowspan="${rowspan}">${escapeHtml(trx.kode || '')}</td>
        <td class="center rs" rowspan="${rowspan}">${escapeHtml(String(trx.tgltrans || '').slice(0, 10))}</td>
        <td class="rs" rowspan="${rowspan}">${escapeHtml(trx.lokasi || '-')}</td>
        ${meta.showTujuan ? `<td class="rs" rowspan="${rowspan}">${escapeHtml(trx.lokasi_tujuan || '-')}</td>` : ''}
        <td class="center rs" rowspan="${rowspan}"><span class="status-badge ${trx.status === 'APPROVED' ? 'approved' : trx.status === 'CANCELLED' ? 'cancelled' : 'draft'}">${escapeHtml(trx.status || '')}</span></td>` : ''}
        <td class="center item">${escapeHtml(item.kodebarang || '')}</td>
        <td class="item">${escapeHtml(item.namabarang || '')}</td>
        <td class="right item">${Number(item.jml || 0).toLocaleString('id-ID')}</td>
        <td class="center item">${escapeHtml(item.satuan || '')}</td>
      </tr>`).join('');
  }).join('');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <link rel="stylesheet" href="/reports/laporan_style.css">
    <style>
      @media print { .no-print { display:none; } }
      td.rs{vertical-align:top;border-right:1px solid #D7CAC1}
      td.item{border-left:1px solid #D7CAC1}
      table{width:100%;border-collapse:collapse}
      th,td{border:1px solid #D7CAC1;padding:8px;font-size:11px}
      .right{text-align:right}.center{text-align:center}
      .status-badge{display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:700}
      .status-badge.approved{background:#DCFCE7;color:#166534}
      .status-badge.draft{background:#FAF2E0;color:#A07D30}
      .status-badge.cancelled{background:#FEE2E2;color:#991B1B}
    </style></head><body>
    <div class="no-print" style="text-align:right;margin-bottom:10px;">
      <button onclick="window.print()" style="padding:8px 16px;background:#C4683D;color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;">Cetak</button>
    </div>
    <div class="report-header">
      ${meta.logo ? `<img class="logo" src="${escapeHtml(meta.logo)}" alt="Logo">` : ''}
      <h2>${escapeHtml(meta.namatoko || 'Grfyn POS')}</h2>
      <p class="subtitle">${escapeHtml(meta.alamat || '')} ${meta.hp ? `| ${escapeHtml(meta.hp)}` : ''}</p>
      <h3>${escapeHtml(title.toUpperCase())}</h3>
    </div>
    <div class="report-meta">
      <span>Periode: <span class="periode">${escapeHtml(meta.tglwal || '-')} s/d ${escapeHtml(meta.tglakhir || '-')}</span></span>
      <span>Tanggal Cetak: ${escapeHtml(meta.tglcetak || '')}</span>
    </div>
    <table><thead><tr>
      <th class="center">No</th><th>Kode</th><th class="center">Tanggal</th><th>Lokasi</th>${meta.showTujuan ? '<th>Lokasi Tujuan</th>' : ''}
      <th class="center">Status</th><th>Kode Barang</th><th>Nama Barang</th><th class="right">Jumlah</th><th class="center">Satuan</th>
    </tr></thead><tbody>${bodyRows || `<tr><td colspan="${meta.showTujuan ? 10 : 9}" class="center">Tidak ada data</td></tr>`}</tbody>
    <tfoot><tr><td colspan="${meta.showTujuan ? 10 : 9}">TOTAL (${grouped.length} Transaksi)</td></tr></tfoot></table>
    <div class="report-footer"><p>&copy; ${escapeHtml(meta.namatoko || 'Grfyn POS')} - Generated by Grfyn POS</p></div>
    </body></html>`);
}

// GET /api/laporan/stock-opname — Laporan transaksi Opname Stok
exports.stockOpname = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idlokasi, idbarang } = req.query;
    const format = req.query.format || 'json';
    let sql = `SELECT so.tgltrans, so.kodestockopname AS kode, so.status, l.namalokasi AS lokasi,
        b.kodebarang, b.namabarang, b.satuankecil AS satuan, sod.stok_fisik AS jml
      FROM stockopname so
      JOIN stockopnamedtl sod ON sod.idstockopname = so.idstockopname AND sod.idtenant = so.idtenant
      JOIN barang b ON b.idbarang = sod.idbarang AND b.idtenant = so.idtenant
      JOIN lokasi l ON l.idlokasi = so.idlokasi AND l.idtenant = so.idtenant
      WHERE so.idtenant = ?`;
    const params = [ctx.idtenant];
    if (tglwal) { sql += ' AND so.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND so.tgltrans <= ?'; params.push(tglakhir); }
    if (idlokasi) { const r = multiIdIn('so.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (idbarang) { const r = multiIdIn('sod.idbarang', idbarang); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    sql += ' ORDER BY so.tgltrans DESC, so.kodestockopname DESC, b.namabarang ASC';
    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const mapped = rows.map(r => ({ ...r, status: r.status === 'FINALIZED' || r.status === 'AKTIF' ? 'APPROVED' : r.status }));
    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      return sendSimpleStokReport(res, 'Laporan Opname Stok', mapped, {
        tglwal, tglakhir, showTujuan: false,
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: '', hp: '', logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }
    res.json({ data: mapped });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/transfer-stok — Laporan transaksi Transfer Stok
exports.transferStok = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idlokasi, idlokasitujuan, idbarang } = req.query;
    const format = req.query.format || 'json';
    let sql = `SELECT ts.tgltrans, ts.kodetransferstok AS kode, ts.status,
        l1.namalokasi AS lokasi, l2.namalokasi AS lokasi_tujuan,
        b.kodebarang, b.namabarang, COALESCE(tsd.satuan, b.satuankecil) AS satuan, tsd.jml
      FROM transferstok ts
      JOIN transferstokdtl tsd ON tsd.idtransferstok = ts.idtransferstok AND tsd.idtenant = ts.idtenant
      JOIN barang b ON b.idbarang = tsd.idbarang AND b.idtenant = ts.idtenant
      JOIN lokasi l1 ON l1.idlokasi = ts.idlokasi AND l1.idtenant = ts.idtenant
      JOIN lokasi l2 ON l2.idlokasi = ts.idlokasitujuan AND l2.idtenant = ts.idtenant
      WHERE ts.idtenant = ?`;
    const params = [ctx.idtenant];
    if (tglwal) { sql += ' AND ts.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND ts.tgltrans <= ?'; params.push(tglakhir); }
    if (idlokasi) { const r = multiIdIn('ts.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (idlokasitujuan) { const r = multiIdIn('ts.idlokasitujuan', idlokasitujuan); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (idbarang) { const r = multiIdIn('tsd.idbarang', idbarang); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    sql += ' ORDER BY ts.tgltrans DESC, ts.kodetransferstok DESC, b.namabarang ASC';
    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const mapped = rows.map(r => ({ ...r, status: ['DIKIRIM', 'DITERIMA', 'KIRIM', 'TERIMA'].includes(r.status) ? 'APPROVED' : r.status === 'DIBATALKAN' ? 'CANCELLED' : r.status }));
    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      return sendSimpleStokReport(res, 'Laporan Transfer Stok', mapped, {
        tglwal, tglakhir, showTujuan: true,
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: '', hp: '', logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }
    res.json({ data: mapped });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/rekap-sales — Rekap penjualan (per transaksi, dengan status lunas/belum)
exports.rekapSales = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, kodelokasi, namalokasi, kodecustomer, namacustomer, statusLunas } = req.query;
    const format = req.query.format || 'json';

    let sql = `SELECT j.kodejual, j.tgltrans, l.namalokasi,
      c.kodecustomer, c.namacustomer,
      COUNT(jdtl.idjualdtl) AS totalitem,
      j.grandtotal,
      pp.tgltrans AS tglpelunasan, kp.terbayar, kp.sisa
    FROM jual j
    JOIN jualdtl jdtl ON j.idjual = jdtl.idjual AND jdtl.idtenant = j.idtenant
    JOIN lokasi l ON l.idlokasi = j.idlokasi AND l.idtenant = j.idtenant
    JOIN customer c ON c.idcustomer = j.idcustomer AND c.idtenant = j.idtenant
    LEFT JOIN kartupiutang kp ON kp.kodetrans = j.kodejual AND kp.jenis = 'JUAL'
    LEFT JOIN pelunasanpiutangdtl ppdtl ON ppdtl.kodetrans = kp.kodetrans
    LEFT JOIN pelunasanpiutang pp ON pp.idpelunasan = ppdtl.idpelunasan
    WHERE j.status = 'AKTIF'`;
    const params = [];

    if (tglwal) { sql += ' AND j.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND j.tgltrans <= ?'; params.push(tglakhir); }

    if (kodelokasi) {
      const { clause, params: p } = multiLike('l.kodelokasi', kodelokasi);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (namalokasi) {
      const { clause, params: p } = multiLike('l.namalokasi', namalokasi);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (kodecustomer) {
      const { clause, params: p } = multiLike('c.kodecustomer', kodecustomer);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }
    if (namacustomer) {
      const { clause, params: p } = multiLike('c.namacustomer', namacustomer);
      if (clause) { sql += ' AND ' + clause; params.push(...p); }
    }

    if (statusLunas === 'lunas') {
      sql += ' AND kp.sisa <= 0';
    } else if (statusLunas === 'belum') {
      sql += ' AND (kp.sisa > 0 OR kp.sisa IS NULL)';
    }

    sql += ' GROUP BY j.kodejual, j.tgltrans, l.namalokasi, c.kodecustomer, c.namacustomer, j.grandtotal, pp.tgltrans, kp.terbayar, kp.sisa ORDER BY j.tgltrans DESC, j.kodejual DESC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);

    // Proses hasil query: hitung sisa dan status lunas
    const processed = rows.map(r => {
      const sisaVal = parseFloat(r.sisa) || 0;
      return {
        ...r,
        sisa: sisaVal,
        statusLunas: sisaVal === 0 ? 'LUNAS' : 'Belum Lunas',
        totalitem: parseInt(r.totalitem) || 0,
        grandtotal: parseFloat(r.grandtotal) || 0,
        amount: parseFloat(r.amount) || 0
      };
    });

    const totalTransaksi = processed.length;
    const totalPenjualan = processed.reduce((sum, r) => sum + r.grandtotal, 0);
    const totalLunas = processed.filter(r => r.sisa === 0).reduce((sum, r) => sum + r.grandtotal, 0);
    const totalPiutang = processed.reduce((sum, r) => sum + r.sisa, 0);

    if (format === 'html') {
      let sqlTenantRekap = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenantRekap, [ctx.idtenant]);
      let sqlLokasiRekap = 'SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?';
      const [[lokasi]] = await pool.query(sqlLokasiRekap, [ctx.idlokasi, ctx.idtenant]);
      return res.render('laporan_sales_rekap', {
        data: processed,
        totalTransaksi, totalPenjualan, totalLunas, totalPiutang,
        tglwal: tglwal || '-', tglakhir: tglakhir || '-',
        statusLunas: statusLunas || '',
        kodelokasi: kodelokasi || '', namalokasi: namalokasi || '',
        kodecustomer: kodecustomer || '', namacustomer: namacustomer || '',
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: lokasi?.alamat || '',
        hp: lokasi?.hp || '',
        logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: processed, totalTransaksi, totalPenjualan, totalLunas, totalPiutang });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/laporan/struk/:id — Cetak struk penjualan (HTML)
exports.struk = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { id } = req.params;
    const format = req.query.format || 'json';

    const rows = await tenantQuery(
      `SELECT j.*, c.namacustomer, c.alamat as alamatcustomer, u.namauser
       FROM jual j
       LEFT JOIN customer c ON j.idcustomer = c.idcustomer AND c.idtenant = j.idtenant
       LEFT JOIN user u ON j.iduser = u.iduser AND u.idtenant = j.idtenant
       WHERE j.idjual = ? AND j.idlokasi = ?`,
      [id, ctx.idlokasi]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Transaksi tidak ditemukan' });
    const jual = rows[0];

    const detail = await tenantQuery(
      `SELECT jd.*, b.namabarang, b.kodebarang, b.satuankecil as satuan, b.satuankecil
       FROM jualdtl jd
       LEFT JOIN barang b ON jd.idbarang = b.idbarang AND b.idtenant = jd.idtenant
       WHERE jd.idjual = ?`,
      [id]
    );

    if (format === 'html') {
      const subtotal = detail.reduce((sum, item) => sum + (Number(item.harga || 0) * Number(item.jml || 0)), 0);
      const ppn = detail.reduce((sum, item) => sum + Number(item.ppn || 0), 0);
      const totalDiskon = detail.reduce((sum, item) => {
        const harga = Number(item.harga || 0);
        const jml = Number(item.jml || 0);
        const diskon = Number(item.diskon || 0);
        return sum + ((harga * jml * diskon) / 100);
      }, 0);
      let sqlTenantStruk = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenantStruk, [ctx.idtenant]);
      let sqlLokasiStruk = 'SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?';
      const [[lokasi]] = await pool.query(sqlLokasiStruk, [ctx.idlokasi, ctx.idtenant]);
      return res.render('struk', {
        jual, detail,
        ...jual,
        items: detail,
        kasir: jual.namauser,
        subtotal,
        ppn,
        totalDiskon,
        grandtotal: Number(jual.grandtotal || 0),
        bayar: Number(jual.bayar || jual.grandtotal || 0),
        kembali: Math.max(Number(jual.bayar || jual.grandtotal || 0) - Number(jual.grandtotal || 0), 0),
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: lokasi?.alamat || '',
        hp: lokasi?.hp || '',
        logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: jual, detail });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Fase 3 — Endpoint Laporan Baru
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/laporan/sales-order — Laporan Sales Order
exports.salesOrder = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idlokasi, filters } = req.query;
    const format = req.query.format || 'json';

    let sql = `
      SELECT so.kodeso, so.tgltrans, so.grandtotal, so.status,
        c.kodecustomer, c.namacustomer,
        l.namalokasi,
        b.kodebarang, b.namabarang, b.satuankecil AS satuan,
        sd.jml, sd.harga, sd.subtotal
      FROM salesorder so
        JOIN lokasi l ON l.idlokasi = so.idlokasi AND l.idtenant = so.idtenant
        LEFT JOIN customer c ON c.idcustomer = so.idcustomer AND c.idtenant = so.idtenant
        JOIN salesorderdtl sd ON sd.idso = so.idso AND sd.idtenant = so.idtenant
        JOIN barang b ON b.idbarang = sd.idbarang AND b.idtenant = so.idtenant
      WHERE so.idtenant = ?`;
    const params = [ctx.idtenant];
    if (idlokasi) { const r = multiIdIn('so.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (tglwal) { sql += ' AND so.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND so.tgltrans <= ?'; params.push(tglakhir); }
    const af = buildAdvancedFilter(filters);
    if (af.clause) { sql += ' AND ' + af.clause; params.push(...af.params); }
    sql += ' ORDER BY so.tgltrans DESC, so.kodeso DESC, sd.idsodtl ASC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const transactions = [];
    let curKode = null, curGroup = null;
    for (const row of rows) {
      if (row.kodeso !== curKode) {
        curKode = row.kodeso;
        curGroup = { kodeso: row.kodeso, tgltrans: row.tgltrans, namalokasi: row.namalokasi, kodecustomer: row.kodecustomer, namacustomer: row.namacustomer, grandtotal: parseFloat(row.grandtotal) || 0, status: row.status, items: [] };
        transactions.push(curGroup);
      }
      curGroup.items.push({ kodebarang: row.kodebarang, namabarang: row.namabarang, jml: row.jml, satuan: row.satuan, harga: parseFloat(row.harga) || 0, subtotal: parseFloat(row.subtotal) || 0 });
    }
    const grandTotal = transactions.reduce((s, t) => s + t.grandtotal, 0);
    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);
      return res.render('laporan_sales_order', { transactions, grandTotal, tglwal: tglwal||'-', tglakhir: tglakhir||'-', namatoko: tenant?.namatenant||'Grfyn POS', alamat: lokasi?.alamat||'', hp: lokasi?.hp||'', logo: tenant?.logo||'', tglcetak: new Date().toLocaleDateString('id-ID',{year:'numeric',month:'long',day:'numeric'}) });
    }
    res.json({ transactions, grandTotal });
  } catch (err) { logger.error(err, { req }); res.status(500).json({ message: err.message }); }
};

// GET /api/laporan/bpk — Laporan Bukti Pengeluaran Barang
exports.bpk = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idlokasi, filters } = req.query;
    const format = req.query.format || 'json';

    let sql = `
      SELECT bpk.kodebpk, bpk.tgltrans, bpk.grandtotal, bpk.status,
        c.kodecustomer, c.namacustomer,
        l.namalokasi,
        b.kodebarang, b.namabarang, b.satuankecil AS satuan,
        bd.jml, bd.harga, bd.subtotal
      FROM bpk
        JOIN lokasi l ON l.idlokasi = bpk.idlokasi AND l.idtenant = bpk.idtenant
        LEFT JOIN customer c ON c.idcustomer = bpk.idcustomer AND c.idtenant = bpk.idtenant
        JOIN bpkdtl bd ON bd.idbpk = bpk.idbpk AND bd.idtenant = bpk.idtenant
        JOIN barang b ON b.idbarang = bd.idbarang AND b.idtenant = bpk.idtenant
      WHERE bpk.idtenant = ?`;
    const params = [ctx.idtenant];
    if (idlokasi) { const r = multiIdIn('bpk.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (tglwal) { sql += ' AND bpk.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND bpk.tgltrans <= ?'; params.push(tglakhir); }
    const af = buildAdvancedFilter(filters);
    if (af.clause) { sql += ' AND ' + af.clause; params.push(...af.params); }
    sql += ' ORDER BY bpk.tgltrans DESC, bpk.kodebpk DESC, bd.idbpkdtl ASC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const transactions = [];
    let curKode = null, curGroup = null;
    for (const row of rows) {
      if (row.kodebpk !== curKode) {
        curKode = row.kodebpk;
        curGroup = { kodebpk: row.kodebpk, tgltrans: row.tgltrans, namalokasi: row.namalokasi, kodecustomer: row.kodecustomer, namacustomer: row.namacustomer, grandtotal: parseFloat(row.grandtotal)||0, status: row.status, items: [] };
        transactions.push(curGroup);
      }
      curGroup.items.push({ kodebarang: row.kodebarang, namabarang: row.namabarang, jml: row.jml, satuan: row.satuan, harga: parseFloat(row.harga)||0, subtotal: parseFloat(row.subtotal)||0 });
    }
    const grandTotal = transactions.reduce((s, t) => s + t.grandtotal, 0);
    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);
      return res.render('laporan_bpk', { transactions, grandTotal, tglwal: tglwal||'-', tglakhir: tglakhir||'-', namatoko: tenant?.namatenant||'Grfyn POS', alamat: lokasi?.alamat||'', hp: lokasi?.hp||'', logo: tenant?.logo||'', tglcetak: new Date().toLocaleDateString('id-ID',{year:'numeric',month:'long',day:'numeric'}) });
    }
    res.json({ transactions, grandTotal });
  } catch (err) { logger.error(err, { req }); res.status(500).json({ message: err.message }); }
};

// GET /api/laporan/retur-jual — Laporan Retur Penjualan
exports.returJual = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idlokasi, filters } = req.query;
    const format = req.query.format || 'json';

    let sql = `
      SELECT rj.kodereturjual, rj.tgltrans, rj.total, rj.status, rj.kodejual,
        c.kodecustomer, c.namacustomer,
        l.namalokasi,
        b.kodebarang, b.namabarang, b.satuankecil AS satuan,
        rd.jml, rd.harga, rd.subtotal
      FROM returjual rj
        JOIN lokasi l ON l.idlokasi = rj.idlokasi AND l.idtenant = rj.idtenant
        LEFT JOIN customer c ON c.idcustomer = rj.idcustomer AND c.idtenant = rj.idtenant
        JOIN returjualdtl rd ON rd.idreturjual = rj.idreturjual AND rd.idtenant = rj.idtenant
        JOIN barang b ON b.idbarang = rd.idbarang AND b.idtenant = rj.idtenant
      WHERE rj.idtenant = ?`;
    const params = [ctx.idtenant];
    if (idlokasi) { const r = multiIdIn('rj.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (tglwal) { sql += ' AND rj.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND rj.tgltrans <= ?'; params.push(tglakhir); }
    const af = buildAdvancedFilter(filters);
    if (af.clause) { sql += ' AND ' + af.clause; params.push(...af.params); }
    sql += ' ORDER BY rj.tgltrans DESC, rj.kodereturjual DESC, rd.idreturjualdtl ASC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const transactions = [];
    let curKode = null, curGroup = null;
    for (const row of rows) {
      if (row.kodereturjual !== curKode) {
        curKode = row.kodereturjual;
        curGroup = { kodereturjual: row.kodereturjual, tgltrans: row.tgltrans, namalokasi: row.namalokasi, kodecustomer: row.kodecustomer, namacustomer: row.namacustomer, total: parseFloat(row.total)||0, status: row.status, kodejual: row.kodejual, items: [] };
        transactions.push(curGroup);
      }
      curGroup.items.push({ kodebarang: row.kodebarang, namabarang: row.namabarang, jml: row.jml, satuan: row.satuan, harga: parseFloat(row.harga)||0, subtotal: parseFloat(row.subtotal)||0 });
    }
    const grandTotal = transactions.reduce((s, t) => s + t.total, 0);
    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);
      return res.render('laporan_retur_jual', { transactions, grandTotal, tglwal: tglwal||'-', tglakhir: tglakhir||'-', namatoko: tenant?.namatenant||'Grfyn POS', alamat: lokasi?.alamat||'', hp: lokasi?.hp||'', logo: tenant?.logo||'', tglcetak: new Date().toLocaleDateString('id-ID',{year:'numeric',month:'long',day:'numeric'}) });
    }
    res.json({ transactions, grandTotal });
  } catch (err) { logger.error(err, { req }); res.status(500).json({ message: err.message }); }
};

// GET /api/laporan/purchase-order — Laporan Purchase Order
exports.purchaseOrder = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idlokasi, filters } = req.query;
    const format = req.query.format || 'json';

    let sql = `
      SELECT po.kodepo, po.tgltrans, po.grandtotal, po.status,
        s.kodesupplier, s.namasupplier,
        l.namalokasi,
        b.kodebarang, b.namabarang, b.satuankecil AS satuan,
        pd.jml, pd.harga, pd.subtotal
      FROM purchaseorder po
        JOIN lokasi l ON l.idlokasi = po.idlokasi AND l.idtenant = po.idtenant
        LEFT JOIN supplier s ON s.idsupplier = po.idsupplier AND s.idtenant = po.idtenant
        JOIN purchaseorderdtl pd ON pd.idpo = po.idpo AND pd.idtenant = po.idtenant
        JOIN barang b ON b.idbarang = pd.idbarang AND b.idtenant = po.idtenant
      WHERE po.idtenant = ?`;
    const params = [ctx.idtenant];
    if (idlokasi) { const r = multiIdIn('po.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (tglwal) { sql += ' AND po.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND po.tgltrans <= ?'; params.push(tglakhir); }
    const af = buildAdvancedFilter(filters);
    if (af.clause) { sql += ' AND ' + af.clause; params.push(...af.params); }
    sql += ' ORDER BY po.tgltrans DESC, po.kodepo DESC, pd.idpodtl ASC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const transactions = [];
    let curKode = null, curGroup = null;
    for (const row of rows) {
      if (row.kodepo !== curKode) {
        curKode = row.kodepo;
        curGroup = { kodepo: row.kodepo, tgltrans: row.tgltrans, namalokasi: row.namalokasi, kodesupplier: row.kodesupplier, namasupplier: row.namasupplier, grandtotal: parseFloat(row.grandtotal)||0, status: row.status, items: [] };
        transactions.push(curGroup);
      }
      curGroup.items.push({ kodebarang: row.kodebarang, namabarang: row.namabarang, jml: row.jml, satuan: row.satuan, harga: parseFloat(row.harga)||0, subtotal: parseFloat(row.subtotal)||0 });
    }
    const grandTotal = transactions.reduce((s, t) => s + t.grandtotal, 0);
    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);
      return res.render('laporan_purchase_order', { transactions, grandTotal, tglwal: tglwal||'-', tglakhir: tglakhir||'-', namatoko: tenant?.namatenant||'Grfyn POS', alamat: lokasi?.alamat||'', hp: lokasi?.hp||'', logo: tenant?.logo||'', tglcetak: new Date().toLocaleDateString('id-ID',{year:'numeric',month:'long',day:'numeric'}) });
    }
    res.json({ transactions, grandTotal });
  } catch (err) { logger.error(err, { req }); res.status(500).json({ message: err.message }); }
};

// GET /api/laporan/bpb — Laporan Bukti Penerimaan Barang
exports.bpb = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idlokasi, filters } = req.query;
    const format = req.query.format || 'json';

    let sql = `
      SELECT bpb.kodebpb, bpb.tgltrans, bpb.grandtotal, bpb.status,
        s.kodesupplier, s.namasupplier,
        l.namalokasi,
        b.kodebarang, b.namabarang, b.satuankecil AS satuan,
        bd.jml, bd.harga, bd.subtotal
      FROM bpb
        JOIN lokasi l ON l.idlokasi = bpb.idlokasi AND l.idtenant = bpb.idtenant
        LEFT JOIN supplier s ON s.idsupplier = bpb.idsupplier AND s.idtenant = bpb.idtenant
        JOIN bpbdtl bd ON bd.idbpb = bpb.idbpb AND bd.idtenant = bpb.idtenant
        JOIN barang b ON b.idbarang = bd.idbarang AND b.idtenant = bpb.idtenant
      WHERE bpb.idtenant = ?`;
    const params = [ctx.idtenant];
    if (idlokasi) { const r = multiIdIn('bpb.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (tglwal) { sql += ' AND bpb.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND bpb.tgltrans <= ?'; params.push(tglakhir); }
    const af = buildAdvancedFilter(filters);
    if (af.clause) { sql += ' AND ' + af.clause; params.push(...af.params); }
    sql += ' ORDER BY bpb.tgltrans DESC, bpb.kodebpb DESC, bd.idbpbdtl ASC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const transactions = [];
    let curKode = null, curGroup = null;
    for (const row of rows) {
      if (row.kodebpb !== curKode) {
        curKode = row.kodebpb;
        curGroup = { kodebpb: row.kodebpb, tgltrans: row.tgltrans, namalokasi: row.namalokasi, kodesupplier: row.kodesupplier, namasupplier: row.namasupplier, grandtotal: parseFloat(row.grandtotal)||0, status: row.status, items: [] };
        transactions.push(curGroup);
      }
      curGroup.items.push({ kodebarang: row.kodebarang, namabarang: row.namabarang, jml: row.jml, satuan: row.satuan, harga: parseFloat(row.harga)||0, subtotal: parseFloat(row.subtotal)||0 });
    }
    const grandTotal = transactions.reduce((s, t) => s + t.grandtotal, 0);
    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);
      return res.render('laporan_bpb', { transactions, grandTotal, tglwal: tglwal||'-', tglakhir: tglakhir||'-', namatoko: tenant?.namatenant||'Grfyn POS', alamat: lokasi?.alamat||'', hp: lokasi?.hp||'', logo: tenant?.logo||'', tglcetak: new Date().toLocaleDateString('id-ID',{year:'numeric',month:'long',day:'numeric'}) });
    }
    res.json({ transactions, grandTotal });
  } catch (err) { logger.error(err, { req }); res.status(500).json({ message: err.message }); }
};

// GET /api/laporan/retur-beli — Laporan Retur Pembelian
exports.returBeli = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idlokasi, filters } = req.query;
    const format = req.query.format || 'json';

    let sql = `
      SELECT rb.kodereturbeli, rb.tgltrans, rb.total, rb.status, rb.kodebeli,
        s.kodesupplier, s.namasupplier,
        l.namalokasi,
        b.kodebarang, b.namabarang, b.satuankecil AS satuan,
        rd.jml, rd.harga, rd.subtotal
      FROM returbeli rb
        JOIN lokasi l ON l.idlokasi = rb.idlokasi AND l.idtenant = rb.idtenant
        LEFT JOIN supplier s ON s.idsupplier = rb.idsupplier AND s.idtenant = rb.idtenant
        JOIN returbelidtl rd ON rd.idreturbeli = rb.idreturbeli AND rd.idtenant = rb.idtenant
        JOIN barang b ON b.idbarang = rd.idbarang AND b.idtenant = rb.idtenant
      WHERE rb.idtenant = ?`;
    const params = [ctx.idtenant];
    if (idlokasi) { const r = multiIdIn('rb.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (tglwal) { sql += ' AND rb.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND rb.tgltrans <= ?'; params.push(tglakhir); }
    const af = buildAdvancedFilter(filters);
    if (af.clause) { sql += ' AND ' + af.clause; params.push(...af.params); }
    sql += ' ORDER BY rb.tgltrans DESC, rb.kodereturbeli DESC, rd.idreturbelidtl ASC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const transactions = [];
    let curKode = null, curGroup = null;
    for (const row of rows) {
      if (row.kodereturbeli !== curKode) {
        curKode = row.kodereturbeli;
        curGroup = { kodereturbeli: row.kodereturbeli, tgltrans: row.tgltrans, namalokasi: row.namalokasi, kodesupplier: row.kodesupplier, namasupplier: row.namasupplier, total: parseFloat(row.total)||0, status: row.status, kodebeli: row.kodebeli, items: [] };
        transactions.push(curGroup);
      }
      curGroup.items.push({ kodebarang: row.kodebarang, namabarang: row.namabarang, jml: row.jml, satuan: row.satuan, harga: parseFloat(row.harga)||0, subtotal: parseFloat(row.subtotal)||0 });
    }
    const grandTotal = transactions.reduce((s, t) => s + t.total, 0);
    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);
      return res.render('laporan_retur_beli', { transactions, grandTotal, tglwal: tglwal||'-', tglakhir: tglakhir||'-', namatoko: tenant?.namatenant||'Grfyn POS', alamat: lokasi?.alamat||'', hp: lokasi?.hp||'', logo: tenant?.logo||'', tglcetak: new Date().toLocaleDateString('id-ID',{year:'numeric',month:'long',day:'numeric'}) });
    }
    res.json({ transactions, grandTotal });
  } catch (err) { logger.error(err, { req }); res.status(500).json({ message: err.message }); }
};

// GET /api/laporan/faktur/:id — Cetak faktur penjualan (HTML)
exports.faktur = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { id } = req.params;
    const format = req.query.format || 'json';

    const rows = await tenantQuery(
      `SELECT j.*, c.namacustomer, c.alamat as alamatcustomer, c.hp as hpcustomer
       FROM jual j
       LEFT JOIN customer c ON j.idcustomer = c.idcustomer AND c.idtenant = j.idtenant
       WHERE j.idjual = ? AND j.idlokasi = ?`,
      [id, ctx.idlokasi]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Transaksi tidak ditemukan' });
    const jual = rows[0];

    const detail = await tenantQuery(
      `SELECT jd.*, b.namabarang, b.kodebarang, b.satuankecil as satuan
       FROM jualdtl jd
       LEFT JOIN barang b ON jd.idbarang = b.idbarang AND b.idtenant = jd.idtenant
       WHERE jd.idjual = ?`,
      [id]
    );

    if (format === 'html') {
      let sqlTenantFaktur = 'SELECT * FROM tenant WHERE idtenant = ?';
      const [[tenant]] = await pool.query(sqlTenantFaktur, [ctx.idtenant]);
      let sqlLokasiFaktur = 'SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?';
      const [[lokasi]] = await pool.query(sqlLokasiFaktur, [ctx.idlokasi, ctx.idtenant]);
      return res.render('faktur', {
        jual, detail,
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: lokasi?.alamat || '',
        hp: lokasi?.hp || '',
        logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: jual, detail });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

exports.absen = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idlokasi, format = 'json' } = req.query;
    let sql = `SELECT a.kodeabsen, a.tgltrans, a.status, l.kodelokasi, l.namalokasi,
        ad.jenis, ad.catatan, k.kodekaryawan, k.namakaryawan
      FROM absen a
      JOIN absendtl ad ON ad.idabsen = a.idabsen AND ad.idtenant = a.idtenant
      JOIN karyawan k ON k.idkaryawan = ad.idkaryawan AND k.idtenant = ad.idtenant
      JOIN lokasi l ON l.idlokasi = a.idlokasi AND l.idtenant = a.idtenant
      WHERE a.idtenant = ? AND a.status IN ('APPROVED','CONFIRMED')`;
    const params = [ctx.idtenant];
    if (idlokasi) { const r = multiIdIn('a.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (tglwal) { sql += ' AND a.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND a.tgltrans <= ?'; params.push(tglakhir); }
    sql += ' ORDER BY a.tgltrans ASC, a.kodeabsen ASC, k.namakaryawan ASC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const groups = [];
    let currentKey = null;
    let current = null;
    for (const row of rows) {
      const tgl = row.tgltrans && row.tgltrans.toISOString ? row.tgltrans.toISOString().slice(0, 10) : String(row.tgltrans).slice(0, 10);
      const key = `${tgl}|${row.kodeabsen}`;
      if (key !== currentKey) {
        currentKey = key;
        current = {
          kodeabsen: row.kodeabsen,
          tgltrans: tgl,
          status: row.status,
          namalokasi: row.namalokasi,
          kodelokasi: row.kodelokasi,
          items: [],
        };
        groups.push(current);
      }
      current.items.push({
        kodekaryawan: row.kodekaryawan,
        namakaryawan: row.namakaryawan,
        jenis: row.jenis,
        catatan: row.catatan,
      });
    }

    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);
      return res.render('laporan_absen', {
        groups,
        totalTransaksi: groups.length,
        totalDetail: rows.length,
        tglwal: tglwal || '-',
        tglakhir: tglakhir || '-',
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: lokasi?.alamat || '',
        hp: lokasi?.hp || '',
        logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' }),
      });
    }

    res.json({ groups, totalTransaksi: groups.length, totalDetail: rows.length });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

exports.gaji = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idlokasi, format = 'json' } = req.query;
    let sql = `SELECT g.kodegaji, g.periodbulan, g.tglawal, g.tglakhir, g.status,
        g.totalgaji, g.totalbonus, g.total, g.totalcash, g.totalbank,
        l.kodelokasi, l.namalokasi,
        gd.gaji AS detailgaji, gd.bonus, gd.total AS detailtotal, gd.bayarcash, gd.bayarbank,
        gd.totalabsen, gd.totalpotongabsen, gd.catatan,
        k.kodekaryawan, k.namakaryawan
      FROM gaji g
      JOIN gajidtl gd ON gd.idgaji = g.idgaji AND gd.idtenant = g.idtenant
      JOIN karyawan k ON k.idkaryawan = gd.idkaryawan AND k.idtenant = gd.idtenant
      JOIN lokasi l ON l.idlokasi = g.idlokasi AND l.idtenant = g.idtenant
      WHERE g.idtenant = ? AND g.status IN ('APPROVED','CONFIRMED')`;
    const params = [ctx.idtenant];
    if (idlokasi) { const r = multiIdIn('g.idlokasi', idlokasi); if (r.clause) { sql += ' AND ' + r.clause; params.push(...r.params); } }
    if (tglwal) { sql += ' AND g.tglakhir >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND g.tglawal <= ?'; params.push(tglakhir); }
    sql += ' ORDER BY g.periodbulan ASC, g.kodegaji ASC, k.namakaryawan ASC';

    const rows = await tenantQuery(withPreviewLimit(req, sql), params);
    const groups = [];
    let currentKey = null;
    let current = null;
    for (const row of rows) {
      if (row.kodegaji !== currentKey) {
        currentKey = row.kodegaji;
        current = {
          kodegaji: row.kodegaji,
          periodbulan: row.periodbulan,
          status: row.status,
          namalokasi: row.namalokasi,
          kodelokasi: row.kodelokasi,
          totalgaji: Number(row.totalgaji || 0),
          totalbonus: Number(row.totalbonus || 0),
          total: Number(row.total || 0),
          totalcash: Number(row.totalcash || 0),
          totalbank: Number(row.totalbank || 0),
          items: [],
        };
        groups.push(current);
      }
      current.items.push({
        kodekaryawan: row.kodekaryawan,
        namakaryawan: row.namakaryawan,
        gaji: Number(row.detailgaji || 0),
        bonus: Number(row.bonus || 0),
        total: Number(row.detailtotal || 0),
        bayarcash: Number(row.bayarcash || 0),
        bayarbank: Number(row.bayarbank || 0),
        totalabsen: row.totalabsen,
        totalpotongabsen: row.totalpotongabsen,
        catatan: row.catatan,
      });
    }
    const grandTotal = groups.reduce((s, g) => s + g.total, 0);

    if (format === 'html') {
      const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
      const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);
      return res.render('laporan_gaji', {
        groups,
        grandTotal,
        tglwal: tglwal || '-',
        tglakhir: tglakhir || '-',
        namatoko: tenant?.namatenant || 'Grfyn POS',
        alamat: lokasi?.alamat || '',
        hp: lokasi?.hp || '',
        logo: tenant?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' }),
      });
    }

    res.json({ groups, grandTotal });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

exports.slipGaji = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await tenantQuery(
      `SELECT g.kodegaji, g.periodbulan, g.tglawal, g.tglakhir, g.status,
        l.kodelokasi, l.namalokasi,
        gd.*, k.kodekaryawan, k.namakaryawan, k.email, k.hp
       FROM gaji g
       JOIN gajidtl gd ON gd.idgaji = g.idgaji AND gd.idtenant = g.idtenant
       JOIN karyawan k ON k.idkaryawan = gd.idkaryawan AND k.idtenant = gd.idtenant
       JOIN lokasi l ON l.idlokasi = g.idlokasi AND l.idtenant = g.idtenant
       WHERE g.idgaji = ? AND g.idtenant = ?
       ORDER BY k.namakaryawan`,
      [req.params.id, ctx.idtenant]
    );
    if (!rows.length) return res.status(404).json({ message: 'Gaji tidak ditemukan' });

    const [[tenant]] = await pool.query('SELECT * FROM tenant WHERE idtenant = ?', [ctx.idtenant]);
    const [[lokasi]] = await pool.query('SELECT * FROM lokasi WHERE idlokasi = ? AND idtenant = ?', [ctx.idlokasi, ctx.idtenant]);
    return res.render('slip_gaji', {
      slips: rows,
      namatoko: tenant?.namatenant || 'Grfyn POS',
      alamat: lokasi?.alamat || '',
      hp: lokasi?.hp || '',
      logo: tenant?.logo || '',
      tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' }),
    });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};
