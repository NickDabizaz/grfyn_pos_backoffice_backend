const router = require('express').Router();
const ctrl = require('../controllers/dashboardController');
const auth = require('../middleware/auth');

router.get('/summary', auth, ctrl.summary);
router.get('/chart', auth, ctrl.chart);

module.exports = router;
