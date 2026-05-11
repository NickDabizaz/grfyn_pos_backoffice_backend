/* Controller transaksi produksi.
   Menangani CRUD produksi: pencatatan bahan baku/setengah jadi keluar dan
   bahan jadi masuk, validasi stok, kalkulasi total, integrasi kartu stok,
   dan pembatalan (void). */
const { tenantQuery, tenantExecute, getConnection, getTenantContext } = require('../config/db');
const { generateKodeProduksi } = require('../lib/kodetrans');
const logger = require('../lib/logger');

// Helper: ambil jenis dan nama barang dari master
async function getBarangInfo(conn, idbarang, idtenant) {
  const query = `SELECT idbarang, namabarang, jenis, 
                 satuanbesar, satuansedang, satuankecil, konversi1, konversi2 
                 FROM barang WHERE idbarang = ? AND idtenant = ?`;
  const [[row]] = await conn.query(query, [idbarang, idtenant]);
  return row || null;
}

// Helper: Konversi jumlah item ke satuan terkecil
function toKecilJml(jml, satuan, barang) {
  const k1 = Math.max(parseInt(barang.konversi1) || 1, 1); // Besar -> Sedang
  const k2 = Math.max(parseInt(barang.konversi2) || 1, 1); // Sedang -> Kecil

  if (satuan && barang.satuanbesar && satuan === barang.satuanbesar) return jml * k1 * k2;
  if (satuan && barang.satuansedang && satuan === barang.satuansedang) return jml * k2;

  return jml;
}

// Helper: validasi struktur items dari request
function validateItems(items) {
  if (!items || !items.length) {
    return { valid: false, message: 'Items tidak boleh kosong' };
  }

  let hasBahanJadi = false;
  let hasBahanBaku = false;

  for (const item of items) {
    if (!item.idbarang || !item.jml || item.jml <= 0) {
      return { valid: false, message: 'Setiap item harus memiliki idbarang dan jml > 0' };
    }
    const jenis = item._jenis; // Diset setelah lookup master barang
    if (jenis === 'BAHAN JADI') hasBahanJadi = true;
    if (jenis === 'BAHAN BAKU' || jenis === 'BAHAN SETENGAH JADI') hasBahanBaku = true;
  }

  if (!hasBahanJadi) {
    return { valid: false, message: 'Minimal harus ada 1 barang jadi sebagai hasil produksi' };
  }
  if (!hasBahanBaku) {
    return { valid: false, message: 'Minimal harus ada 1 bahan baku atau bahan setengah jadi' };
  }

  return { valid: true };
}

// helper function untuk melakukan pengecekan stok
async function checkStock(conn, idbarang, idtenant, idlokasi, jml, namabarang, excludeIdproduksi = null) {
  const excludeClause = excludeIdproduksi ? 'AND NOT (jenisref = "produksi" AND idref = ?)' : '';
  
  const query = `
    SELECT (
        COALESCE((
            SELECT dtl.qty FROM saldostok h
            JOIN saldostokdtl dtl ON h.idsaldostok = dtl.idsaldostok
            WHERE h.idtenant = ? AND h.idlokasi = ? AND dtl.idbarang = ?
            ORDER BY h.tgltrans DESC LIMIT 1
        ), 0) 
        + 
        COALESCE((
            SELECT SUM(CASE WHEN jenis = 'M' THEN jml ELSE -jml END)
            FROM kartustok
            WHERE idtenant = ? AND idlokasi = ? AND idbarang = ?
            ${excludeClause}
            AND tgltrans > COALESCE(
                (SELECT MAX(tgltrans) FROM saldostok WHERE idtenant = ? AND idlokasi = ?), 
                '1900-01-01'
            )
        ), 0)
    ) AS stok`;

  const params = [
    idtenant, idlokasi, idbarang, // Saldo terakhir
    idtenant, idlokasi, idbarang  // Mutasi kartustok
  ];

  if (excludeIdproduksi) params.push(excludeIdproduksi);

  params.push(idtenant, idlokasi); // Parameter untuk MAX tgltrans

  const [rows] = await conn.query(query, params);
  const stok = parseFloat(rows[0].stok || 0);
  const butuh = parseFloat(jml);

  if (stok < butuh) {
    return {
      cukup: false,
      message: `Stok ${namabarang} tidak mencukupi. Stok: ${stok}, Butuh: ${butuh}`
    };
  }
  
  return { cukup: true, stok };
}

// POST /produksi — Buat transaksi produksi baru
exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const { items, tgltrans, catatan } = req.body;

    // Validasi items tidak kosong
    if (!items || !items.length) return res.status(400).json({ message: 'Items tidak boleh kosong' });

    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const today = tgltrans || localToday;

    // 1. Lookup master barang untuk setiap item — dapatkan jenis dan namabarang
    const barangCache = {};
    for (const item of items) {
      const b = await getBarangInfo(conn, item.idbarang, ctx.idtenant);
      if (!b) {
        return res.status(400).json({ message: `Barang dengan id ${item.idbarang} tidak ditemukan` });
      }
      item._jenis = b.jenis;
      item._namabarang = b.namabarang;
      item._barangInfo = b; // Simpan info lengkap untuk konversi
      barangCache[item.idbarang] = b;
    }

    // 2. Validasi minimal 1 BAHAN JADI dan 1 BAHAN BAKU/SETENGAH JADI
    const valid = validateItems(items);
    if (!valid.valid) return res.status(400).json({ message: valid.message });

    // 3. Validasi stok untuk item non-BAHAN JADI
    for (const item of items) {
      if (item._jenis === 'BAHAN JADI') continue;
      
      // Konversi ke qty kecil untuk check stok
      const jmlKecil = toKecilJml(item.jml, item.satuan, item._barangInfo);
      
      const stokCheck = await checkStock(conn, item.idbarang, ctx.idtenant, ctx.idlokasi, jmlKecil, item._namabarang);
      if (!stokCheck.cukup) return res.status(400).json({ message: stokCheck.message });
      
      // Simpan jmlKecil di item agar tidak hitung ulang
      item._jmlKecil = jmlKecil;
    }

    // 4. Generate kode produksi
    const kodeproduksi = await generateKodeProduksi(conn, ctx.idtenant, ctx.idlokasi);

    // 5. Hitung total
    let totalBahan = 0;
    let totalHasil = 0;
    for (const item of items) {
      if (item._jenis === 'BAHAN JADI') {
        totalHasil += parseFloat(item.jml);
      } else {
        totalBahan += parseFloat(item.jml);
      }
    }

    // 6. Insert header
    const insertHeaderQuery = `INSERT INTO produksi
      (idtenant, kodeproduksi, idlokasi, tgltrans, catatan, total_bahan, total_hasil, status, userentry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const [result] = await conn.query(insertHeaderQuery, [
      ctx.idtenant, kodeproduksi, ctx.idlokasi, today,
      catatan || null, totalBahan, totalHasil, 'AKTIF', ctx.iduser
    ]);

    const idproduksi = result.insertId;

    // 7. Insert detail & kartu stok per item
    const hargaBeliQuery = `SELECT hargabeli FROM hargabeli
      WHERE idbarang = ? AND idtenant = ?
      ORDER BY tgltrans DESC, idhargabeli DESC LIMIT 1`;
    const insertDetailQuery = `INSERT INTO produksidtl
      (idproduksi, idtenant, idbarang, jenisbarang, jml, satuan, harga_satuan, subtotal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const insertKartustokQuery = `INSERT INTO kartustok
      (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    for (const item of items) {
      // Harga satuan dari harga beli terakhir
      const [[hargaBeliRow]] = await conn.query(hargaBeliQuery, [item.idbarang, ctx.idtenant]);
      const hargaSatuan = hargaBeliRow ? parseFloat(hargaBeliRow.hargabeli) : 0;
      const subtotal = hargaSatuan * parseFloat(item.jml);

      // Insert detail
      await conn.query(insertDetailQuery, [
        idproduksi, ctx.idtenant, item.idbarang, item._jenis,
        item.jml, item.satuan || null, hargaSatuan, subtotal
      ]);

      // Kartu stok: BAHAN JADI masuk (M), lainnya keluar (K)
      const jenisStok = item._jenis === 'BAHAN JADI' ? 'M' : 'K';
      const jmlKecil = item._jmlKecil || toKecilJml(item.jml, item.satuan, item._barangInfo);
      
      await conn.query(insertKartustokQuery, [
        ctx.idtenant, ctx.idlokasi, kodeproduksi, item.idbarang, jmlKecil,
        jenisStok, today, `Produksi ${kodeproduksi}`, idproduksi, 'produksi'
      ]);
    }

    await conn.commit();
    await logger.history('PRODUKSI_CREATE', {
      idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser,
      ref: kodeproduksi, detail: { total_bahan: totalBahan, total_hasil: totalHasil }, req
    });
    res.status(201).json({
      message: 'Produksi berhasil dicatat',
      kodeproduksi,
      idproduksi: idproduksi,
      total_bahan: totalBahan,
      total_hasil: totalHasil
    });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// GET /produksi — Daftar transaksi produksi (limit 200)
exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, search, status } = req.query;

    let query = `SELECT p.*, DATE_FORMAT(p.tgltrans, '%Y-%m-%d') AS tgltrans, u.namauser
      FROM produksi p
      LEFT JOIN user u ON p.userentry = u.iduser AND u.idtenant = p.idtenant
      WHERE p.idtenant = ? AND p.idlokasi = ?`;
    const params = [ctx.idtenant, ctx.idlokasi];

    if (tglwal)     { query += ' AND p.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir)   { query += ' AND p.tgltrans <= ?'; params.push(tglakhir); }
    if (search)     { query += ' AND p.kodeproduksi LIKE ?'; params.push(`%${search}%`); }
    if (status)     { query += ' AND p.status = ?'; params.push(status); }

    query += ' ORDER BY p.tgltrans DESC, p.idproduksi DESC LIMIT 200';
    const rows = await tenantQuery(query, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /produksi/:id — Detail satu transaksi produksi
exports.getOne = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { id } = req.params;

    const headerQuery = `SELECT p.*, DATE_FORMAT(p.tgltrans, '%Y-%m-%d') AS tgltrans,
      u.namauser, l.namalokasi
      FROM produksi p
      LEFT JOIN user u ON p.userentry = u.iduser AND u.idtenant = p.idtenant
      LEFT JOIN lokasi l ON p.idlokasi = l.idlokasi AND l.idtenant = p.idtenant
      WHERE p.idproduksi = ? AND p.idtenant = ? AND p.idlokasi = ?`;
    const rows = await tenantQuery(headerQuery, [id, ctx.idtenant, ctx.idlokasi]);
    if (rows.length === 0) return res.status(404).json({ message: 'Produksi tidak ditemukan' });

    const detailQuery = `SELECT pd.*, b.namabarang, b.satuankecil, b.satuanbesar, b.satuansedang, b.konversi1, b.konversi2
      FROM produksidtl pd
      LEFT JOIN barang b ON pd.idbarang = b.idbarang AND b.idtenant = pd.idtenant
      WHERE pd.idproduksi = ? AND pd.idtenant = ?`;
    const items = await tenantQuery(detailQuery, [id, ctx.idtenant]);

    res.json({ ...rows[0], items });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /produksi/:id/check-edit — Cek kelayakan edit/cancel
exports.checkEdit = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { id } = req.params;

    const query = 'SELECT status FROM produksi WHERE idproduksi = ? AND idtenant = ? AND idlokasi = ?';
    const rows = await tenantQuery(query, [id, ctx.idtenant, ctx.idlokasi]);

    if (rows.length === 0) return res.status(404).json({ message: 'Produksi tidak ditemukan' });

    if (rows[0].status === 'VOID') {
      return res.json({ canEdit: false, reason: 'ALREADY_VOID', message: 'Produksi sudah dibatalkan' });
    }

    res.json({ canEdit: true });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// PUT /produksi/:id — Edit penuh transaksi produksi (hapus lama, buat ulang)
exports.update = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const { id } = req.params;
    const { items, tgltrans, catatan } = req.body;

    if (!items || !items.length) return res.status(400).json({ message: 'Items tidak boleh kosong' });

    // 1. Cek produksi ada dan bukan VOID
    const selectHeaderQuery = 'SELECT * FROM produksi WHERE idproduksi = ? AND idtenant = ? AND idlokasi = ?';
    const [[produksi]] = await conn.query(selectHeaderQuery, [id, ctx.idtenant, ctx.idlokasi]);
    if (!produksi) return res.status(404).json({ message: 'Produksi tidak ditemukan' });
    if (produksi.status === 'VOID') return res.status(400).json({ message: 'Produksi sudah dibatalkan, tidak dapat diedit' });

    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const today = tgltrans || localToday;

    // 2. Lookup master barang
    for (const item of items) {
      const b = await getBarangInfo(conn, item.idbarang, ctx.idtenant);
      if (!b) {
        return res.status(400).json({ message: `Barang dengan id ${item.idbarang} tidak ditemukan` });
      }
      item._jenis = b.jenis;
      item._namabarang = b.namabarang;
      item._barangInfo = b;
    }

    // 3. Validasi struktur
    const valid = validateItems(items);
    if (!valid.valid) return res.status(400).json({ message: valid.message });

    // 4. Validasi stok (exclude kartustok dari produksi ini)
    for (const item of items) {
      if (item._jenis === 'BAHAN JADI') continue;
      
      const jmlKecil = toKecilJml(item.jml, item.satuan, item._barangInfo);
      
      const stokCheck = await checkStock(
        conn, item.idbarang, ctx.idtenant, ctx.idlokasi, jmlKecil, item._namabarang, id
      );
      if (!stokCheck.cukup) return res.status(400).json({ message: stokCheck.message });
      
      item._jmlKecil = jmlKecil;
    }

    // 5. Hapus kartustok lama
    const deleteKartustokQuery = `DELETE FROM kartustok
      WHERE idref = ? AND jenisref = ? AND idtenant = ? AND idlokasi = ?`;
    await conn.query(deleteKartustokQuery, [id, 'produksi', ctx.idtenant, ctx.idlokasi]);

    // 6. Hapus detail lama
    const deleteDetailQuery = 'DELETE FROM produksidtl WHERE idproduksi = ? AND idtenant = ?';
    await conn.query(deleteDetailQuery, [id, ctx.idtenant]);

    // 7. Insert ulang detail & kartu stok
    let totalBahan = 0;
    let totalHasil = 0;

    const hargaBeliQuery = `SELECT hargabeli FROM hargabeli
      WHERE idbarang = ? AND idtenant = ?
      ORDER BY tgltrans DESC, idhargabeli DESC LIMIT 1`;
    const insertDetailQuery = `INSERT INTO produksidtl
      (idproduksi, idtenant, idbarang, jenisbarang, jml, satuan, harga_satuan, subtotal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const insertKartustokQuery = `INSERT INTO kartustok
      (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    for (const item of items) {
      if (item._jenis === 'BAHAN JADI') {
        totalHasil += parseFloat(item.jml);
      } else {
        totalBahan += parseFloat(item.jml);
      }

      const [[hargaBeliRow]] = await conn.query(hargaBeliQuery, [item.idbarang, ctx.idtenant]);
      const hargaSatuan = hargaBeliRow ? parseFloat(hargaBeliRow.hargabeli) : 0;
      const subtotal = hargaSatuan * parseFloat(item.jml);

      await conn.query(insertDetailQuery, [
        id, ctx.idtenant, item.idbarang, item._jenis,
        item.jml, item.satuan || null, hargaSatuan, subtotal
      ]);

      const jenisStok = item._jenis === 'BAHAN JADI' ? 'M' : 'K';
      const jmlKecil = item._jmlKecil || toKecilJml(item.jml, item.satuan, item._barangInfo);

      await conn.query(insertKartustokQuery, [
        ctx.idtenant, ctx.idlokasi, produksi.kodeproduksi, item.idbarang, jmlKecil,
        jenisStok, today, `Produksi ${produksi.kodeproduksi}`, id, 'produksi'
      ]);
    }

    // 8. Update header
    const updateHeaderQuery = `UPDATE produksi
      SET tgltrans = ?, catatan = ?, total_bahan = ?, total_hasil = ?
      WHERE idproduksi = ? AND idtenant = ? AND idlokasi = ?`;
    await conn.query(updateHeaderQuery, [
      today, catatan || null, totalBahan, totalHasil, id, ctx.idtenant, ctx.idlokasi
    ]);

    await conn.commit();
    await logger.history('PRODUKSI_UPDATE', {
      idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser,
      ref: produksi.kodeproduksi, detail: { total_bahan: totalBahan, total_hasil: totalHasil }, req
    });
    res.json({
      message: 'Produksi berhasil diupdate',
      kodeproduksi: produksi.kodeproduksi,
      idproduksi: id,
      total_bahan: totalBahan,
      total_hasil: totalHasil
    });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// PUT /produksi/:id/cancel — Batalkan produksi (void stok)
exports.cancel = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();

    const { id } = req.params;

    // 1. Cek produksi ada
    const selectHeaderQuery = 'SELECT * FROM produksi WHERE idproduksi = ? AND idtenant = ? AND idlokasi = ?';
    const [[produksi]] = await conn.query(selectHeaderQuery, [id, ctx.idtenant, ctx.idlokasi]);
    if (!produksi) return res.status(404).json({ message: 'Produksi tidak ditemukan' });
    if (produksi.status === 'VOID') return res.status(400).json({ message: 'Produksi sudah dibatalkan' });

    // 2. Update status ke VOID
    await conn.query(
      'UPDATE produksi SET status = ? WHERE idproduksi = ? AND idtenant = ? AND idlokasi = ?',
      ['VOID', id, ctx.idtenant, ctx.idlokasi]
    );

    // 3. Ambil semua detail
    const [details] = await conn.query(
      'SELECT * FROM produksidtl WHERE idproduksi = ? AND idtenant = ?',
      [id, ctx.idtenant]
    );

    // 4. Balik semua pergerakan stok
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const insertKartustokQuery = `INSERT INTO kartustok
      (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    for (const dtl of details) {
      const jenisBalik = dtl.jenisbarang === 'BAHAN JADI' ? 'K' : 'M';
      
      // Ambil info barang untuk konversi pembatalan
      const b = await getBarangInfo(conn, dtl.idbarang, ctx.idtenant);
      const jmlKecil = b ? toKecilJml(dtl.jml, dtl.satuan, b) : dtl.jml;

      await conn.query(insertKartustokQuery, [
        ctx.idtenant, ctx.idlokasi, `VOID-${produksi.kodeproduksi}`, dtl.idbarang,
        jmlKecil, jenisBalik, today, `Pembatalan ${produksi.kodeproduksi}`, id, 'produksi_void'
      ]);
    }

    await conn.commit();
    await logger.history('PRODUKSI_CANCEL', {
      idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser,
      ref: produksi.kodeproduksi, req
    });
    res.json({ message: 'Produksi berhasil dibatalkan' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
