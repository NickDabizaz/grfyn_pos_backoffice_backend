const router = require('express').Router();
const ctrl = require('../controllers/laporanController');
const auth = require('../middleware/auth');

router.get('/sales-transaksi', auth, ctrl.salesTransaksi);
router.get('/sales-per-customer', auth, ctrl.salesPerCustomer);
router.get('/sales-per-barang', auth, ctrl.salesPerBarang);
router.get('/pembelian', auth, ctrl.pembelian);
router.get('/stok', auth, ctrl.stok);

module.exports = router;
