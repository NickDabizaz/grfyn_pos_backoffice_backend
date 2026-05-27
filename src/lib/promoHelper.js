const logger = require('./logger');

async function getPromoAktif(conn, { idpromo, idtenant, tgltrans }) {
  const [[promo]] = await conn.query(
    `SELECT * FROM promo
     WHERE idpromo = ? AND idtenant = ? AND status = 'AKTIF'
       AND tglawal <= ? AND tglakhir >= ?`,
    [idpromo, idtenant, tgltrans, tgltrans]
  );
  return promo || null;
}

async function hitungPromo(conn, { idpromo, idtenant, tgltrans, berlaku_untuk, items }) {
  const result = {
    diskonPromoTransaksi: 0,
    itemDiskonPromo: new Map(),
    barangGratis: [],
    promo: null,
  };
  if (!idpromo) return result;

  const promo = await getPromoAktif(conn, { idpromo, idtenant, tgltrans });
  if (!promo) {
    const err = new Error('Promo tidak ditemukan atau tidak aktif pada tanggal transaksi');
    err.statusCode = 400;
    throw err;
  }

  if (promo.berlaku_untuk !== 'KEDUANYA' && promo.berlaku_untuk !== berlaku_untuk) {
    const label = berlaku_untuk === 'PENJUALAN' ? 'penjualan' : 'pembelian';
    const err = new Error(`Promo ini tidak berlaku untuk ${label}`);
    err.statusCode = 400;
    throw err;
  }

  if (promo.max_penggunaan !== null && promo.jumlah_digunakan >= promo.max_penggunaan) {
    const err = new Error('Promo sudah mencapai batas maksimum penggunaan');
    err.statusCode = 400;
    throw err;
  }

  result.promo = promo;
  const grandtotalBruto = items.reduce((sum, it) => sum + parseFloat(it.subtotal || 0), 0);
  const minTransaksi = parseFloat(promo.min_transaksi) || 0;

  if (grandtotalBruto < minTransaksi) {
    const err = new Error(`Minimum transaksi untuk promo ini adalah Rp ${minTransaksi.toLocaleString('id-ID')}`);
    err.statusCode = 400;
    throw err;
  }

  // ---- PROMO PER TRANSAKSI ----
  if (promo.jenis === 'PERSEN_TRANSAKSI') {
    let diskon = (parseFloat(promo.nilai) / 100) * grandtotalBruto;
    if (promo.max_diskon !== null) diskon = Math.min(diskon, parseFloat(promo.max_diskon));
    result.diskonPromoTransaksi = diskon;
    return result;
  }

  if (promo.jenis === 'NOMINAL_TRANSAKSI') {
    result.diskonPromoTransaksi = Math.min(parseFloat(promo.nilai), grandtotalBruto);
    return result;
  }

  // ---- PROMO PER ITEM ----
  let targetItems = items;
  if (!promo.berlaku_semua_barang) {
    const [promoItems] = await conn.query(
      'SELECT idbarang FROM promodtl WHERE idpromo = ? AND idtenant = ?',
      [idpromo, idtenant]
    );
    const promoItemSet = new Set(promoItems.map(pi => parseInt(pi.idbarang)));
    targetItems = items.filter(item => promoItemSet.has(parseInt(item.idbarang)));
  }

  if (promo.jenis === 'PERSEN_ITEM') {
    for (const item of targetItems) {
      const minQty = parseFloat(promo.min_qty) || 0;
      const jml = parseFloat(item.jml);
      if (jml < minQty) continue;

      let diskonItem = (parseFloat(promo.nilai) / 100) * parseFloat(item.harga) * jml;
      if (promo.max_diskon !== null) {
        diskonItem = Math.min(diskonItem, parseFloat(promo.max_diskon));
      }
      if (diskonItem > 0) result.itemDiskonPromo.set(parseInt(item.idbarang), diskonItem);
    }
  }

  else if (promo.jenis === 'NOMINAL_ITEM') {
    for (const item of targetItems) {
      const minQty = parseFloat(promo.min_qty) || 0;
      const jml = parseFloat(item.jml);
      if (jml < minQty) continue;

      const diskonItem = Math.min(parseFloat(promo.nilai) * jml, parseFloat(item.subtotal));
      if (diskonItem > 0) result.itemDiskonPromo.set(parseInt(item.idbarang), diskonItem);
    }
  }

  // ---- BELI X GRATIS Y ----
  else if (promo.jenis === 'BELI_X_GRATIS_Y') {
    const nilaiX = parseFloat(promo.nilai_x) || 1;
    const qualifies = targetItems.some(item => parseFloat(item.jml) >= nilaiX);

    if (qualifies) {
      const [gratisRows] = await conn.query(
        `SELECT pbg.*, b.namabarang, b.kodebarang
         FROM promobarang_gratis pbg
         LEFT JOIN barang b ON pbg.idbarang = b.idbarang
         WHERE pbg.idpromo = ? AND pbg.idtenant = ?`,
        [idpromo, idtenant]
      );
      result.barangGratis = gratisRows.map(g => ({
        idbarang: g.idbarang,
        namabarang: g.namabarang,
        kodebarang: g.kodebarang,
        jml: parseFloat(g.jml),
      }));
    }
  }

  return result;
}

async function incrementPromoUsage(conn, { idpromo, idtenant }) {
  if (!idpromo) return;
  await conn.query(
    'UPDATE promo SET jumlah_digunakan = jumlah_digunakan + 1 WHERE idpromo = ? AND idtenant = ?',
    [idpromo, idtenant]
  );
}

async function decrementPromoUsage(conn, { idpromo, idtenant }) {
  if (!idpromo) return;
  await conn.query(
    'UPDATE promo SET jumlah_digunakan = GREATEST(jumlah_digunakan - 1, 0) WHERE idpromo = ? AND idtenant = ?',
    [idpromo, idtenant]
  );
}

module.exports = { hitungPromo, incrementPromoUsage, decrementPromoUsage, getPromoAktif };
