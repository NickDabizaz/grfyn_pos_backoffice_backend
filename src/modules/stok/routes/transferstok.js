const express = require('express');
const router = express.Router();
const auth = require('../../../middleware/auth');
const { requireAccess } = require('../../../lib/access');
const { requireTransactionQuota } = require('../../../middleware/subscription');
const ctrl = require('../transferstokController');

router.use(auth);

router.get('/', requireAccess('stok.transferstok', 'hakakses'), ctrl.getAll);
router.get('/:id', requireAccess('stok.transferstok', 'hakakses'), ctrl.getOne);
router.post('/', requireAccess('stok.transferstok', 'tambah'), requireTransactionQuota(), ctrl.create);
router.put('/:id', requireAccess('stok.transferstok', 'ubah'), ctrl.update);
router.put('/:id/approve', requireAccess('stok.transferstok', 'ubah'), ctrl.approve);
router.put('/:id/unapprove', requireAccess('stok.transferstok', 'ubah'), ctrl.unapprove);
router.put('/:id/kirim', requireAccess('stok.transferstok', 'ubah'), ctrl.kirim);
router.put('/:id/terima', requireAccess('stok.transferstok', 'ubah'), ctrl.terima);
router.put('/:id/batal', requireAccess('stok.transferstok', 'ubah'), ctrl.batal);

module.exports = router;
