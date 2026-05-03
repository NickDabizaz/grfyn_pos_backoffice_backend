const router = require('express').Router();
const ctrl = require('../controllers/dashboardController');
const auth = require('../middleware/auth');

router.get('/summary', auth, ctrl.summary);
router.get('/chart', auth, ctrl.chart);
router.get('/low-stock', auth, ctrl.lowStock);

module.exports = router;
