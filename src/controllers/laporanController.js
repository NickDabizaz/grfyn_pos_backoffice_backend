const pool = require('../config/db');

// ============ SALES TRANSACTION REPORT ============
exports.salesTransaksi = async (req, res) => {
  try {
    const { tglwal, tglakhir, idcustomer, idbarang } = req.query;
    const format = req.query.format || 'json';

    let sql = `SELECT j.*, c.namacustomer, u.username as kasir
      FROM jual j
      LEFT JOIN customer c ON j.idcustomer = c.idcustomer
      LEFT JOIN users u ON j.idkasir = u.iduser
      WHERE 1=1`;
    const params = [];
    if (tglwal) { sql += ' AND j.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND j.tgltrans <= ?'; params.push(tglakhir); }
    if (idcustomer) { sql += ' AND j.idcustomer = ?'; params.push(idcustomer); }
    if (idbarang) {
      sql += ' AND j.idjual IN (SELECT idjual FROM jualdtl WHERE idbarang = ?)';
      params.push(idbarang);
    }
    sql += ' ORDER BY j.tgltrans DESC, j.idjual DESC';

    const [rows] = await pool.query(sql, params);

    // Calculate totals
    let totalTransaksi = rows.length;
    let totalPenjualan = rows.reduce((sum, r) => sum + parseFloat(r.grandtotal || 0), 0);

    if (format === 'html') {
      const [user] = await pool.query('SELECT * FROM users LIMIT 1');
      return res.render('laporan_sales_transaksi', {
        data: rows,
        totalTransaksi,
        totalPenjualan,
        tglwal: tglwal || '-',
        tglakhir: tglakhir || '-',
        namatoko: user[0]?.namatoko || 'Grfyn POS',
        alamat: user[0]?.alamat || '',
        hp: user[0]?.hp || '',
        logo: user[0]?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: rows, totalTransaksi, totalPenjualan });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ============ SALES PER CUSTOMER ============
exports.salesPerCustomer = async (req, res) => {
  try {
    const { tglwal, tglakhir, idcustomer } = req.query;
    const format = req.query.format || 'json';

    let sql = `SELECT c.idcustomer, c.kodecustomer, c.namacustomer,
      COUNT(j.idjual) as total_transaksi,
      COALESCE(SUM(j.grandtotal), 0) as total_penjualan
      FROM customer c
      LEFT JOIN jual j ON c.idcustomer = j.idcustomer`;
    const params = [];
    const conditions = [];
    if (tglwal) { conditions.push('j.tgltrans >= ?'); params.push(tglwal); }
    if (tglakhir) { conditions.push('j.tgltrans <= ?'); params.push(tglakhir); }
    if (idcustomer) { conditions.push('c.idcustomer = ?'); params.push(idcustomer); }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' GROUP BY c.idcustomer, c.kodecustomer, c.namacustomer ORDER BY total_penjualan DESC';

    const [rows] = await pool.query(sql, params);
    const grandTotal = rows.reduce((sum, r) => sum + parseFloat(r.total_penjualan || 0), 0);

    if (format === 'html') {
      const [user] = await pool.query('SELECT * FROM users LIMIT 1');
      return res.render('laporan_sales_per_customer', {
        data: rows,
        grandTotal,
        tglwal: tglwal || '-',
        tglakhir: tglakhir || '-',
        namatoko: user[0]?.namatoko || 'Grfyn POS',
        alamat: user[0]?.alamat || '',
        hp: user[0]?.hp || '',
        logo: user[0]?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: rows, grandTotal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ============ SALES PER BARANG ============
exports.salesPerBarang = async (req, res) => {
  try {
    const { tglwal, tglakhir, idbarang } = req.query;
    const format = req.query.format || 'json';

    let sql = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil,
      COALESCE(SUM(jd.jml), 0) as total_qty,
      COALESCE(SUM(jd.subtotal), 0) as total_nilai
      FROM barang b
      LEFT JOIN jualdtl jd ON b.idbarang = jd.idbarang
      LEFT JOIN jual j ON jd.idjual = j.idjual`;
    const params = [];
    const conditions = [];
    if (tglwal) { conditions.push('j.tgltrans >= ?'); params.push(tglwal); }
    if (tglakhir) { conditions.push('j.tgltrans <= ?'); params.push(tglakhir); }
    if (idbarang) { conditions.push('b.idbarang = ?'); params.push(idbarang); }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' GROUP BY b.idbarang, b.kodebarang, b.namabarang, b.satuankecil ORDER BY total_nilai DESC';

    const [rows] = await pool.query(sql, params);
    const grandTotal = rows.reduce((sum, r) => sum + parseFloat(r.total_nilai || 0), 0);

    if (format === 'html') {
      const [user] = await pool.query('SELECT * FROM users LIMIT 1');
      return res.render('laporan_sales_per_barang', {
        data: rows,
        grandTotal,
        tglwal: tglwal || '-',
        tglakhir: tglakhir || '-',
        namatoko: user[0]?.namatoko || 'Grfyn POS',
        alamat: user[0]?.alamat || '',
        hp: user[0]?.hp || '',
        logo: user[0]?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: rows, grandTotal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ============ PEMBELIAN REPORT ============
exports.pembelian = async (req, res) => {
  try {
    const { tglwal, tglakhir, idsupplier } = req.query;
    const format = req.query.format || 'json';

    let sql = `SELECT b.*, s.namasupplier, u.username as kasir
      FROM beli b
      LEFT JOIN supplier s ON b.idsupplier = s.idsupplier
      LEFT JOIN users u ON b.idkasir = u.iduser
      WHERE 1=1`;
    const params = [];
    if (tglwal) { sql += ' AND b.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND b.tgltrans <= ?'; params.push(tglakhir); }
    if (idsupplier) { sql += ' AND b.idsupplier = ?'; params.push(idsupplier); }
    sql += ' ORDER BY b.tgltrans DESC, b.idbeli DESC';

    const [rows] = await pool.query(sql, params);
    const totalPembelian = rows.reduce((sum, r) => sum + parseFloat(r.grandtotal || 0), 0);

    if (format === 'html') {
      const [user] = await pool.query('SELECT * FROM users LIMIT 1');
      return res.render('laporan_pembelian', {
        data: rows,
        totalPembelian,
        tglwal: tglwal || '-',
        tglakhir: tglakhir || '-',
        namatoko: user[0]?.namatoko || 'Grfyn POS',
        alamat: user[0]?.alamat || '',
        hp: user[0]?.hp || '',
        logo: user[0]?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: rows, totalPembelian });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ============ STOCK REPORT ============
exports.stok = async (req, res) => {
  try {
    const { tgl, idbarang } = req.query;
    const format = req.query.format || 'json';

    // Get latest saldostok
    const [[latestSaldo]] = await pool.query(
      'SELECT idsaldostok, kodesaldostok, tgltrans FROM saldostok ORDER BY tgltrans DESC, idsaldostok DESC LIMIT 1'
    );

    let sql;
    const params = [];

    if (latestSaldo) {
      sql = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil, b.stokmin,
        COALESCE(sd.jml, 0) + COALESCE(km.masuk, 0) - COALESCE(km.keluar, 0) as stok
        FROM barang b
        LEFT JOIN saldostokdtl sd ON sd.idbarang = b.idbarang AND sd.idsaldostok = ?
        LEFT JOIN (
          SELECT idbarang,
            COALESCE(SUM(CASE WHEN jenis = 'M' THEN jml ELSE 0 END), 0) as masuk,
            COALESCE(SUM(CASE WHEN jenis = 'K' THEN jml ELSE 0 END), 0) as keluar
          FROM kartustok WHERE tgltrans > ? GROUP BY idbarang
        ) km ON km.idbarang = b.idbarang
        WHERE b.status = 1`;
      params.push(latestSaldo.idsaldostok, latestSaldo.tgltrans);
    } else {
      sql = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil, b.stokmin,
        COALESCE(m.total, 0) - COALESCE(k.total, 0) as stok
        FROM barang b
        LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'M' GROUP BY idbarang) m ON b.idbarang = m.idbarang
        LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'K' GROUP BY idbarang) k ON b.idbarang = k.idbarang
        WHERE b.status = 1`;
    }
    if (idbarang) {
      let ids = Array.isArray(idbarang) ? idbarang : [idbarang];
      sql += ' AND b.idbarang IN (' + ids.map(() => '?').join(',') + ')';
      params.push(...ids);
    }
    sql += ' ORDER BY b.namabarang';

    const [rows] = await pool.query(sql, params);
    const totalBarang = rows.length;
    const totalStok = rows.reduce((sum, r) => sum + (parseInt(r.stok) || 0), 0);

    if (format === 'html') {
      const [user] = await pool.query('SELECT * FROM users LIMIT 1');
      return res.render('laporan_stok', {
        data: rows,
        totalBarang,
        totalStok,
        periodSaldo: latestSaldo ? latestSaldo.tgltrans : '-',
        namatoko: user[0]?.namatoko || 'Grfyn POS',
        alamat: user[0]?.alamat || '',
        hp: user[0]?.hp || '',
        logo: user[0]?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: rows, totalBarang, totalStok, periodSaldo: latestSaldo?.tgltrans });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ============ KARTU STOK REPORT ============
exports.kartuStok = async (req, res) => {
  try {
    const { tglwal, tglakhir, idbarang } = req.query;
    const format = req.query.format || 'json';

    let ids = [];
    if (idbarang) {
      ids = Array.isArray(idbarang) ? idbarang.map(Number) : [Number(idbarang)];
    }

    // Saldo awal per barang (sebelum tglwal)
    let saldoAwalSql = `
      SELECT idbarang,
        COALESCE(SUM(CASE WHEN jenis='M' THEN jml ELSE 0 END),0) - COALESCE(SUM(CASE WHEN jenis='K' THEN jml ELSE 0 END),0) as saldo_awal
      FROM kartustok
      WHERE 1=1
    `;
    const saldoAwalParams = [];
    if (tglwal) {
      saldoAwalSql += ' AND tgltrans < ?';
      saldoAwalParams.push(tglwal);
    }
    if (ids.length > 0) {
      saldoAwalSql += ' AND idbarang IN (' + ids.map(() => '?').join(',') + ')';
      saldoAwalParams.push(...ids);
    }
    saldoAwalSql += ' GROUP BY idbarang';

    const [saldoAwalRows] = await pool.query(saldoAwalSql, saldoAwalParams);
    const saldoAwalMap = {};
    saldoAwalRows.forEach(r => saldoAwalMap[r.idbarang] = parseInt(r.saldo_awal) || 0);

    // Transaksi dalam periode
    let sql = `
      SELECT k.idkartustok, k.kodetrans, k.idbarang, k.jml, k.jenis, k.tgltrans, k.keterangan, k.idref, k.jenisref,
        b.kodebarang, b.namabarang, b.satuankecil
      FROM kartustok k
      JOIN barang b ON k.idbarang = b.idbarang
      WHERE 1=1
    `;
    const params = [];
    if (tglwal) { sql += ' AND k.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND k.tgltrans <= ?'; params.push(tglakhir); }
    if (ids.length > 0) {
      sql += ' AND k.idbarang IN (' + ids.map(() => '?').join(',') + ')';
      params.push(...ids);
    }
    sql += ' ORDER BY b.namabarang, k.tgltrans, k.idkartustok';

    const [rows] = await pool.query(sql, params);

    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.idbarang]) {
        grouped[r.idbarang] = {
          idbarang: r.idbarang,
          kodebarang: r.kodebarang,
          namabarang: r.namabarang,
          satuankecil: r.satuankecil,
          saldo_awal: saldoAwalMap[r.idbarang] || 0,
          items: [],
          total_masuk: 0,
          total_keluar: 0,
        };
      }
      grouped[r.idbarang].items.push(r);
      if (r.jenis === 'M') grouped[r.idbarang].total_masuk += parseInt(r.jml) || 0;
      else grouped[r.idbarang].total_keluar += parseInt(r.jml) || 0;
    });

    const barangList = Object.values(grouped);

    if (format === 'html') {
      const [user] = await pool.query('SELECT * FROM users LIMIT 1');
      return res.render('laporan_kartu_stok', {
        data: barangList,
        tglwal: tglwal || '-',
        tglakhir: tglakhir || '-',
        namatoko: user[0]?.namatoko || 'Grfyn POS',
        alamat: user[0]?.alamat || '',
        hp: user[0]?.hp || '',
        logo: user[0]?.logo || '',
        tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
      });
    }

    res.json({ data: barangList });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ============ STRUK PER TRANSAKSI (POS) ============
exports.struk = async (req, res) => {
  try {
    const { id } = req.params;

    const [[jual]] = await pool.query(
      `SELECT j.*, c.namacustomer, c.kodecustomer as customerKode, c.alamat as customerAlamat, c.hp as customerHp, u.username as kasir
       FROM jual j
       LEFT JOIN customer c ON j.idcustomer = c.idcustomer
       LEFT JOIN users u ON j.idkasir = u.iduser
       WHERE j.idjual = ?`, [id]
    );
    if (!jual) return res.status(404).json({ message: 'Transaksi tidak ditemukan' });

    const [items] = await pool.query(
      `SELECT jd.*, b.namabarang, b.satuankecil
       FROM jualdtl jd
       LEFT JOIN barang b ON jd.idbarang = b.idbarang
       WHERE jd.idjual = ?`, [id]
    );

    const [user] = await pool.query('SELECT * FROM users LIMIT 1');

    const subtotal = items.reduce((sum, item) => sum + (parseFloat(item.harga) * parseFloat(item.jml)), 0);
    const ppn = items.reduce((sum, item) => sum + parseFloat(item.ppn || 0), 0);
    const totalDiskon = items.reduce((sum, item) => sum + ((parseFloat(item.harga) * parseFloat(item.jml) * parseFloat(item.diskon || 0)) / 100), 0);

    res.render('struk', {
      kodejual: jual.kodejual,
      tgltrans: jual.tgltrans ? new Date(jual.tgltrans).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' }) : '-',
      kasir: jual.kasir,
      namacustomer: jual.namacustomer,
      items,
      subtotal,
      ppn,
      totalDiskon,
      grandtotal: parseFloat(jual.grandtotal),
      bayar: parseFloat(jual.bayar || 0),
      kembali: parseFloat(jual.kembali || 0),
      namatoko: user[0]?.namatoko || 'Grfyn POS',
      alamat: user[0]?.alamat || '',
      hp: user[0]?.hp || '',
      logo: user[0]?.logo || ''
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ============ FAKTUR PENJUALAN PER TRANSAKSI ============
exports.faktur = async (req, res) => {
  try {
    const { id } = req.params;

    const [[jual]] = await pool.query(
      `SELECT j.*, c.namacustomer, c.kodecustomer as customerKode, c.alamat as customerAlamat, c.hp as customerHp, u.username as kasir
       FROM jual j
       LEFT JOIN customer c ON j.idcustomer = c.idcustomer
       LEFT JOIN users u ON j.idkasir = u.iduser
       WHERE j.idjual = ?`, [id]
    );
    if (!jual) return res.status(404).json({ message: 'Transaksi tidak ditemukan' });

    const [items] = await pool.query(
      `SELECT jd.*, b.namabarang, b.satuankecil
       FROM jualdtl jd
       LEFT JOIN barang b ON jd.idbarang = b.idbarang
       WHERE jd.idjual = ?`, [id]
    );

    const [user] = await pool.query('SELECT * FROM users LIMIT 1');

    const subtotal = items.reduce((sum, item) => sum + (parseFloat(item.harga) * parseFloat(item.jml)), 0);
    const ppn = items.reduce((sum, item) => sum + parseFloat(item.ppn || 0), 0);
    const totalDiskon = items.reduce((sum, item) => sum + ((parseFloat(item.harga) * parseFloat(item.jml) * parseFloat(item.diskon || 0)) / 100), 0);

    res.render('faktur_penjualan', {
      kodejual: jual.kodejual,
      tgltrans: jual.tgltrans ? new Date(jual.tgltrans).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' }) : '-',
      kasir: jual.kasir,
      namacustomer: jual.namacustomer,
      customerKode: jual.customerKode,
      customerAlamat: jual.customerAlamat,
      customerHp: jual.customerHp,
      status: jual.status,
      items,
      subtotal,
      ppn,
      totalDiskon,
      grandtotal: parseFloat(jual.grandtotal),
      bayar: parseFloat(jual.bayar || 0),
      kembali: parseFloat(jual.kembali || 0),
      namatoko: user[0]?.namatoko || 'Grfyn POS',
      alamat: user[0]?.alamat || '',
      hp: user[0]?.hp || '',
      logo: user[0]?.logo || '',
      tglcetak: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
