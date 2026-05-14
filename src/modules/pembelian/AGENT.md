# Modul Pembelian

## Overview
Modul transaksi pembelian. Menangani faktur beli, retur pembelian, Purchase Order (PO), dan Goods Receipt Note (GRN). Terintegrasi dengan stok, hutang, dan jurnal.

## File List
- `beliController.js`
- `returbeliController.js`
- `purchaseOrderController.js`
- `grnController.js`
- `routes/beli.js`
- `routes/returbeli.js`
- `routes/purchaseOrder.js`
- `routes/grn.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| CRUD | /api/beli | Faktur pembelian |
| CRUD | /api/returbeli | Retur pembelian |
| CRUD | /api/purchase-order | Purchase Order |
| CRUD | /api/grn | Goods Receipt Note |

## Business Rules
- Konversi satuan ke `satuankecil` via `toKecilJml()` sebelum insert `kartustok`
- PO flow: DRAFT → APPROVED → (GRN) → COMPLETE / PARTIAL
- GRN otomatis buat faktur beli (`beli`) + update `jml_diterima` di PO
- Edit beli: clean-slate approach (hapus semua lalu rebuild)
- Cancel beli blocked jika hutang sudah LUNAS

## Tabel DB Terkait
- `beli`
- `belidtl`
- `kartustok`
- `hargabeli`
- `kartuhutang`
- `pelunasanhutang`
- `pelunasanhutangdtl`
- `returbeli`
- `returbelidtl`
- `purchaseorder`
- `purchaseorderdtl`
- `grn`
- `grndtl`
- `jurnal`

## Dependencies
- `lib/kodetrans` (`generateKodeBeli`, `generateKodePO`, `generateKodeGRN`, `generateKodeReturBeli`, `generateKodePelunasanHutang`)

## Known Limitations / TODO
- Tidak ada
