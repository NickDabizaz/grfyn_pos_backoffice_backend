# Modul Auth

## Overview
Modul autentikasi dan otorisasi pengguna. Menangani login, register, pemilihan lokasi kerja, refresh token, dan perubahan password. Mengelola relasi user-tenant-lokasi-menu.

## File List
- `authController.js`
- `routes/auth.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| POST | /api/auth/register | Register tenant & user baru |
| POST | /api/auth/login | Login user |
| POST | /api/auth/select-location | Pilih lokasi aktif setelah login |
| GET | /api/auth/me | Ambil data user yang sedang login |
| PUT | /api/auth/password | Ganti password |
| POST | /api/auth/refresh | Refresh access token |

## Business Rules
- JWT expire 2 jam
- `tokenversion` di tabel `user` di-increment setiap ganti password → invalidate token lama
- bcrypt 10 rounds untuk hash password
- Auto-seed Chart of Account (COA) saat register tenant baru

## Tabel DB Terkait
- `user`
- `tenant`
- `lokasi`
- `userlokasi`
- `usermenu`
- `akun`

## Dependencies
- `lib/logger`
- `config/db` (pool langsung — bukan `tenantQuery`)

## Known Limitations / TODO
- Tidak ada
