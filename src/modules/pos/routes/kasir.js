const express = require('express');
const router = express.Router();
const auth = require('../../../middleware/auth');
const ctrl = require('../posKasirController');

router.use(auth);

router.get('/modalawal/today', ctrl.getModalAwalToday);
router.post('/modalawal', ctrl.setModalAwal);

router.post('/transaksi', ctrl.createTransaksi);
router.get('/transaksi/history', ctrl.getHistory);
router.post('/transaksi/:id/cancel', ctrl.cancelTransaksi);

router.get('/closing/summary', ctrl.getClosingSummary);
router.post('/closing', ctrl.closingHarian);
router.post('/closing/batal', ctrl.batalClosing);

router.get('/setting', ctrl.getSetting);
router.post('/setting', ctrl.saveSetting);

module.exports = router;
