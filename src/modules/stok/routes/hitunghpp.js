const router = require('express').Router();
const ctrl = require('../hitunghppController');
const auth = require('../../../middleware/auth');
const { requireAccess } = require('../../../lib/access');
const { requireTransactionQuota } = require('../../../middleware/subscription');

router.get('/', auth, requireAccess('stok.hitunghpp', 'hakakses'), ctrl.getAll);
router.get('/check/:periodbulan', auth, requireAccess('stok.hitunghpp', 'hakakses'), ctrl.checkPeriod);
router.get('/:id', auth, requireAccess('stok.hitunghpp', 'hakakses'), ctrl.getOne);
router.post('/', auth, requireAccess('stok.hitunghpp', 'tambah'), requireTransactionQuota(), ctrl.create);
router.put('/:id/cancel', auth, requireAccess('stok.hitunghpp', 'ubah'), ctrl.cancel);

module.exports = router;
