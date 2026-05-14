const router = require('express').Router();
const ctrl = require('../kartuhutangController');
const auth = require('../../../middleware/auth');

router.get('/', auth, ctrl.getAll);
router.get('/summary/:idsupplier', auth, ctrl.getSummary);
router.get('/open/:idsupplier', auth, ctrl.getOpen);
router.get('/open-invoices/:idsupplier', auth, ctrl.getOpenInvoices);

module.exports = router;