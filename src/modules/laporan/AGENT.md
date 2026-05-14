# Modul Laporan

## Overview
Modul laporan dan dashboard. Bersifat read-only (kecuali import). Menyediakan laporan transaksi, stok, kartu stok, struk, faktur, dashboard, serta import/export CSV.

## File List
- `laporanController.js`
- `imporController.js`
- `dashboardController.js`
- `routes/laporan.js`
- `routes/impor.js`
- `routes/dashboard.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| GET | /api/laporan/... | Semua varian laporan transaksi, stok, kartu stok |
| GET | /api/dashboard | Dashboard ringkasan |
| POST | /api/impor | Import CSV (jual, beli, stok, dll) |

## Business Rules
- Semua laporan support format JSON (default) dan HTML (untuk print, via `?format=html`)
- HTML render via EJS template di `reports/`
- Import CSV: parse dengan `parseCSV()`, validasi per baris, rollback jika ada error
- Import jual-batch: validasi subtotal per baris (toleransi Rp 1)
- Dashboard: data dari lokasi aktif (`ctx.idlokasi`), bukan semua lokasi
- `multiLike()` dan `multiIdIn()` untuk filter multi-value

## Tabel DB Terkait
- Read-only dari semua tabel transaksi + master

## Dependencies
- Semua modul lain (read-only)
- `config/db` (pool langsung untuk query tenant info)

## Known Limitations / TODO
- Tidak ada
