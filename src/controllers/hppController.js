const pool = require('../config/db');

function getLastDayOfMonth(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function addOneDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function getPrevMonth(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const prev = new Date(y, m - 2, 1);
  const yy = prev.getFullYear();
  const mm = String(prev.getMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}`;
}

function getFirstTransactionDate(conn) {
  return conn.query(`
    SELECT MIN(tgl) as tgl FROM (
      SELECT MIN(tgltrans) as tgl FROM jual
      UNION ALL
      SELECT MIN(tgltrans) as tgl FROM beli
      UNION ALL
      SELECT MIN(tgltrans) as tgl FROM produksi
      UNION ALL
      SELECT MIN(tgltrans) as tgl FROM penyesuaianstok
    ) t
  `);
}

exports.getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT h.*, u.username as pembuat
       FROM hitunghpp h
       LEFT JOIN users u ON h.iduser = u.iduser
       ORDER BY h.periode_bulan DESC, h.idhitunghpp DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT h.*, u.username as pembuat
       FROM hitunghpp h
       LEFT JOIN users u ON h.iduser = u.iduser
       WHERE h.idhitunghpp = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Hitung HPP tidak ditemukan' });

    const [details] = await pool.query(
      `SELECT d.*, b.kodebarang, b.namabarang, b.satuankecil
       FROM hitunghppdtl d
       JOIN barang b ON d.idbarang = b.idbarang
       WHERE d.idhitunghpp = ?
       ORDER BY b.namabarang`, [req.params.id]);

    res.json({ ...rows[0], details });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { periode_bulan, iduser } = req.body;

    if (!periode_bulan || !/^\d{4}-\d{2}$/.test(periode_bulan)) {
      return res.status(400).json({ message: 'Periode bulan tidak valid (format: YYYY-MM)' });
    }

    // 1. Cek apakah sudah ada hitung HPP untuk bulan ini
    const [[existing]] = await conn.query(
      'SELECT COUNT(*) as cnt FROM hitunghpp WHERE periode_bulan = ?', [periode_bulan]
    );
    if (existing.cnt > 0) {
      return res.status(400).json({ message: `Hitung HPP untuk periode ${periode_bulan} sudah ada` });
    }

    const prevMonth = getPrevMonth(periode_bulan);

    // 2. Cek apakah ada transaksi di bulan sebelumnya
    const [[transJual]] = await conn.query(
      `SELECT COUNT(*) as cnt FROM jual WHERE DATE_FORMAT(tgltrans, '%Y-%m') = ? LIMIT 1`, [prevMonth]
    );
    const [[transBeli]] = await conn.query(
      `SELECT COUNT(*) as cnt FROM beli WHERE DATE_FORMAT(tgltrans, '%Y-%m') = ? LIMIT 1`, [prevMonth]
    );
    const [[transProduksi]] = await conn.query(
      `SELECT COUNT(*) as cnt FROM produksi WHERE DATE_FORMAT(tgltrans, '%Y-%m') = ? LIMIT 1`, [prevMonth]
    );
    const [[transPenyesuaian]] = await conn.query(
      `SELECT COUNT(*) as cnt FROM penyesuaianstok WHERE DATE_FORMAT(tgltrans, '%Y-%m') = ? LIMIT 1`, [prevMonth]
    );
    const transPrevCnt = transJual.cnt + transBeli.cnt + transProduksi.cnt + transPenyesuaian.cnt;

    // 3. Jika ada transaksi di bulan sebelumnya, wajib sudah ada hitunghpp untuk bulan sebelumnya
    if (transPrevCnt > 0) {
      const [[hppPrev]] = await conn.query(
        'SELECT COUNT(*) as cnt FROM hitunghpp WHERE periode_bulan = ?', [prevMonth]
      );
      if (hppPrev.cnt === 0) {
        return res.status(400).json({
          message: `Terdapat transaksi di periode ${prevMonth} namun belum dilakukan Hitung HPP. Silakan hitung HPP periode ${prevMonth} terlebih dahulu.`
        });
      }
    }

    // 4. Tentukan periode
    const [[lastHpp]] = await conn.query(
      'SELECT periode_sampai FROM hitunghpp ORDER BY periode_bulan DESC LIMIT 1'
    );

    let periode_dari;
    if (lastHpp) {
      periode_dari = addOneDay(lastHpp.periode_sampai);
    } else {
      const [[firstTrans]] = await getFirstTransactionDate(conn);
      periode_dari = firstTrans?.tgl || new Date().toISOString().slice(0, 10);
    }

    const periode_sampai = getLastDayOfMonth(periode_bulan);

    if (periode_dari > periode_sampai) {
      return res.status(400).json({ message: 'Periode dari tidak boleh lebih besar dari periode sampai' });
    }

    // Generate kode
    const dateStr = periode_sampai.replace(/-/g, '');
    const [[{ cnt }]] = await conn.query(
      'SELECT COUNT(*) as cnt FROM hitunghpp WHERE kodehitunghpp LIKE ?', [`HPP-${dateStr}-%`]
    );
    const num = String(cnt + 1).padStart(4, '0');
    const kodehitunghpp = `HPP-${dateStr}-${num}`;
    const tgltrans = new Date().toISOString().slice(0, 10);

    // Insert header
    const [headerResult] = await conn.query(
      `INSERT INTO hitunghpp (kodehitunghpp, tgltrans, periode_bulan, periode_dari, periode_sampai, keterangan, iduser)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [kodehitunghpp, tgltrans, periode_bulan, periode_dari, periode_sampai, `Hitung HPP periode ${periode_bulan}`, iduser || null]
    );
    const idhitunghpp = headerResult.insertId;

    // Ambil semua barang aktif
    const [barangs] = await conn.query('SELECT idbarang FROM barang WHERE status = 1 ORDER BY idbarang');

    for (const b of barangs) {
      const idbarang = b.idbarang;

      // === SALDO AWAL ===
      let saldo_awal_qty = 0;
      let saldo_awal_hpp = 0;

      if (lastHpp) {
        // Ambil dari hitunghpp terakhir untuk barang ini
        const [[prevDtl]] = await conn.query(
          `SELECT saldo_akhir_qty, saldo_akhir_hpp FROM hitunghppdtl
           WHERE idbarang = ? AND idhitunghpp = (
             SELECT idhitunghpp FROM hitunghpp ORDER BY periode_bulan DESC LIMIT 1
           )`, [idbarang]
        );
        if (prevDtl) {
          saldo_awal_qty = parseFloat(prevDtl.saldo_akhir_qty) || 0;
          saldo_awal_hpp = parseFloat(prevDtl.saldo_akhir_hpp) || 0;
        }
      } else {
        // Belum pernah hitung HPP, hitung dari kartustok sebelum periode_dari
        const [[masuk]] = await conn.query(
          `SELECT COALESCE(SUM(jml), 0) as total FROM kartustok
           WHERE idbarang = ? AND jenis = 'M' AND tgltrans < ?`, [idbarang, periode_dari]
        );
        const [[keluar]] = await conn.query(
          `SELECT COALESCE(SUM(jml), 0) as total FROM kartustok
           WHERE idbarang = ? AND jenis = 'K' AND tgltrans < ?`, [idbarang, periode_dari]
        );
        saldo_awal_qty = (parseFloat(masuk.total) || 0) - (parseFloat(keluar.total) || 0);

        if (saldo_awal_qty > 0) {
          // Cari rata-rata harga beli sebelum periode
          const [[avgBeli]] = await conn.query(
            `SELECT COALESCE(SUM(subtotal), 0) / NULLIF(SUM(jml), 0) as avg_harga
             FROM belidtl WHERE idbarang = ? AND idbeli IN (
               SELECT idbeli FROM beli WHERE tgltrans < ?
             )`, [idbarang, periode_dari]
          );
          const avgHarga = parseFloat(avgBeli?.avg_harga) || 0;
          if (avgHarga > 0) {
            saldo_awal_hpp = saldo_awal_qty * avgHarga;
          } else {
            // Fallback ke hargabeli terakhir
            const [[lastHB]] = await conn.query(
              `SELECT hargabeli FROM hargabeli WHERE idbarang = ? ORDER BY tgltrans DESC LIMIT 1`, [idbarang]
            );
            saldo_awal_hpp = saldo_awal_qty * (parseFloat(lastHB?.hargabeli) || 0);
          }
        }
      }

      // === PEMBELIAN ===
      const [[pembelian]] = await conn.query(
        `SELECT COALESCE(SUM(d.jml), 0) as qty, COALESCE(SUM(d.subtotal), 0) as total
         FROM belidtl d
         JOIN beli h ON d.idbeli = h.idbeli
         WHERE d.idbarang = ? AND h.tgltrans BETWEEN ? AND ? AND h.status = 1`,
        [idbarang, periode_dari, periode_sampai]
      );
      const pembelian_qty = parseFloat(pembelian?.qty) || 0;
      const pembelian_total = parseFloat(pembelian?.total) || 0;

      // === PRODUKSI (barang jadi masuk dari produksi) ===
      const [[produksi]] = await conn.query(
        `SELECT COALESCE(SUM(qtyhasil), 0) as qty, COALESCE(SUM(totalhpp), 0) as total
         FROM produksi
         WHERE idbarang = ? AND tgltrans BETWEEN ? AND ? AND status = 1`,
        [idbarang, periode_dari, periode_sampai]
      );
      const produksi_qty = parseFloat(produksi?.qty) || 0;
      const produksi_total = parseFloat(produksi?.total) || 0;

      // === PENYESUAIAN (dari kartustok jenisref=penyesuaianstok) ===
      const [[penyM]] = await conn.query(
        `SELECT COALESCE(SUM(jml), 0) as total FROM kartustok
         WHERE idbarang = ? AND jenis = 'M' AND jenisref = 'penyesuaianstok' AND tgltrans BETWEEN ? AND ?`,
        [idbarang, periode_dari, periode_sampai]
      );
      const [[penyK]] = await conn.query(
        `SELECT COALESCE(SUM(jml), 0) as total FROM kartustok
         WHERE idbarang = ? AND jenis = 'K' AND jenisref = 'penyesuaianstok' AND tgltrans BETWEEN ? AND ?`,
        [idbarang, periode_dari, periode_sampai]
      );
      const penyesuaian_qty = (parseFloat(penyM?.total) || 0) - (parseFloat(penyK?.total) || 0);
      // HPP penyesuaian pakai hpp_per_unit sementara, nanti dihitung ulang
      // Untuk menyederhanakan, penyesuaian masuk harganya 0 (karena tidak ada nilai pembelian),
      // kecuali kita pakai harga rata-rata sebelumnya. Saya akan anggap 0 dulu,
      // tapi sebenarnya penyesuaian seharusnya tidak terlalu banyak.
      // Lebih baik: hitung hpp penyesuaian dari harga rata-rata barang sebelum periode
      let penyesuaian_total = 0;
      if (penyesuaian_qty !== 0) {
        const totalQtyForAvg = saldo_awal_qty + pembelian_qty + produksi_qty;
        const totalHppForAvg = saldo_awal_hpp + pembelian_total + produksi_total;
        const avgUnit = totalQtyForAvg > 0 ? totalHppForAvg / totalQtyForAvg : 0;
        penyesuaian_total = penyesuaian_qty * avgUnit;
      }

      // === PENJUALAN ===
      const [[penjualan]] = await conn.query(
        `SELECT COALESCE(SUM(d.jml), 0) as qty
         FROM jualdtl d
         JOIN jual h ON d.idjual = h.idjual
         WHERE d.idbarang = ? AND h.tgltrans BETWEEN ? AND ? AND h.status = 1`,
        [idbarang, periode_dari, periode_sampai]
      );
      const penjualan_qty = parseFloat(penjualan?.qty) || 0;

      // === HITUNG HPP ===
      const total_qty = saldo_awal_qty + pembelian_qty + produksi_qty + penyesuaian_qty;
      const total_hpp = saldo_awal_hpp + pembelian_total + produksi_total + penyesuaian_total;
      const hpp_per_unit = total_qty > 0 ? total_hpp / total_qty : 0;
      const penjualan_hpp = penjualan_qty * hpp_per_unit;
      const saldo_akhir_qty = total_qty - penjualan_qty;
      const saldo_akhir_hpp = total_hpp - penjualan_hpp;

      await conn.query(
        `INSERT INTO hitunghppdtl
         (idhitunghpp, kodehitunghpp, idbarang, saldo_awal_qty, saldo_awal_hpp,
          pembelian_qty, pembelian_total, produksi_qty, produksi_total,
          penyesuaian_qty, penyesuaian_total, penjualan_qty, penjualan_hpp,
          saldo_akhir_qty, saldo_akhir_hpp, hpp_per_unit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          idhitunghpp, kodehitunghpp, idbarang,
          saldo_awal_qty, saldo_awal_hpp,
          pembelian_qty, pembelian_total,
          produksi_qty, produksi_total,
          penyesuaian_qty, penyesuaian_total,
          penjualan_qty, penjualan_hpp,
          saldo_akhir_qty, saldo_akhir_hpp, hpp_per_unit
        ]
      );
    }

    await conn.commit();
    res.status(201).json({ message: 'Hitung HPP berhasil', idhitunghpp, kodehitunghpp });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.remove = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM hitunghpp WHERE idhitunghpp = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Hitung HPP tidak ditemukan' });

    // Hapus detail (cascade) dan header
    await conn.query('DELETE FROM hitunghpp WHERE idhitunghpp = ?', [req.params.id]);

    await conn.commit();
    res.json({ message: 'Hitung HPP berhasil dihapus' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
