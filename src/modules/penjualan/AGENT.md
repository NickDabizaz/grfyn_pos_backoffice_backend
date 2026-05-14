# Modul Penjualan

## Overview
Modul transaksi penjualan. Menangani faktur jual, retur penjualan, dan tukar barang. Terintegrasi langsung dengan stok, jurnal, dan piutang.

## File List
- `jualController.js`
- `returjualController.js`
- `tukarbarangController.js`
- `routes/jual.js`
- `routes/returjual.js`
- `routes/tukarbarang.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| CRUD | /api/jual | Faktur penjualan |
| CRUD | /api/returjual | Retur penjualan |
| CRUD | /api/tukarbarang | Tukar barang |

## Business Rules
- Stok dicek dengan `FOR UPDATE` sebelum transaksi (pessimistic lock)
- `grandtotal` SELALU dihitung ulang server-side, tidak percaya client
- Status flow: AKTIF → LUNAS → VOID
- Cancel harus cek piutang LUNAS dan retur aktif dulu
- Edit: hapus data lama (piutang, stok, detail, jurnal) lalu rebuild
- Retur: tindaklanjut `MASUK_STOK` / `MASUK_STOK_2ND` / `HANGUS`

## Tabel DB Terkait
- `jual`
- `jualdtl`
- `kartustok`
- `hargajual`
- `kartupiutang`
- `pelunasanpiutang`
- `pelunasanpiutangdtl`
- `returjual`
- `returjualdtl`
- `tukarbarang`
- `tukarbarangdtl_kembali`
- `tukarbarangdtl_baru`
- `jurnal`
- `akun`

## Dependencies
- `lib/kodetrans` (`generateKodeJual`, `generateKodeReturJual`, `generateKodeTukarBarang`, `generateKodePelunasanPiutang`)
- `modules/keuangan` (kartupiutang)

## Known Limitations / TODO
- Tidak ada
