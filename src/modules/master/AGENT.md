# Modul Master

## Overview
Modul master data. CRUD semua data referensi yang digunakan modul transaksi: barang, customer, supplier, lokasi, akun (COA), menu, dan user.

## File List
- `barangController.js`
- `customerController.js`
- `supplierController.js`
- `lokasiController.js`
- `akunController.js`
- `menuController.js`
- `userController.js`
- `routes/barang.js`
- `routes/customer.js`
- `routes/supplier.js`
- `routes/lokasi.js`
- `routes/akun.js`
- `routes/menu.js`
- `routes/user.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| CRUD | /api/barang | Master barang |
| CRUD | /api/customer | Master customer |
| CRUD | /api/supplier | Master supplier |
| CRUD | /api/lokasi | Master lokasi / gudang |
| CRUD | /api/akun | Master akun / COA |
| CRUD | /api/menu | Master menu / hak akses |
| CRUD | /api/user | Master user |

## Business Rules
- Kode master auto-generate via `generateKodeMaster` (BRG0001, CST0001, SUP0001, AKN0001)
- Delete dicegah jika sudah ada referensi transaksi
- Harga beli/jual hanya di-insert jika berbeda dari harga terakhir
- `jenisak` wajib diisi di akun agar laporan keuangan benar

## Tabel DB Terkait
- `barang`
- `hargabeli`
- `hargajual`
- `customer`
- `supplier`
- `lokasi`
- `akun`
- `menu`
- `usermenu`
- `userlokasi`
- `user`
- `menutemplate`
- `menutemplatedtl`

## Dependencies
- `lib/kodetrans` (`generateKodeMaster`)

## Known Limitations / TODO
- Tidak ada
