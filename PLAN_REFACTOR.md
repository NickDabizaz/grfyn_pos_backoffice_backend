Rencana Refaktor & Peningkatan Sistem (Production-Ready Plan)

Proyek: Grfyn POS Backend

Tujuan: Menutup celah keamanan (loopholes), mengoptimalkan performa, dan menambahkan fitur esensial retail agar sistem siap beroperasi di lingkungan production (volume tinggi & rentan manipulasi).

🛑 Fase 1: Keamanan & Stabilitas Inti (Prioritas: Sangat Tinggi)

Fokus pada perbaikan celah (vulnerabilities) yang dapat menyebabkan kerugian finansial atau kerusakan integritas data.

1. Validasi Input Ekstensif (Mencegah Manipulasi)

Masalah: Saat ini tidak ada validasi kuat pada payload request. User bisa mengirim kuantitas (jml) negatif, harga negatif, atau format data yang salah.

Tindakan:

Instal library validasi seperti Zod atau Joi.

Buat middleware validateRequest untuk memeriksa req.body di setiap rute transaksi (terutama /jual, /beli, /returjual).

Aturan Wajib: jml harus bilangan bulat positif (> 0), harga >= 0, diskon >= 0 dan <= 100.

2. Pencegahan Stok Negatif (Negative Stock Prevention)

Masalah: Sistem langsung memasukkan catatan barang keluar (jenis 'K') ke kartustok tanpa memvalidasi ketersediaan stok fisik di database.

Tindakan:

Sebelum iterasi item di controller (misal jualController.js), lakukan pengecekan stok (bisa me-reuse stokhelper.js atau query kustom terpadu).

Jika stok < req.body.jml, batalkan seluruh transaksi (Rollback) dan kembalikan response HTTP 400 (Bad Request) beserta detail barang yang stoknya tidak cukup.

3. Perbaikan Presisi Kalkulasi Finansial (Floating Point Math)

Masalah: Penggunaan operasi matematika bawaan Javascript (+, *) rentan terhadap anomali floating-point (misal: selisih sekian sen yang mengacaukan pembukuan/jurnal).

Tindakan:

Gunakan library khusus seperti decimal.js atau currency.js untuk kalkulasi PPN, diskon, dan grand total.

Alternatif (Lebih Baik): Simpan nilai uang dalam bentuk integer (cents) di database, lalu bagi 100 hanya saat ditampilkan (format view).

4. Solusi Masalah N+1 Query (Performa Database)

Masalah: Melakukan iterasi/looping untuk insert ke jualdtl, kartustok, dan hargajual secara individual akan membebani database dan memakan waktu eksekusi yang lama (bottleneck).

Tindakan:

Ubah pendekatan menjadi Batch Insert.

Siapkan array 2 dimensi (nested array) dari loop req.body.items.

Lakukan satu kali eksekusi: await conn.query('INSERT INTO jualdtl (...) VALUES ?', [arrayOfDetails]).

🏗️ Fase 2: Arsitektur & Infrastruktur Database (Prioritas: Sedang-Tinggi)

Fokus pada pondasi multi-tenant yang aman dan pencegahan anomali data (Race Conditions).

1. Migrasi Context Manager (Tenant Isolation)

Masalah: Penggunaan library cls-hooked sudah deprecated dan rawan mengalami context loss di versi Node.js >= 16.

Tindakan:

Migrasi dari cls-hooked ke AsyncLocalStorage (bawaan Node.js dari modul async_hooks).

Perbarui logika di src/config/db.js bagian initTenantNamespace dan getTenantContext.

2. Refaktor Injeksi Regex SQL Multi-Tenant

Masalah: Fungsi injectTenantWhere menggunakan regex raw string untuk menyisipkan AND idtenant = ?. Ini berisiko tinggi salah memparsing SQL yang kompleks (Subquery, UNION) dan dapat membocorkan data antar tenant.

Tindakan:

Tinggalkan pendekatan Regex Injection.

Opsi A: Lakukan penambahan idtenant secara manual dan eksplisit (hardcoded) di setiap query SELECT pada model/controller.

Opsi B: Migrasi bertahap ke Query Builder seperti Knex.js yang memiliki dukungan global scoping yang jauh lebih aman.

3. Kontrol Konkurensi (Concurrency / Locking)

Masalah: Transaksi yang dilakukan bersamaan (oleh kasir berbeda) pada satu barang bersisa 1 dapat menyebabkan stok tembus angka minus (Race Condition).

Tindakan:

Implementasikan Pessimistic Locking menggunakan klausa FOR UPDATE saat mengecek row stok/saldo.

Atau implementasikan Optimistic Locking dengan menambah field version di tabel barang / saldostok.

🛒 Fase 3: Penambahan Fitur Retail Skala Produksi (Prioritas: Menyesuaikan Bisnis)

Fokus pada fitur kasir (POS) nyata yang dibutuhkan di lapangan.

1. Manajemen Shift & Laci Kasir (Cash Till Management)

Membuat modul Shift Kasir:

Pencatatan Saldo Awal (Opening Balance) saat kasir login / buka shift.

Pencatatan Saldo Akhir (Closing Balance) dan total perhitungan uang tunai fisik.

Pencatatan uang masuk/keluar non-transaksi (Petty Cash/Kasbon).

2. Pembayaran Terpisah (Split Payment)

Ubah relasi metode pembayaran dari "1 Transaksi = 1 Metode" menjadi tabel tersendiri (jual_pembayaran).

Kasir dapat membagi total 500rb menjadi: 200rb (Cash), 200rb (Debit BCA), dan 100rb (QRIS) dalam satu nota transaksi penjualan.

3. Mesin Promosi / Diskon Lanjutan (Advanced Promos)

Membuat tabel master promosi:

Diskon persentase dengan minimal belanja (Tiering).

Promo "Beli X Gratis Y".

Sistem Kupon / Voucher diskon dengan limit kuota.

4. Role-Based Access Control (RBAC) yang Ketat

Perbarui middleware autentikasi auth.js.

Selain memverifikasi token dan status "AKTIF", lakukan validasi Role (Manajer, Supervisor, Kasir).

Fitur krusial seperti "Void Transaksi" (pembatalan) wajib dicegah jika role user hanyalah "Kasir" (bisa diimplementasikan dengan memasukkan PIN persetujuan dari Supervisor).

5. Pembatalan Parsial (Partial Void)

Saat ini sistem hanya bisa melakukan Cancel pada satu nota penuh (Header level).

Tambahkan fungsionalitas untuk me-retur atau mem-void satu atau beberapa barang spesifik (Item level) di dalam struk tanpa membatalkan barang lainnya.

📈 Panduan Implementasi Bertahap (Sprint Planning)

Sprint 1 (Backend Hardening): Fokus selesaikan semua task di Fase 1. Ini adalah mandatory sebelum sistem di-deploy ke pengguna nyata (beta tester).

Sprint 2 (Architecture Refactor): Selesaikan perpindahan cls-hooked ke AsyncLocalStorage dan ganti injeksi Regex SQL dengan parameter SQL yang presisi. Uji ulang (Regression Testing) di semua endpoint pelaporan.

Sprint 3 (Business Features): Rancang struktur database (ERD) baru untuk Split Payment dan Shift Kasir. Implementasikan Endpoint CRUD baru untuk fitur-fitur tersebut.
