# Instruksi Implementasi Fitur Promo — Frontend

> Dokumen ini ditujukan bagi tim Frontend untuk mengimplementasikan fitur Promo yang sudah tersedia di backend.

---

## 1. Ringkasan Konsep

Fitur **Promo** berbeda dari fitur **Diskon** yang sudah ada:

| Aspek | Diskon (Lama) | Promo (Baru) |
|---|---|---|
| Penerapan | Per item saat input manual | Otomatis dihitung dari katalog promo |
| Level | Hanya per item | Per item ATAU per transaksi |
| Penggunaan di transaksi | Input `diskon` % per item | Pilih `idpromo`, otomatis dihitung |
| Berlaku untuk | Penjualan saja | Penjualan, Pembelian, atau Keduanya |
| Gratis barang | Tidak ada | Mendukung BELI X GRATIS Y |

---

## 2. Jenis Promo yang Tersedia

| Kode `jenis` | Nama | Cara Kerja |
|---|---|---|
| `PERSEN_ITEM` | Diskon % per barang | Kurangi `harga × qty × nilai%` dari setiap item yang memenuhi syarat |
| `NOMINAL_ITEM` | Diskon nominal per barang | Kurangi `nilai × qty` dari setiap item yang memenuhi syarat |
| `PERSEN_TRANSAKSI` | Diskon % total transaksi | Kurangi `grandtotal × nilai%` setelah semua item dijumlahkan |
| `NOMINAL_TRANSAKSI` | Diskon nominal total | Kurangi angka tetap `nilai` dari grandtotal |
| `BELI_X_GRATIS_Y` | Beli X Gratis Y | Jika ada item dengan qty ≥ X, tambahkan barang gratis ke keranjang |

---

## 3. API Promo Master (CRUD)

### Base URL: `/api/promo`

#### 3.1 Daftar Semua Promo
```
GET /api/promo
Query params:
  search       → cari kodepromo / namapromo
  status       → AKTIF | NONAKTIF
  jenis        → PERSEN_ITEM | NOMINAL_ITEM | PERSEN_TRANSAKSI | NOMINAL_TRANSAKSI | BELI_X_GRATIS_Y
  berlaku_untuk → PENJUALAN | PEMBELIAN | KEDUANYA
```

**Response:**
```json
[
  {
    "idpromo": 1,
    "kodepromo": "FLASH2025",
    "namapromo": "Flash Sale Agustus",
    "jenis": "PERSEN_TRANSAKSI",
    "berlaku_untuk": "PENJUALAN",
    "nilai": 10,
    "min_transaksi": 500000,
    "max_diskon": 100000,
    "tglawal": "2025-08-01",
    "tglakhir": "2025-08-31",
    "berlaku_semua_barang": 1,
    "max_penggunaan": 100,
    "jumlah_digunakan": 12,
    "status": "AKTIF"
  }
]
```

#### 3.2 Detail Satu Promo
```
GET /api/promo/:id
```

**Response tambahan:**
```json
{
  "...header...",
  "items": [
    { "idpromodtl": 1, "idbarang": 5, "namabarang": "Sepatu Nike", "kodebarang": "SEP001" }
  ],
  "barang_gratis": [
    { "idpromobaranggratis": 1, "idbarang": 7, "namabarang": "Kaos Kaki", "jml": 2 }
  ]
}
```

#### 3.3 Promo Aktif (untuk Dropdown di Transaksi)
```
GET /api/promo/aktif?berlaku_untuk=PENJUALAN&tgl=2025-08-15
```
- `berlaku_untuk`: `PENJUALAN` atau `PEMBELIAN`
- `tgl` (opsional): default hari ini

#### 3.4 Buat Promo Baru
```
POST /api/promo
```

**Request Body:**
```json
{
  "kodepromo": "FLASH2025",
  "namapromo": "Flash Sale Agustus",
  "deskripsi": "Diskon 10% untuk semua produk",
  "jenis": "PERSEN_TRANSAKSI",
  "berlaku_untuk": "PENJUALAN",
  "nilai": 10,
  "min_transaksi": 500000,
  "max_diskon": 100000,
  "tglawal": "2025-08-01",
  "tglakhir": "2025-08-31",
  "berlaku_semua_barang": true,
  "max_penggunaan": 100,
  "status": "AKTIF",
  "items": [],
  "barang_gratis": []
}
```

**Catatan field:**
- `items`: array `idbarang` — wajib diisi jika `berlaku_semua_barang: false` dan jenis bukan `PERSEN_TRANSAKSI`/`NOMINAL_TRANSAKSI`
- `barang_gratis`: array `{idbarang, jml}` — wajib jika `jenis = BELI_X_GRATIS_Y`
- `nilai_x` dan `nilai_y`: wajib jika `jenis = BELI_X_GRATIS_Y` (beli X qty gratis Y qty)

**Contoh Promo BELI_X_GRATIS_Y:**
```json
{
  "kodepromo": "BELI3GRATIS1",
  "namapromo": "Beli 3 Gratis 1 Kaos Kaki",
  "jenis": "BELI_X_GRATIS_Y",
  "berlaku_untuk": "PENJUALAN",
  "nilai": 0,
  "nilai_x": 3,
  "nilai_y": 1,
  "tglawal": "2025-08-01",
  "tglakhir": "2025-08-31",
  "berlaku_semua_barang": false,
  "items": [5, 6],
  "barang_gratis": [
    { "idbarang": 7, "jml": 1 }
  ]
}
```

#### 3.5 Update Promo
```
PUT /api/promo/:id
Body: sama seperti POST (semua field opsional kecuali yang diubah)
```

#### 3.6 Hapus Promo
```
DELETE /api/promo/:id
```
> Gagal jika promo sudah digunakan dalam transaksi yang tidak dibatalkan.

---

## 4. Preview Kalkulasi Promo (Sebelum Transaksi Disubmit)

Endpoint ini digunakan untuk menampilkan kepada kasir/user berapa diskon yang akan diperoleh.

```
POST /api/promo/preview
```

**Request Body:**
```json
{
  "idpromo": 1,
  "berlaku_untuk": "PENJUALAN",
  "tgltrans": "2025-08-15",
  "items": [
    { "idbarang": 5, "jml": 2, "harga": 150000, "diskon": 0, "satuan": "PCS" },
    { "idbarang": 6, "jml": 1, "harga": 200000, "diskon": 0, "satuan": "PCS" }
  ]
}
```

**Response:**
```json
{
  "idpromo": 1,
  "namapromo": "Flash Sale Agustus",
  "jenis": "PERSEN_TRANSAKSI",
  "berlaku_untuk": "PENJUALAN",
  "diskon_per_transaksi": 50000,
  "diskon_per_item": {},
  "total_diskon": 50000,
  "grandtotal_sebelum": 500000,
  "grandtotal_setelah": 450000,
  "barang_gratis": []
}
```

**Untuk promo BELI_X_GRATIS_Y, response barang_gratis:**
```json
{
  "barang_gratis": [
    { "idbarang": 7, "namabarang": "Kaos Kaki", "kodebarang": "KK001", "jml": 1 }
  ]
}
```
> FE harus menambahkan barang gratis ke keranjang dengan `harga: 0, is_gratis: true`

---

## 5. Integrasi di Halaman Penjualan (POST /api/jual)

### 5.1 Field Baru di Request

Tambahkan field berikut ke request body ketika membuat/mengupdate penjualan:

```json
{
  "idlokasi": 1,
  "idcustomer": 2,
  "tgltrans": "2025-08-15",
  "idpromo": 1,
  "items": [
    {
      "idbarang": 5,
      "jml": 2,
      "harga": 150000,
      "diskon": 0,
      "satuan": "PCS",
      "is_gratis": false
    },
    {
      "idbarang": 7,
      "jml": 1,
      "harga": 0,
      "diskon": 0,
      "satuan": "PCS",
      "is_gratis": true
    }
  ],
  "approve": true
}
```

**Field baru:**
- `idpromo` (number|null): ID promo yang dipilih dari dropdown. `null` jika tidak ada promo.
- `is_gratis` (boolean): Tandai `true` untuk item gratis dari promo BELI_X_GRATIS_Y. Harga akan otomatis di-set 0 oleh backend.

### 5.2 Response Transaksi (GET /api/jual/:id)

Response sekarang menyertakan field promo:
```json
{
  "idjual": 10,
  "kodejual": "JL-2025-001",
  "grandtotal": 450000,
  "idpromo": 1,
  "diskon_promo": 50000,
  "items": [
    {
      "idjualdtl": 1,
      "idbarang": 5,
      "jml": 2,
      "harga": 150000,
      "subtotal": 277000,
      "idpromo": null,
      "diskon_promo": 0,
      "is_gratis": 0
    }
  ]
}
```

---

## 6. Integrasi di Halaman Pembelian (POST /api/beli)

Sama persis dengan penjualan, tapi gunakan `berlaku_untuk: "PEMBELIAN"` di preview.

```json
{
  "idlokasi": 1,
  "idsupplier": 3,
  "tgltrans": "2025-08-15",
  "idpromo": 2,
  "items": [ ... ],
  "approve": true
}
```

---

## 7. Alur UX yang Direkomendasikan

### Penjualan / Kasir

```
1. User membuka form buat transaksi baru
2. User menambahkan barang ke keranjang
3. Di bawah daftar item, tampilkan dropdown "Pilih Promo"
   → Fetch dari GET /api/promo/aktif?berlaku_untuk=PENJUALAN
4. Setelah user memilih promo:
   → Call POST /api/promo/preview dengan items saat ini
   → Tampilkan di UI:
      - "Diskon Promo: Rp 50.000"
      - "Total Sebelum Promo: Rp 500.000"
      - "Total Setelah Promo: Rp 450.000"
5. Jika preview mengembalikan barang_gratis (BELI_X_GRATIS_Y):
   → Tampilkan popup/toast: "Anda mendapat bonus: Kaos Kaki x1"
   → Otomatis tambahkan ke keranjang dengan harga 0 dan is_gratis: true
6. User submit transaksi
   → Kirim idpromo bersama payload items (termasuk barang gratis jika ada)
```

### Master Promo (Halaman Admin)

```
Menu: Master → Promo (sudah ada di seed menu: kodemenu = 'master.promo')
Path frontend: /master/promo

Fitur yang perlu dibangun:
- Tabel daftar promo dengan kolom: Kode, Nama, Jenis, Berlaku Untuk, Periode, Status, Terpakai
- Filter: Status, Jenis, Berlaku Untuk
- Form Tambah/Edit Promo:
  - Field sesuai payload POST di atas
  - Jika berlaku_semua_barang = false: tampilkan multiselect barang
  - Jika jenis = BELI_X_GRATIS_Y: tampilkan form nilai_x, nilai_y, dan pilih barang gratis
- Tombol Nonaktifkan / Aktifkan
- Tombol Hapus (dengan warning jika sudah digunakan)
```

---

## 8. Validasi Error dari Backend

Backend akan mengembalikan HTTP 400 dengan pesan berikut:

| Kondisi | Pesan Error |
|---|---|
| Promo tidak ditemukan / tidak aktif | `"Promo tidak ditemukan atau tidak aktif pada tanggal transaksi"` |
| Promo tidak berlaku untuk jenis transaksi | `"Promo ini tidak berlaku untuk penjualan"` |
| Penggunaan sudah habis | `"Promo sudah mencapai batas maksimum penggunaan"` |
| Belum mencapai minimum transaksi | `"Minimum transaksi untuk promo ini adalah Rp 500.000"` |
| Promo sudah dipakai (hapus) | `"Promo tidak dapat dihapus karena sudah digunakan dalam transaksi"` |

---

## 9. Struktur Database (Referensi)

### Tabel `promo`
| Kolom | Tipe | Keterangan |
|---|---|---|
| `idpromo` | INT | Primary key |
| `kodepromo` | VARCHAR(30) | Kode unik per tenant |
| `namapromo` | VARCHAR(150) | Nama tampilan |
| `jenis` | ENUM | PERSEN_ITEM / NOMINAL_ITEM / PERSEN_TRANSAKSI / NOMINAL_TRANSAKSI / BELI_X_GRATIS_Y |
| `berlaku_untuk` | ENUM | PENJUALAN / PEMBELIAN / KEDUANYA |
| `nilai` | DECIMAL | Nilai diskon (% atau nominal) |
| `nilai_x` | DECIMAL | Qty beli minimum (BELI_X_GRATIS_Y) |
| `nilai_y` | DECIMAL | Qty gratis (BELI_X_GRATIS_Y) |
| `min_transaksi` | DECIMAL | Minimum total transaksi |
| `min_qty` | DECIMAL | Minimum qty per item |
| `max_diskon` | DECIMAL | Batas atas nominal diskon |
| `berlaku_semua_barang` | TINYINT | 1=semua barang, 0=barang tertentu |
| `tglawal` / `tglakhir` | DATE | Periode berlaku |
| `max_penggunaan` | INT | Batas total penggunaan (NULL = tidak terbatas) |
| `jumlah_digunakan` | INT | Counter penggunaan |
| `status` | VARCHAR | AKTIF / NONAKTIF |

### Kolom Baru di `jual` dan `beli`
| Kolom | Tipe | Keterangan |
|---|---|---|
| `idpromo` | INT | Referensi ke tabel promo |
| `diskon_promo` | DECIMAL(15,2) | Nominal diskon dari promo level transaksi |

### Kolom Baru di `jualdtl` dan `belidtl`
| Kolom | Tipe | Keterangan |
|---|---|---|
| `idpromo` | INT | Referensi ke promo (jika ada item-level promo) |
| `diskon_promo` | DECIMAL(15,2) | Nominal diskon promo untuk item ini |
| `is_gratis` | TINYINT | 1 = item ini adalah barang gratis dari promo |

---

## 10. Catatan Penting

1. **Promo TIDAK menggantikan diskon item** — Diskon `%` yang diinput manual di setiap item tetap berjalan bersamaan dengan promo.

2. **Harga setelah promo** = `(harga × qty) + ppn - diskon_manual - diskon_promo_item` untuk level item, ditambah pengurangan `diskon_promo` di header untuk promo level transaksi.

3. **Stok barang gratis tetap berkurang** — Item dengan `is_gratis = true` tetap dicatat di kartustok sebagai keluar (K) agar stok akurat.

4. **Promo tidak mempengaruhi harga jual historis** — Item gratis (`is_gratis = true`) tidak masuk ke tabel `hargajual`.

5. **Usage counter** — Counter `jumlah_digunakan` di tabel promo hanya bertambah ketika transaksi di-**approve**. Jika di-unapprove, counter berkurang kembali.

6. **Dropdown promo di transaksi** — Gunakan `/api/promo/aktif?berlaku_untuk=PENJUALAN` atau `PEMBELIAN` untuk menampilkan pilihan promo yang relevan saja.

7. **Preview sebelum submit** — Selalu panggil `/api/promo/preview` ketika user memilih promo untuk menampilkan ringkasan diskon sebelum transaksi disubmit.
