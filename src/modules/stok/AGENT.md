# Modul Stok

## Overview
Modul manajemen stok. Menangani kartu stok, saldo awal, penyesuaian, perhitungan HPP, produksi, transfer antar-lokasi, dan stock opname.

## File List
- `stokController.js`
- `produksiController.js`
- `hitunghppController.js`
- `transferstokController.js`
- `stockOpnameController.js`
- `routes/stok.js`
- `routes/produksiRoutes.js`
- `routes/hitunghpp.js`
- `routes/transferstok.js`
- `routes/stockOpname.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| CRUD | /api/stok | Kartu stok, saldo awal, penyesuaian |
| CRUD | /api/produksi | Produksi / assembly |
| CRUD | /api/hitunghpp | Hitung HPP per bulan |
| CRUD | /api/transfer-stok | Transfer antar lokasi |
| CRUD | /api/stock-opname | Stock opname |

## Business Rules
- Stok = SUM(masuk) - SUM(keluar) dari `kartustok`, atau dari `saldostok` + mutasi setelahnya
- HPP wajib berurutan (tidak bisa skip bulan)
- HPP cancel harus dari yang terbaru dulu
- Produksi: BAHAN BAKU / SETENGAH JADI → keluar (K), BAHAN JADI → masuk (M)
- Transfer stok: DRAFT → DIKIRIM (keluar lokasi asal) → DITERIMA (masuk lokasi tujuan)
- Stock Opname: DRAFT → update fisik → FINALIZE (buat penyesuaian otomatis)
- **WARNING**: Produksi belum terintegrasi ke `hitunghpp`

## Tabel DB Terkait
- `kartustok`
- `saldostok`
- `saldostokdtl`
- `penyesuaianstok`
- `penyesuaianstokdtl`
- `hitunghpp`
- `hitunghppdtl`
- `produksi`
- `produksidtl`
- `transferstok`
- `transferstokdtl`
- `stockopname`
- `stockopnamedtl`

## Dependencies
- `lib/kodetrans`
- `lib/stokhelper`

## Known Limitations / TODO
- Produksi belum terintegrasi ke hitunghpp
