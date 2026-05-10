// Helper untuk menghitung stok barang per lokasi pada tanggal tertentu.
// Menggabungkan data dari saldostok (stok awal per periode) dan kartustok (mutasi harian).

/**
 * Menghitung stok suatu barang di suatu lokasi sampai dengan tanggal yang ditentukan.
 * Logika: stok = saldo_stok_terakhir_sebelum_tgl + SUM(mutasi_kartustok_setelah_saldo_sampai_tgl)
 *
 * @param {number} idbarang - ID barang
 * @param {number} idlokasi - ID lokasi
 * @param {string} tgl   - Tanggal batas perhitungan (YYYY-MM-DD)
 * @returns {number} Jumlah stok, 0 jika tidak ditemukan
 */
async function getStok(idbarang, idlokasi, tgl) {
    const sql = `
        SELECT idbarang, idlokasi, SUM(jml) AS totalstok
        FROM (
            -- Bagian 1: Ambil saldo stok terakhir sebelum atau pada tanggal tgl
            SELECT b.idbarang, a.idlokasi, b.jml
            FROM saldostok a
                JOIN saldostokdtl b ON a.idsaldostok = b.idsaldostok
            WHERE a.idlokasi = ?
              AND b.idbarang = ?
              AND a.tgltrans = (
                  SELECT MAX(a1.tgltrans)           -- Ambil saldo dengan tanggal terbesar <= tgl
                  FROM saldostok a1
                      JOIN saldostokdtl b1 ON b1.idsaldostok = a1.idsaldostok
                  WHERE a1.idlokasi = ?
                    AND b1.idbarang = ?
                    AND a1.tgltrans <= ?
              )

            UNION ALL

            -- Bagian 2: Ambil semua mutasi kartustok setelah saldo terakhir sampai tgl
            SELECT d.idbarang, d.idlokasi, d.jml
            FROM kartustok d
            WHERE d.idlokasi = ?
              AND d.idbarang = ?
              AND d.tgltrans > (
                  SELECT COALESCE(MAX(a1.tgltrans), '1900-01-01')  -- Jika belum ada saldo, mulai dari awal
                  FROM saldostok a1
                      JOIN saldostokdtl b1 ON b1.idsaldostok = a1.idsaldostok
                  WHERE a1.idlokasi = ?
                    AND b1.idbarang = ?
                    AND a1.tgltrans <= ?
              )
              AND d.tgltrans <= ?                    -- Batas atas: hanya mutasi sampai tanggal tgl
        ) stok
        GROUP BY idbarang, idlokasi
    `;

    const params = [
        idlokasi, idbarang,          // WHERE saldostok (bagian 1)
        idlokasi, idbarang, tgl,     // Subquery saldo (tanggal terbesar <= tgl)
        idlokasi, idbarang,          // WHERE kartustok (bagian 2)
        idlokasi, idbarang, tgl,     // Subquery kartu (tanggal saldo terakhir)
        tgl                          // AND tgltrans <= tgl (batas mutasi)
    ];

    const [rows] = await db.query(sql, params);

    if (rows.length === 0) return 0;
    return rows[0].totalstok ?? 0;   // Nullish coalescing: default 0 jika totalstok null
}
