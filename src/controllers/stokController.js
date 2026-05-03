const pool = require('../config/db');

// ============ KARTU STOK ============
exports.getKartuStok = async (req, res) => {
  try {
    const { idbarang, tglwal, tglakhir, jenis } = req.query;
    let sql = `SELECT ks.*, b.namabarang, b.satuankecil FROM kartustok ks LEFT JOIN barang b ON ks.idbarang = b.idbarang WHERE 1=1`;
    const params = [];
    if (idbarang) { sql += ' AND ks.idbarang = ?'; params.push(idbarang); }
    if (tglwal) { sql += ' AND ks.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND ks.tgltrans <= ?'; params.push(tglakhir); }
    if (jenis) { sql += ' AND ks.jenis = ?'; params.push(jenis); }
    sql += ' ORDER BY ks.tgltrans DESC, ks.idkartustok DESC LIMIT 500';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ============ PENYESUAIAN STOK ============
exports.getPenyesuaian = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT ps.*, u.username as kasir
      FROM penyesuaianstok ps LEFT JOIN users u ON ps.idkasir = u.iduser ORDER BY ps.tgltrans DESC, ps.idpenyesuaianstok DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPenyesuaianDetail = async (req, res) => {
  try {
<<<<<<< HEAD
    const [rows] = await pool.query(`SELECT psd.*, b.namabarang, b.satuankecil
=======
    const [rows] = await pool.query(`SELECT psd.*, b.namabarang, b.satuan
>>>>>>> 503bb98c762027b354d9e9b30ca1c01f18780e37
      FROM penyesuaianstokdtl psd LEFT JOIN barang b ON psd.idbarang = b.idbarang
      WHERE psd.idpenyesuaianstok = ?`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createPenyesuaian = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { idkasir, keterangan, items } = req.body;

    if (!items || !items.length) return res.status(400).json({ message: 'Items tidak boleh kosong' });

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const [[{ cnt }]] = await conn.query(`SELECT COUNT(*) as cnt FROM penyesuaianstok WHERE kodepenyesuaianstok LIKE ?`, [`PNS-${dateStr}-%`]);
    const num = String(cnt + 1).padStart(4, '0');
    const kode = `PNS-${dateStr}-${num}`;
    const tgltrans = new Date().toISOString().slice(0, 10);

    await conn.query(
      'INSERT INTO penyesuaianstok (kodepenyesuaianstok, tgltrans, idkasir, keterangan) VALUES (?, ?, ?, ?)',
      [kode, tgltrans, idkasir, keterangan || '']
    );
    const [[header]] = await conn.query('SELECT idpenyesuaianstok FROM penyesuaianstok WHERE kodepenyesuaianstok = ?', [kode]);

    for (const item of items) {
      // Get current stock from kartustok
      const [[masuk]] = await conn.query('SELECT COALESCE(SUM(jml), 0) as total FROM kartustok WHERE idbarang = ? AND jenis = ?', [item.idbarang, 'M']);
      const [[keluar]] = await conn.query('SELECT COALESCE(SUM(jml), 0) as total FROM kartustok WHERE idbarang = ? AND jenis = ?', [item.idbarang, 'K']);
      const stokProgram = masuk.total - keluar.total;
      const selisih = stokProgram - item.jml;

      await conn.query(
        'INSERT INTO penyesuaianstokdtl (idpenyesuaianstok, kodepenyesuaianstok, idbarang, jml, selisih, keterangan) VALUES (?, ?, ?, ?, ?, ?)',
        [header.idpenyesuaianstok, kode, item.idbarang, item.jml, selisih, item.keterangan || '']
      );

      // Kartu stok adjustment
      if (selisih !== 0) {
        const jenis = selisih > 0 ? 'K' : 'M';
        const jmlAbs = Math.abs(selisih);
        await conn.query(
          'INSERT INTO kartustok (kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [kode, item.idbarang, jmlAbs, jenis, tgltrans, `Penyesuaian ${kode}`, header.idpenyesuaianstok, 'penyesuaianstok']
        );
      }
    }

    // Generate saldostok baru
    const saldoDateStr = tgltrans.replace(/-/g, '');
    const [[{ cnt: cntSaldo }]] = await conn.query(`SELECT COUNT(*) as cnt FROM saldostok WHERE kodesaldostok LIKE ?`, [`SD-${saldoDateStr}-%`]);
    const numSaldo = String(cntSaldo + 1).padStart(4, '0');
    const kodeSaldo = `SD-${saldoDateStr}-${numSaldo}`;

    await conn.query(
      'INSERT INTO saldostok (kodesaldostok, tgltrans, keterangan) VALUES (?, ?, ?)',
      [kodeSaldo, tgltrans, 'SALDO PENYESUAIAN STOK']
    );
    const [[saldoHeader]] = await conn.query('SELECT idsaldostok FROM saldostok WHERE kodesaldostok = ?', [kodeSaldo]);

    // Hitung saldo untuk semua barang yang ada di kartustok
    const [allBarang] = await conn.query('SELECT DISTINCT idbarang FROM kartustok');
    for (const b of allBarang) {
      const [[m]] = await conn.query('SELECT COALESCE(SUM(jml), 0) as total FROM kartustok WHERE idbarang = ? AND jenis = ?', [b.idbarang, 'M']);
      const [[k]] = await conn.query('SELECT COALESCE(SUM(jml), 0) as total FROM kartustok WHERE idbarang = ? AND jenis = ?', [b.idbarang, 'K']);
      const saldoAkhir = m.total - k.total;
      if (saldoAkhir > 0) {
        await conn.query(
          'INSERT INTO saldostokdtl (idsaldostok, kodesaldostok, idbarang, jml) VALUES (?, ?, ?, ?)',
          [saldoHeader.idsaldostok, kodeSaldo, b.idbarang, saldoAkhir]
        );
      }
    }

    await conn.commit();
    res.status(201).json({ message: 'Penyesuaian stok berhasil', kode });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// ============ SALDO STOK ============
exports.getSaldoStok = async (req, res) => {
  try {
    const { tgl } = req.query;
<<<<<<< HEAD
    const targetDate = tgl || new Date().toISOString().slice(0, 10);

    // Cek apakah ada saldostok
    const [[saldoExists]] = await pool.query('SELECT COUNT(*) as cnt FROM saldostok');

    if (saldoExists.cnt === 0) {
      // No saldostok yet, use kartustok only
      const [rows] = await pool.query(
        `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil, b.stokmin,
          COALESCE(m.total, 0) - COALESCE(k.total, 0) as stok
        FROM barang b
        LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis='M' GROUP BY idbarang) m ON b.idbarang = m.idbarang
        LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis='K' GROUP BY idbarang) k ON b.idbarang = k.idbarang
        WHERE b.status = 1 ORDER BY b.namabarang`
      );
      return res.json(rows);
    }

    // Gunakan saldostok snapshot + kartustok setelahnya
    const sql = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuankecil, b.stokmin,
      COALESCE(sd.jml, 0) + COALESCE(k.masuk, 0) - COALESCE(k.keluar, 0) as stok
    FROM barang b
    LEFT JOIN (
      SELECT ssd.idbarang, ssd.jml FROM saldostokdtl ssd
      JOIN saldostok ss ON ss.idsaldostok = ssd.idsaldostok
      WHERE ss.tgltrans = (SELECT MAX(tgltrans) FROM saldostok WHERE tgltrans <= ?)
    ) sd ON sd.idbarang = b.idbarang
    LEFT JOIN (
      SELECT idbarang,
        COALESCE(SUM(CASE WHEN jenis='M' THEN jml ELSE 0 END), 0) as masuk,
        COALESCE(SUM(CASE WHEN jenis='K' THEN jml ELSE 0 END), 0) as keluar
      FROM kartustok WHERE tgltrans > (SELECT COALESCE(MAX(tgltrans), '1970-01-01') FROM saldostok WHERE tgltrans <= ?)
      GROUP BY idbarang
    ) k ON k.idbarang = b.idbarang
    WHERE b.status = 1 ORDER BY b.namabarang`;
    const [rows] = await pool.query(sql, [targetDate, targetDate]);
=======
    let sql, params = [];

    if (tgl) {
      // Stock at specific date = latest saldostok <= tgl + kartustok from that date to now
      sql = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuan, b.stokmin,
        COALESCE(sd.jml, 0) + COALESCE(k.masuk, 0) - COALESCE(k.keluar, 0) as stok
        FROM barang b
        LEFT JOIN (
          SELECT ssd.idbarang, ssd.jml FROM saldostokdtl ssd
          JOIN saldostok ss ON ss.idsaldostok = ssd.idsaldostok
          WHERE ss.tgltrans = (SELECT MAX(tgltrans) FROM saldostok WHERE tgltrans <= ?)
        ) sd ON sd.idbarang = b.idbarang
        LEFT JOIN (
          SELECT idbarang,
            COALESCE(SUM(CASE WHEN jenis = 'M' THEN jml ELSE 0 END), 0) as masuk,
            COALESCE(SUM(CASE WHEN jenis = 'K' THEN jml ELSE 0 END), 0) as keluar
          FROM kartustok WHERE tgltrans > ? GROUP BY idbarang
        ) k ON k.idbarang = b.idbarang
        WHERE b.status = 1 ORDER BY b.namabarang`;
      params = [tgl, tgl];
    } else {
      // Current stock from kartustok only
      sql = `SELECT b.idbarang, b.kodebarang, b.namabarang, b.satuan, b.stokmin,
        COALESCE(m.total, 0) - COALESCE(k.total, 0) as stok
        FROM barang b
        LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'M' GROUP BY idbarang) m ON b.idbarang = m.idbarang
        LEFT JOIN (SELECT idbarang, SUM(jml) as total FROM kartustok WHERE jenis = 'K' GROUP BY idbarang) k ON b.idbarang = k.idbarang
        WHERE b.status = 1 ORDER BY b.namabarang`;
    }
    const [rows] = await pool.query(sql, params);
>>>>>>> 503bb98c762027b354d9e9b30ca1c01f18780e37
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getSaldoStokList = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM saldostok ORDER BY tgltrans DESC, idsaldostok DESC LIMIT 50');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

<<<<<<< HEAD
exports.getSaldoStokDetail = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ssd.*, b.namabarang, b.satuankecil, b.kodebarang
       FROM saldostokdtl ssd
       LEFT JOIN barang b ON ssd.idbarang = b.idbarang
       WHERE ssd.idsaldostok = ?`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

=======
>>>>>>> 503bb98c762027b354d9e9b30ca1c01f18780e37
// ============ CLOSING ============
exports.createClosing = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { jenis, tglclosing } = req.body; // 'harian' or 'bulanan'

    const dateStr = tglclosing.replace(/-/g, '');
    const [[{ cnt }]] = await conn.query(`SELECT COUNT(*) as cnt FROM closing WHERE kodeclosing LIKE ?`, [`CLS-${dateStr}-%`]);
    const num = String(cnt + 1).padStart(4, '0');
    const kodeclosing = `CLS-${dateStr}-${num}`;

    await conn.query('INSERT INTO closing (kodeclosing, tglclosing, jenis) VALUES (?, ?, ?)',
      [kodeclosing, tglclosing, jenis]);

    // Generate saldostok baru
    const [[{ cnt: cntSaldo }]] = await conn.query(`SELECT COUNT(*) as cnt FROM saldostok WHERE kodesaldostok LIKE ?`, [`SD-${dateStr}-%`]);
    const numSaldo = String(cntSaldo + 1).padStart(4, '0');
    const kodeSaldo = `SD-${dateStr}-${numSaldo}`;

    await conn.query('INSERT INTO saldostok (kodesaldostok, tgltrans, keterangan) VALUES (?, ?, ?)',
      [kodeSaldo, tglclosing, 'SALDO DARI HITUNG HPP']);

    const [[saldoHeader]] = await conn.query('SELECT idsaldostok FROM saldostok WHERE kodesaldostok = ?', [kodeSaldo]);

    // Get all barang with stock
    const [allBarang] = await conn.query('SELECT DISTINCT idbarang FROM kartustok');
    for (const b of allBarang) {
      const [[m]] = await conn.query('SELECT COALESCE(SUM(jml), 0) as total FROM kartustok WHERE idbarang = ? AND jenis = ?', [b.idbarang, 'M']);
      const [[k]] = await conn.query('SELECT COALESCE(SUM(jml), 0) as total FROM kartustok WHERE idbarang = ? AND jenis = ?', [b.idbarang, 'K']);
      const saldoAkhir = m.total - k.total;
      if (saldoAkhir > 0) {
        await conn.query('INSERT INTO saldostokdtl (idsaldostok, kodesaldostok, idbarang, jml) VALUES (?, ?, ?, ?)',
          [saldoHeader.idsaldostok, kodeSaldo, b.idbarang, saldoAkhir]);
      }
    }

    await conn.commit();
    res.status(201).json({ message: 'Closing berhasil', kodeclosing });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// ============ SALDO AWAL STOK ============
exports.createSaldoAwal = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { idkasir, keterangan, items } = req.body;

    if (!items || !items.length) return res.status(400).json({ message: 'Items tidak boleh kosong' });

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const [[{ cnt }]] = await conn.query('SELECT COUNT(*) as cnt FROM saldostok WHERE kodesaldostok LIKE ?', [`SA-${dateStr}-%`]);
    const num = String(cnt + 1).padStart(4, '0');
    const kodeSaldo = `SA-${dateStr}-${num}`;
    const tgltrans = new Date().toISOString().slice(0, 10);

    await conn.query(
      'INSERT INTO saldostok (kodesaldostok, tgltrans, keterangan) VALUES (?, ?, ?)',
      [kodeSaldo, tgltrans, keterangan || 'SALDO AWAL STOK']
    );
    const [[header]] = await conn.query('SELECT idsaldostok FROM saldostok WHERE kodesaldostok = ?', [kodeSaldo]);

    for (const item of items) {
      await conn.query(
        'INSERT INTO saldostokdtl (idsaldostok, kodesaldostok, idbarang, jml) VALUES (?, ?, ?, ?)',
        [header.idsaldostok, kodeSaldo, item.idbarang, item.jml]
      );

      if (item.jml > 0) {
        await conn.query(
          'INSERT INTO kartustok (kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [kodeSaldo, item.idbarang, item.jml, 'M', tgltrans, `Saldo Awal ${kodeSaldo}`, header.idsaldostok, 'saldostok']
        );
      }
    }

    await conn.commit();
    res.status(201).json({ message: 'Saldo awal stok berhasil', kode: kodeSaldo });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.getClosing = async (req, res) => {
  try {
    const { jenis } = req.query;
    let sql = 'SELECT * FROM closing WHERE 1=1';
    const params = [];
    if (jenis) { sql += ' AND jenis = ?'; params.push(jenis); }
    sql += ' ORDER BY tglclosing DESC, idclosing DESC LIMIT 50';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
<<<<<<< HEAD

// ============ GET STOK PER BARANG ============
exports.getStok = async (req, res) => {
  try {
    const { idbarang } = req.params;
    const targetDate = req.query.tgl || new Date().toISOString().slice(0, 10);

    // Cari saldostok terbaru <= targetDate
    const [[latestSaldo]] = await pool.query(
      `SELECT ss.idsaldostok, ss.tgltrans FROM saldostok ss
       WHERE ss.tgltrans <= ? ORDER BY ss.tgltrans DESC LIMIT 1`,
      [targetDate]
    );

    let stok = 0;
    let fromDate = null;

    if (latestSaldo) {
      const [[snap]] = await pool.query(
        `SELECT COALESCE(jml, 0) as jml FROM saldostokdtl
         WHERE idsaldostok = ? AND idbarang = ?`,
        [latestSaldo.idsaldostok, idbarang]
      );
      stok = snap ? snap.jml : 0;
      fromDate = latestSaldo.tgltrans;
    }

    // Kartu stok: M (masuk) & K (keluar) setelah fromDate s/d targetDate
    const params = [idbarang];
    let dateCond = 'AND tgltrans <= ?';
    params.push(targetDate);
    if (fromDate) {
      dateCond += ' AND tgltrans > ?';
      params.push(fromDate);
    }

    const [[masuk]] = await pool.query(
      `SELECT COALESCE(SUM(jml), 0) as total FROM kartustok
       WHERE idbarang = ? AND jenis = 'M' ${dateCond}`,
      params
    );
    const [[keluar]] = await pool.query(
      `SELECT COALESCE(SUM(jml), 0) as total FROM kartustok
       WHERE idbarang = ? AND jenis = 'K' ${dateCond}`,
      params
    );

    stok += masuk.total - keluar.total;

    res.json({ idbarang: parseInt(idbarang), stok, tgl: targetDate });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
=======
>>>>>>> 503bb98c762027b354d9e9b30ca1c01f18780e37
