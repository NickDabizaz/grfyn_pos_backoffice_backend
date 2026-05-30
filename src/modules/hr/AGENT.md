# Modul HR

## Overview
Modul Human Resources menangani master karyawan, setting jenis absensi, transaksi absensi, generate gaji, dan jurnal gaji.

## File List
- `karyawanController.js`
- `settingAbsensiController.js`
- `absensiController.js`
- `payrollController.js`
- `routes/karyawan.js`
- `routes/settingAbsensi.js`
- `routes/absensi.js`
- `routes/payroll.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| CRUD | /api/karyawan | Master karyawan |
| CRUD | /api/setting-absensi | Jenis absensi dan flag potong gaji |
| CRUD/approve | /api/absensi | Transaksi absensi header-detail |
| POST | /api/payroll/generate | Generate gaji per lokasi dan periode |
| PUT | /api/payroll/:id/approve | Approve gaji dan posting jurnal |
| PUT | /api/payroll/:id/unapprove | Batal approve gaji dan hapus jurnal |

## Business Rules
- Karyawan berada di menu Master dan wajib punya satu lokasi.
- Jenis absensi default: HADIR, IZIN, SAKIT, CUTI, ALPHA; default hanya ALPHA memotong gaji.
- Absensi memakai status transaksi `DRAFT`, `APPROVED`, `CONFIRMED`, `CANCELLED`.
- Generate gaji hanya boleh satu transaksi aktif per lokasi dan periode.
- Rumus gaji: gaji master dikurangi jumlah absensi potong gaji dikali gaji harian.
- Approve gaji insert jurnal balance: DEBET Beban Gaji, KREDIT Kas/Bank.
- Approve gaji mengubah absensi terkait menjadi `CONFIRMED`; batal approve mengembalikan ke `APPROVED`.

## Tabel DB Terkait
- `karyawan`
- `jenisabsensi`
- `absen`
- `absendtl`
- `gaji`
- `gajidtl`
- `gajiabsendtl`

## Dependencies
- `lib/kodetrans` (`generateKodeMaster`, `generateKodeAbsen`, `generateKodeGaji`)
- `lib/jurnalhelper`
- `modules/keuangan` (akun default kas/bank dan COA)
