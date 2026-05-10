const router = require('express').Router();
const ctrl = require('../controllers/kartupiutangController');
const auth = require('../middleware/auth');

router.get('/', auth, ctrl.getAll);
router.get('/summary/:idcustomer', auth, ctrl.getSummary);
router.get('/open/:idcustomer', auth, ctrl.getOpen);
router.get('/open-invoices/:idcustomer', auth, ctrl.getOpenInvoices);

module.exports = router;