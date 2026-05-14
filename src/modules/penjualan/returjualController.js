// Controller untuk transaksi retur penjualan — menangani pengembalian barang dari customer
// Endpoint: POST /create, GET /getAll, GET /getOne/:id, POST /cancel/:id
const { tenantQuery, tenantExecute, getConnection, getTenantContext } = require('../../config/db');
const { generateKodeReturJual } = require('../../lib/kodetrans');
const logger = require('../../lib/logger');

// Daftar tindak lanjut yang valid untuk barang retur
const VALID_TINDAKLANJUT = ['MASUK_STOK', 'MASUK_STOK_2ND', 'HANGUS'];

// POST — Membuat retur penjualan baru. Menyimpan header, detail, pergerakan stok, dan piutang jika ada customer.
exports.create = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const { idcustomer, idlokasi, idjual, kodejual, items, catatan } = req.body;

    // Validasi: minimal satu item retur
    if (!items || !items.length) {
      await conn.rollback();
      return res.status(400).json({ message: 'Items tidak boleh kosong' });
    }
    if (!idcustomer) {
      await conn.rollback();
      return res.status(400).json({ message: 'Customer wajib dipilih' });
    }
    if (!idlokasi) {
      await conn.rollback();
      return res.status(400).json({ message: 'Lokasi wajib dipilih' });
    }

    // Validasi tiap item: tindaklanjut harus valid dan idbarang2nd wajib jika tindaklanjut MASUK_STOK_2ND
    for (const item of items) {
      if (!VALID_TINDAKLANJUT.includes(item.tindaklanjut)) {
        await conn.rollback();
        return res.status(400).json({ message: `tindaklanjut tidak valid: ${item.tindaklanjut}` });
      }
      if (item.tindaklanjut === 'MASUK_STOK_2ND' && !item.idbarang2nd) {
        await conn.rollback();
        return res.status(400).json({ message: 'idbarang2nd wajib diisi untuk tindaklanjut MASUK_STOK_2ND' });
      }
    }

    // Generate kode retur unik per lokasi
    const kodereturjual = await generateKodeReturJual(conn, ctx.idtenant, idlokasi);
    const tgltrans = req.body.tgltrans || new Date().toISOString().slice(0, 10);

    // Insert header returjual
    let sql = 'INSERT INTO returjual (idtenant, idlokasi, kodereturjual, tgltrans, idcustomer, idjual, kodejual, iduser, total, catatan, status, userentry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)';
    await conn.query(sql,
      [ctx.idtenant, idlokasi, kodereturjual, tgltrans, idcustomer, idjual || null, kodejual || null, ctx.iduser, catatan || null, 'AKTIF', ctx.iduser]
    );

    // Ambil id header yang baru dibuat
    let sql2 = 'SELECT idreturjual FROM returjual WHERE kodereturjual = ? AND idtenant = ? AND idlokasi = ?';
    const [[header]] = await conn.query(sql2,
      [kodereturjual, ctx.idtenant, idlokasi]
    );

    // Akumulasi total retur dari seluruh item
    let calculatedTotal = 0;

    for (const item of items) {
      const subtotal = parseFloat(item.harga || 0) * item.jml;
      calculatedTotal += subtotal;

      // Insert detail retur per item
      let sql3 = 'INSERT INTO returjualdtl (idreturjual, idtenant, idbarang, jml, harga, subtotal, tindaklanjut, idbarang2nd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
      await conn.query(sql3,
        [header.idreturjual, ctx.idtenant, item.idbarang, item.jml, item.harga || 0, subtotal, item.tindaklanjut, item.idbarang2nd || null]
      );

      // Pergerakan stok sesuai tindaklanjut: MASUK_STOK → stok normal, MASUK_STOK_2ND → stok second
      if (item.tindaklanjut === 'MASUK_STOK') {
        let sql4 = 'INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        await conn.query(sql4,
          [ctx.idtenant, idlokasi, kodereturjual, item.idbarang, item.jml, 'M', tgltrans, `Retur Penjualan ${kodereturjual}`, header.idreturjual, 'returjual']
        );
      } else if (item.tindaklanjut === 'MASUK_STOK_2ND') {
        let sql5 = 'INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        await conn.query(sql5,
          [ctx.idtenant, idlokasi, kodereturjual, item.idbarang2nd, item.jml, 'M', tgltrans, `Retur Penjualan 2nd ${kodereturjual}`, header.idreturjual, 'returjual']
        );
      }
      // HANGUS: tidak ada pergerakan stok — barang dianggap rusak/hilang
    }

    // Update total retur di header setelah semua item dihitung
    let sql6 = 'UPDATE returjual SET total = ? WHERE idreturjual = ? AND idtenant = ?';
    await conn.query(sql6,
      [calculatedTotal, header.idreturjual, ctx.idtenant]);

    // Jika retur terkait penjualan & customer, catat pengurang piutang
    if (kodejual && idcustomer) {
      let sql7 = 'INSERT INTO kartupiutang (idtenant, idlokasi, idcustomer, kodetrans, jenis, kodetransreferensi, amount, tgltrans, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
      await conn.query(sql7,
        [ctx.idtenant, idlokasi, idcustomer, kodejual, 'RETUR', kodereturjual, -calculatedTotal, tgltrans, 'OPEN']
      );
    }

    await conn.commit();
    await logger.history('RETURJUAL_CREATE', { idtenant: ctx.idtenant, idlokasi, iduser: ctx.iduser, ref: kodereturjual, detail: { total: calculatedTotal }, req });
    res.status(201).json({ message: 'Retur berhasil dibuat', kodereturjual, idreturjual: header.idreturjual, total: calculatedTotal });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// GET — Mendapatkan daftar retur penjualan dengan filter tanggal, customer, dan pencarian kode
exports.getAll = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { tglwal, tglakhir, idcustomer, idlokasi, search } = req.query;
    let sql = `SELECT r.*, c.namacustomer
      FROM returjual r
      LEFT JOIN customer c ON r.idcustomer = c.idcustomer AND c.idtenant = r.idtenant
      WHERE r.idtenant = ?`;
    const params = [ctx.idtenant];
    if (idlokasi) { sql += ' AND r.idlokasi = ?'; params.push(idlokasi); }
    if (tglwal) { sql += ' AND r.tgltrans >= ?'; params.push(tglwal); }
    if (tglakhir) { sql += ' AND r.tgltrans <= ?'; params.push(tglakhir); }
    if (idcustomer) { sql += ' AND r.idcustomer = ?'; params.push(idcustomer); }
    if (search) { sql += ' AND r.kodereturjual LIKE ?'; params.push(`%${search}%`); }
    sql += ' ORDER BY r.tgltrans DESC, r.idreturjual DESC LIMIT 200';
    const rows = await tenantQuery(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET — Mendapatkan detail satu retur penjualan beserta item-itemnya
exports.getOne = async (req, res) => {
  try {
    const ctx = getTenantContext();
    let sql = `SELECT r.*, c.namacustomer
      FROM returjual r
      LEFT JOIN customer c ON r.idcustomer = c.idcustomer AND c.idtenant = r.idtenant
      WHERE r.idreturjual = ? AND r.idtenant = ?`;
    const rows = await tenantQuery(sql, [req.params.id, ctx.idtenant]);
    if (rows.length === 0) return res.status(404).json({ message: 'Retur tidak ditemukan' });

    let sql2 = `SELECT rd.*, b.namabarang, b.satuankecil,
        b2.namabarang as namabarang2nd
      FROM returjualdtl rd
      LEFT JOIN barang b ON rd.idbarang = b.idbarang AND b.idtenant = rd.idtenant
      LEFT JOIN barang b2 ON rd.idbarang2nd = b2.idbarang AND b2.idtenant = rd.idtenant
      WHERE rd.idreturjual = ?`;
    const items = await tenantQuery(sql2, [req.params.id]);
    res.json({ ...rows[0], items });
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// POST — Membatalkan retur penjualan: ubah status ke VOID, balik pergerakan stok, hapus piutang
exports.cancel = async (req, res) => {
  const conn = await getConnection();
  try {
    const ctx = getTenantContext();
    await conn.beginTransaction();
    const { id } = req.params;

    // Cek keberadaan dan status retur
    let sql = 'SELECT * FROM returjual WHERE idreturjual = ? AND idtenant = ?';
    const [[retur]] = await conn.query(sql, [id, ctx.idtenant]);
    if (!retur) {
      await conn.rollback();
      return res.status(404).json({ message: 'Retur tidak ditemukan' });
    }
    if (retur.status === 'VOID') {
      await conn.rollback();
      return res.status(400).json({ message: 'Retur sudah dibatalkan' });
    }

    // Ubah status retur menjadi VOID
    let sql2 = 'UPDATE returjual SET status = ? WHERE idreturjual = ? AND idtenant = ? AND idlokasi = ?';
    await conn.query(sql2, ['VOID', id, ctx.idtenant, retur.idlokasi]);

    // Hapus catatan piutang terkait retur ini
    let sql3 = "DELETE FROM kartupiutang WHERE kodetransreferensi = ? AND idtenant = ? AND idlokasi = ? AND jenis = 'RETUR'";
    await conn.query(sql3,
      [retur.kodereturjual, ctx.idtenant, retur.idlokasi]
    );

    let sql4 = 'SELECT * FROM returjualdtl WHERE idreturjual = ? AND idtenant = ?';
    const [details] = await conn.query(sql4, [id, ctx.idtenant]);
    const today = new Date().toISOString().slice(0, 10);

    // Balik semua pergerakan stok dari detail retur (MASUK → KELUAR)
    for (const dtl of details) {
      if (dtl.tindaklanjut === 'MASUK_STOK') {
        let sql5 = 'INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        await conn.query(sql5,
          [ctx.idtenant, retur.idlokasi, `VOID-${retur.kodereturjual}`, dtl.idbarang, dtl.jml, 'K', today, `Batal Retur ${retur.kodereturjual}`, retur.idreturjual, 'returjual_void']
        );
      } else if (dtl.tindaklanjut === 'MASUK_STOK_2ND' && dtl.idbarang2nd) {
        let sql6 = 'INSERT INTO kartustok (idtenant, idlokasi, kodetrans, idbarang, jml, jenis, tgltrans, keterangan, idref, jenisref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        await conn.query(sql6,
          [ctx.idtenant, retur.idlokasi, `VOID-${retur.kodereturjual}`, dtl.idbarang2nd, dtl.jml, 'K', today, `Batal Retur 2nd ${retur.kodereturjual}`, retur.idreturjual, 'returjual_void']
        );
      }
    }

    await conn.commit();
    await logger.history('RETURJUAL_CANCEL', { idtenant: ctx.idtenant, idlokasi: retur.idlokasi, iduser: ctx.iduser, ref: retur.kodereturjual, req });
    res.json({ message: 'Retur berhasil dibatalkan' });
  } catch (err) {
    await conn.rollback();
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
