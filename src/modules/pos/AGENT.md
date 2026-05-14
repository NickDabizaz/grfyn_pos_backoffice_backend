# Modul POS

## Overview
Modul Point of Sale operational. Menangani shift kasir (buka/tutup) dan pengaturan toko (logo, nama, dll).

## File List
- `shiftController.js`
- `settingController.js`
- `routes/shift.js`
- `routes/setting.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| POST | /api/shift/buka | Buka shift baru |
| PUT | /api/shift/tutup | Tutup shift |
| GET | /api/shift/aktif | Cek shift yang sedang aktif |
| GET/PUT | /api/setting | Setting toko |
| POST | /api/setting/logo | Upload logo toko |

## Business Rules
- Hanya boleh 1 shift BUKA per lokasi pada satu waktu
- Tutup shift: hitung `total_sales` dari `jual` di tanggal shift tersebut
- Setting logo: upload via multer, simpan path ke `tenant.logo`
- Shift status: BUKA → TUTUP

## Tabel DB Terkait
- `shift`
- `tenant` (setting logo)

## Dependencies
- `lib/kodetrans` (`generateKodeShift`)

## Known Limitations / TODO
- Tidak ada
