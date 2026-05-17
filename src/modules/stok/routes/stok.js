const router = require('express').Router();
const ctrl = require('../stokController');
const auth = require('../../../middleware/auth');

// Penyesuaian stok
router.get('/penyesuaian', auth, ctrl.getPenyesuaian);
router.get('/penyesuaian/:id', auth, ctrl.getPenyesuaianDetail);
router.post('/penyesuaian', auth, ctrl.createPenyesuaian);

// Saldo awal stok
router.get('/saldostok', auth, ctrl.getSaldoStokList);
router.get('/saldostok/:id', auth, ctrl.getSaldoStokDetail);
router.post('/saldoawal', auth, ctrl.createSaldoAwal);
router.put('/saldoawal/:id', auth, ctrl.updateSaldoAwal);
router.put('/saldoawal/:id/approve', auth, ctrl.approveSaldoAwal);
router.put('/saldoawal/:id/unapprove', auth, ctrl.unapproveSaldoAwal);
router.put('/saldoawal/:id/batal', auth, ctrl.cancelSaldoAwal);

// Get stok per barang (utility)
router.get('/getstok/:idbarang', auth, ctrl.getStok);

module.exports = router;
