# Modul HR

## Overview
Modul Human Resources. Menangani data karyawan, absensi harian, rekap absensi bulanan, generate payroll, dan posting jurnal gaji.

## File List
- `karyawanController.js`
- `absensiController.js`
- `payrollController.js`
- `routes/karyawan.js`
- `routes/absensi.js`
- `routes/payroll.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| CRUD | /api/karyawan | Data karyawan |
| POST | /api/absensi | Record absensi harian |
| GET | /api/absensi/rekap | Rekap absensi bulanan |
| POST | /api/payroll/generate | Generate payroll per periode |
| POST | /api/payroll/posting | Posting payroll ke jurnal |

## Business Rules
- Absensi unik per `(idtenant, idkaryawan, tglabsensi)` → unique constraint
- Komponen gaji: TUNJANGAN (tambah) atau POTONGAN (kurang)
- Payroll generate: hitung dari karyawan AKTIF × komponen × hari hadir dari absensi
- Payroll posting: insert jurnal DEBET Beban Gaji (5-1003), KREDIT Hutang Gaji (2-1002)
- Payroll status: DRAFT → POSTED
- Soft delete karyawan (status NONAKTIF, bukan DELETE)

## Tabel DB Terkait
- `karyawan`
- `komponengaji`
- `absensi`
- `payroll`
- `payrolldtl`

## Dependencies
- `lib/kodetrans` (`generateKodePayroll`, `generateKodeMaster`)
- `modules/keuangan` (akun untuk jurnal)

## Known Limitations / TODO
- Tidak ada
