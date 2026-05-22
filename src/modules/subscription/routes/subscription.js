const router = require('express').Router();
const auth = require('../../../middleware/auth');
const ctrl = require('../subscriptionController');

router.post('/midtrans/notification', ctrl.midtransNotification);

router.use(auth);
router.get('/status', ctrl.getStatus);
router.post('/checkout', ctrl.checkout);
router.get('/backup', ctrl.backup);

module.exports = router;
