// Controller untuk transaksi tukar barang — customer mengembalikan barang lama dan menerima barang baru
// Endpoint: POST /create, GET /getAll, GET /getOne/:id, POST /cancel/:id
const { tenantQuery, tenantExecute, getConnection, getTenantContext } = require('../config/db');
const { generateKodeTukarBarang } = require('../lib/kodetrans');
const logger = require('../lib/logger');

// Daftar tindak lanjut yang valid untuk barang yang dikembalikan
const VALID_TINDAKLANJUT = ['MASUK_STOK', 'MASUK_STOK_2ND', 'HANGUS'];

// POST — Membuat transaksi tukar barang baru. Memproses barang kembali (stok masuk) dan barang baru (stok keluar).
exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const { idcustomer, items_kembali, items_baru, catatan } = req.body;

    // Validasi: kedua daftar barang harus diisi
    if (!items_kembali || !items_kembali.length) return res.status(400).json({ message: 'Barang kembali tidak boleh kosong' });
    if (!items_baru || !items_baru.length) return res.status(400).json({ message: 'Barang baru tidak boleh kosong' });

    // Validasi tiap item barang kembali: tindaklanjut harus valid
    for (const item of items_kembali) {
      if (!VALID_TINDAKLANJUT.includes(item.tindaklanjut)) {
        return res.status(400).json({ message: `tindaklanjut tidak valid: ${item.tindaklanjut}` });
      }
      if (item.tindaklanjut === 'MASUK_STOK_2ND' && !item.idbarang2nd) {
        return res.status(400).json({ message: 'idbarang2nd wajib diisi untuk tindaklanjut MASUK_STOK_2ND' });
      }
    }

    // Generate kode tukar barang unik
    const kodetukarbarang = await generateKodeTukarBarang(conn, ctx.idtenant, ctx.idlokasi);
    const tgltrans = req.body.tgltrans || new Date().toISOString().slice(0, 10);

    // Insert header tukarbarang
    let sql = 'INSERT INTO tukarbarang (idtenant, idlokasi, kodetukarbarang, tgltrans, idcustomer, iduser, catatan, status, userentry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    await conn.query(sql,
      [ctx.idtenant, ctx.idlokasi, kodetukarbarang, tgltrans, idcustomer || null, ctx.iduser, catatan || null, 'AKTIF', ctx.iduser]
    );

    // Ambil id header yang baru dibuat
    let sql2 = 'SELECT idtukarbarang FROM tukarbarang WHERE kodetukarbarang = ? AND idtenant = ? AND idlokasi = ?';
    const [[header]] = await conn.query(sql2,
      [kodetukarbarang, ctx.idtenant, ctx.idlokasi]
    );

    // Simpan barang kembali ke detail + catat stok masuk sesuai tindaklanjut
    for (const item of items_kembali) {
      const subtotal = parseFloat(item.harga || 0) * item.jml;

      let sql3 = 'INSERT INTO tukarbarangdtl_kembali (idtukarbarang, idtenant, idbarang, jml, harga, subtotal, tindaklanjut, idbarang2nd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
      await conn.query(sql3,
        [header.idtukarbarang, ctx.idtenant, item.idbarang, item.jml, item.harga || 0, subtotal, item.tindaklanjut, item.idbarang2nd || null]
      );

      if (item.tindaklanjut === 'MASUK_STOK') {
        let sql4 = 'INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        await conn.query(sql4,
          [ctx.idtenant, ctx.idlokasi, kodetukarbarang, item.idbarang, item.jml, 'M', tgltrans, `Tukar Barang Kembali ${kodetukarbarang}`, header.idtukarbarang, 'tukarbarang']
        );
      } else if (item.tindaklanjut === 'MASUK_STOK_2ND') {
        let sql5 = 'INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        await conn.query(sql5,
          [ctx.idtenant, ctx.idlokasi, kodetukarbarang, item.idbarang2nd, item.jml, 'M', tgltrans, `Tukar Barang Kembali 2nd ${kodetukarbarang}`, header.idtukarbarang, 'tukarbarang']
        );
      }
      // HANGUS: tidak ada pergerakan stok — barang dianggap rusak/hilang
    }

    // Simpan barang baru ke detail + catat stok keluar untuk setiap barang baru
    for (const item of items_baru) {
      const subtotal = parseFloat(item.harga || 0) * item.jml;

      let sql6 = 'INSERT INTO tukarbarangdtl_baru (idtukarbarang, idtenant, idbarang, jml, harga, subtotal) VALUES (?, ?, ?, ?, ?, ?)';
      await conn.query(sql6,
        [header.idtukarbarang, ctx.idtenant, item.idbarang, item.jml, item.harga || 0, subtotal]
      );

      let sql7 = 'INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      await conn.query(sql7,
        [ctx.idtenant, ctx.idlokasi, kodetukarbarang, item.idbarang, item.jml, 'K', tgltrans, `Tukar Barang Baru ${kodetukarbarang}`, header.idtukarbarang, 'tukarbarang']
      );
    }

    await conn.commit();
    await logger.history('TUKARBARANG_CREATE', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: kodetukarbarang, req });
    res.status(201).json({ message: 'Tukar barang berhasil dibuat', kodetukarbarang, idtukarbarang: header.idtukarbarang });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// GET — Mendapatkan daftar tukar barang dengan filter tanggal, customer, dan pencarian kode
exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idcustomer, search } = req.query;
    let sql = `SELECT t.*, c.namacustomer
      FROM tukarbarang t
      LEFT JOIN customer c ON t.idcustomer = c.idcustomer AND c.idtenant = t.idtenant
      WHERE t.idlokasi = ?`;
    const params = [ctx.idlokasi];
    if (tglwal) { sql += ' AND t.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND t.tgltrans <= ?'; params.push(tglakhir); }
    if (idcustomer) { sql += ' AND t.idcustomer = ?'; params.push(idcustomer); }
    if (search) { sql += ' AND t.kodetukarbarang LIKE ?'; params.push(`%${search}%`); }
    sql += ' ORDER BY t.tgltrans DESC, t.idtukarbarang DESC LIMIT 200';
    const rows = await tenantQuery(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET — Mendapatkan detail satu transaksi tukar barang beserta item kembali dan item baru
exports.getOne = async (req, res) => {
  try {
    const ctx = getTenantContext();
    let sql = `SELECT t.*, c.namacustomer
      FROM tukarbarang t
      LEFT JOIN customer c ON t.idcustomer = c.idcustomer AND c.idtenant = t.idtenant
      WHERE t.idtukarbarang = ? AND t.idlokasi = ?`;
    const rows = await tenantQuery(sql, [req.params.id, ctx.idlokasi]);
    if (rows.length === 0) return res.status(404).json({ message: 'Tukar barang tidak ditemukan' });

    let sql2 = `SELECT tk.*, b.namabarang, b.satuankecil,
        b2.namabarang as namabarang2nd
      FROM tukarbarangdtl_kembali tk
      LEFT JOIN barang b ON tk.idbarang = b.idbarang AND b.idtenant = tk.idtenant
      LEFT JOIN barang b2 ON tk.idbarang2nd = b2.idbarang AND b2.idtenant = tk.idtenant
      WHERE tk.idtukarbarang = ?`;
    const items_kembali = await tenantQuery(sql2, [req.params.id]);

    let sql3 = `SELECT tb.*, b.namabarang, b.satuankecil
      FROM tukarbarangdtl_baru tb
      LEFT JOIN barang b ON tb.idbarang = b.idbarang AND b.idtenant = tb.idtenant
      WHERE tb.idtukarbarang = ?`;
    const items_baru = await tenantQuery(sql3, [req.params.id]);

    res.json({ ...rows[0], items_kembali, items_baru });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// POST — Membatalkan transaksi tukar barang: balik semua pergerakan stok (masuk → keluar, keluar → masuk)
exports.cancel = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const { id } = req.params;

    // Cek keberadaan dan status transaksi
    let sql = 'SELECT * FROM tukarbarang WHERE idtukarbarang = ? AND idtenant = ? AND idlokasi = ?';
    const [[tukar]] = await conn.query(sql, [id, ctx.idtenant, ctx.idlokasi]);
    if (!tukar) return res.status(404).json({ message: 'Tukar barang tidak ditemukan' });
    if (tukar.status === 'VOID') return res.status(400).json({ message: 'Transaksi sudah dibatalkan' });

    // Ubah status menjadi VOID
    let sql2 = 'UPDATE tukarbarang SET status = ? WHERE idtukarbarang = ? AND idtenant = ? AND idlokasi = ?';
    await conn.query(sql2, ['VOID', id, ctx.idtenant, ctx.idlokasi]);

    const today = new Date().toISOString().slice(0, 10);

    // Balik stok masuk (dari barang kembali)
    let sql3 = 'SELECT * FROM tukarbarangdtl_kembali WHERE idtukarbarang = ? AND idtenant = ?';
    const [itemsKembali] = await conn.query(sql3, [id, ctx.idtenant]);
    for (const dtl of itemsKembali) {
      if (dtl.tindaklanjut === 'MASUK_STOK') {
        let sql4 = 'INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        await conn.query(sql4,
          [ctx.idtenant, ctx.idlokasi, `VOID-${tukar.kodetukarbarang}`, dtl.idbarang, dtl.jml, 'K', today, `Batal Tukar Barang ${tukar.kodetukarbarang}`, tukar.idtukarbarang, 'tukarbarang_void']
        );
      } else if (dtl.tindaklanjut === 'MASUK_STOK_2ND' && dtl.idbarang2nd) {
        let sql5 = 'INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        await conn.query(sql5,
          [ctx.idtenant, ctx.idlokasi, `VOID-${tukar.kodetukarbarang}`, dtl.idbarang2nd, dtl.jml, 'K', today, `Batal Tukar Barang 2nd ${tukar.kodetukarbarang}`, tukar.idtukarbarang, 'tukarbarang_void']
        );
      }
    }

    // Balik stok keluar (dari barang baru yang dikirim ke customer)
    let sql6 = 'SELECT * FROM tukarbarangdtl_baru WHERE idtukarbarang = ? AND idtenant = ?';
    const [itemsBaru] = await conn.query(sql6, [id, ctx.idtenant]);
    for (const dtl of itemsBaru) {
      let sql7 = 'INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      await conn.query(sql7,
        [ctx.idtenant, ctx.idlokasi, `VOID-${tukar.kodetukarbarang}`, dtl.idbarang, dtl.jml, 'M', today, `Batal Tukar Barang Baru ${tukar.kodetukarbarang}`, tukar.idtukarbarang, 'tukarbarang_void']
      );
    }

    await conn.commit();
    await logger.history('TUKARBARANG_CANCEL', { idtenant: ctx.idtenant, idlokasi: ctx.idlokasi, iduser: ctx.iduser, ref: tukar.kodetukarbarang, req });
    res.json({ message: 'Tukar barang berhasil dibatalkan' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
