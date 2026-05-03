const router = require('express').Router();
const multer = require('multer');
const ctrl = require('../controllers/imporController');
const auth = require('../middleware/auth');

const upload = multer({ dest: 'uploads/' });

// Barang
router.get('/barang/export', auth, ctrl.exportBarang);
router.post('/barang/import', auth, upload.single('file'), ctrl.importBarang);
router.get('/barang/template', auth, ctrl.templateBarang);

// Customer
router.get('/customer/export', auth, ctrl.exportCustomer);
router.post('/customer/import', auth, upload.single('file'), ctrl.importCustomer);
router.get('/customer/template', auth, ctrl.templateCustomer);

// Supplier
router.get('/supplier/export', auth, ctrl.exportSupplier);
router.post('/supplier/import', auth, upload.single('file'), ctrl.importSupplier);
router.get('/supplier/template', auth, ctrl.templateSupplier);

// Pembelian (Beli)
router.get('/beli/export', auth, ctrl.exportBeli);
router.post('/beli/import', auth, upload.single('file'), ctrl.importBeli);
router.get('/beli/template', auth, ctrl.templateBeli);

// Penjualan (Jual)
router.get('/jual/export', auth, ctrl.exportJual);
router.post('/jual/import', auth, upload.single('file'), ctrl.importJual);
router.get('/jual/template', auth, ctrl.templateJual);

module.exports = router;
