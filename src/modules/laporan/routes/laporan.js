const router = require('express').Router();
const ctrl = require('../laporanController');
const auth = require('../../../middleware/auth');

const REPORT_PREVIEW_LIMIT = 1000;

function truncateArrays(value, limit, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value) && value.length > limit) {
    value.length = limit;
  }

  Object.values(value).forEach(item => truncateArrays(item, limit, seen));
}

router.use((req, res, next) => {
  const isExcelExport = req.query.format === 'xls';

  if (isExcelExport) {
    const reportName = req.path.replace(/^\/|\/$/g, '').replace(/[^a-z0-9-]+/gi, '-') || 'laporan';
    req.fullReportExport = true;
    req.query.format = 'html';
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportName}.xls"`);
  } else if (req.query.format === 'html') {
    const render = res.render.bind(res);
    res.setHeader('X-Report-Preview-Limit', String(REPORT_PREVIEW_LIMIT));
    res.render = (view, locals = {}, callback) => {
      truncateArrays(locals, REPORT_PREVIEW_LIMIT);
      return render(view, locals, callback);
    };
  }

  next();
});

router.get('/sales-transaksi', auth, ctrl.salesTransaksi);
router.get('/sales-per-customer', auth, ctrl.salesPerCustomer);
router.get('/sales-per-barang', auth, ctrl.salesPerBarang);
router.get('/sales-per-lokasi', auth, ctrl.salesPerLokasi);
router.get('/pembelian', auth, ctrl.pembelian);
router.get('/pembelian-per-supplier', auth, ctrl.pembelianPerSupplier);
router.get('/pembelian-per-lokasi', auth, ctrl.pembelianPerLokasi);
router.get('/pembelian-per-barang', auth, ctrl.pembelianPerBarang);
router.get('/pembelian-rekap', auth, ctrl.pembelianRekap);
router.get('/stok', auth, ctrl.stok);
router.get('/kartu-stok', auth, ctrl.kartuStok);
router.get('/stock-opname', auth, ctrl.stockOpname);
router.get('/transfer-stok', auth, ctrl.transferStok);
router.get('/jenistransaksi-kartustok', auth, ctrl.getJenisTransaksiKartuStok);
router.get('/jenisref-kartustok', auth, ctrl.getJenisRef);
router.get('/rekap-sales', auth, ctrl.rekapSales);
router.get('/struk/:id', auth, ctrl.struk);
router.get('/faktur/:id', auth, ctrl.faktur);

// Fase 3 — Laporan Baru
router.get('/sales-order', auth, ctrl.salesOrder);
router.get('/bpk', auth, ctrl.bpk);
router.get('/retur-jual', auth, ctrl.returJual);
router.get('/purchase-order', auth, ctrl.purchaseOrder);
router.get('/bpb', auth, ctrl.bpb);
router.get('/retur-beli', auth, ctrl.returBeli);
router.get('/absen', auth, ctrl.absen);
router.get('/gaji', auth, ctrl.gaji);
router.get('/slip-gaji/:id', auth, ctrl.slipGaji);

module.exports = router;
