# Modul Keuangan

## Overview
Modul akuntansi dan keuangan. Menangani kas, kartu piutang/hutang, pelunasan, jurnal, laporan keuangan (neraca saldo, laba rugi, neraca, buku besar), dan closing periode.

## File List
- `kasController.js`
- `kartupiutangController.js`
- `pelunasanpiutangController.js`
- `kartuhutangController.js`
- `pelunasanhutangController.js`
- `laporanKeuanganController.js`
- `routes/kas.js`
- `routes/kartupiutang.js`
- `routes/pelunasanpiutang.js`
- `routes/kartuhutang.js`
- `routes/pelunasanhutang.js`
- `routes/laporanKeuangan.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| CRUD | /api/kas | Transaksi kas / kas kecil |
| GET | /api/kartupiutang | Kartu piutang per customer |
| POST | /api/pelunasanpiutang | Pelunasan piutang |
| GET | /api/kartuhutang | Kartu hutang per supplier |
| POST | /api/pelunasanhutang | Pelunasan hutang |
| GET | /api/laporan-keuangan | Neraca saldo, laba rugi, neraca, buku besar |

## Business Rules
- Laporan keuangan menggunakan kolom `jenisak` di tabel `akun` (ASET / LIABILITAS / EKUITAS / PENDAPATAN / BEBAN)
- Closing periode: debit semua akun PENDAPATAN, kredit semua akun BEBAN, selisih ke Laba Ditahan
- Closing tidak bisa dilakukan 2x untuk periode yang sama
- Buku besar menggunakan running balance per entry
- Saldo normal akun: DEBET (ASET, BEBAN) atau KREDIT (LIABILITAS, EKUITAS, PENDAPATAN)

## Tabel DB Terkait
- `kas`
- `kasdtl`
- `jurnal`
- `akun`
- `kartupiutang`
- `pelunasanpiutang`
- `pelunasanpiutangdtl`
- `kartuhutang`
- `pelunasanhutang`
- `pelunasanhutangdtl`
- `closing`
- `closingdtl`

## Dependencies
- `lib/kodetrans` (`generateKodeKas`, `generateKodeClosing`, `generateKodePelunasanPiutang`, `generateKodePelunasanHutang`)

## Known Limitations / TODO
- Tidak ada
