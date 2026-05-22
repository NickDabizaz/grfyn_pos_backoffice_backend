const router = require('express').Router();
const ctrl = require('../produksiController');
const auth = require('../../../middleware/auth');
const { requireTransactionQuota } = require('../../../middleware/subscription');

router.get('/', auth, ctrl.getAll);
router.get('/:id/check-edit', auth, ctrl.checkEdit);
router.get('/:id', auth, ctrl.getOne);
router.post('/', auth, requireTransactionQuota(), ctrl.create);
router.put('/:id/cancel', auth, ctrl.cancel);
router.put('/:id', auth, ctrl.update);

module.exports = router;
