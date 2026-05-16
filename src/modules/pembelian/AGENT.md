# Modul Pembelian

## Overview
Modul transaksi pembelian. Menangani faktur beli, retur pembelian, Purchase Order (PO), dan Bukti Penerimaan Barang (BPB). Terintegrasi dengan stok, hutang, dan histori harga beli.

## File List
- `beliController.js`
- `returbeliController.js`
- `purchaseOrderController.js`
- `bpbController.js`
- `routes/beli.js`
- `routes/returbeli.js`
- `routes/purchaseOrder.js`
- `routes/bpb.js`

## Endpoint Summary
| Method | Path | Fungsi |
|--------|------|--------|
| CRUD | /api/beli | Faktur pembelian |
| CRUD | /api/returbeli | Retur pembelian |
| CRUD | /api/purchase-order | Purchase Order |
| CRUD | /api/bpb | Bukti Penerimaan Barang |

## Business Rules
- PO flow: DRAFT -> APPROVED -> CONFIRMED / CANCELLED
- BPB dibuat dari PO APPROVED dan mengubah PO menjadi CONFIRMED
- Pembelian DRAFT tidak membentuk stok, hutang, pelunasan, atau harga beli
- Pembelian APPROVED membentuk kartu stok, kartu hutang/pelunasan, dan histori harga beli
- Cancel beli membalik stok/hutang dan menonaktifkan histori harga beli transaksi tersebut

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
- `bpb`
- `bpbdtl`
- `jurnal`

## Dependencies
- `lib/kodetrans` (`generateKodeBeli`, `generateKodePO`, `generateKodeBPB`, `generateKodeReturBeli`, `generateKodePelunasanHutang`)
