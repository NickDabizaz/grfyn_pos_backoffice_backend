const express = require('express');
const router = express.Router();
const auth = require('../../../middleware/auth');
const { requireAccess } = require('../../../lib/access');
const { requireTransactionQuota } = require('../../../middleware/subscription');
const ctrl = require('../payrollController');

router.use(auth);

router.get('/', requireAccess('sdm.gaji', 'hakakses'), ctrl.getAll);
router.get('/:id', requireAccess('sdm.gaji', 'hakakses'), ctrl.getOne);
router.post('/generate', requireAccess('sdm.gaji', 'tambah'), requireTransactionQuota(), ctrl.generate);
router.put('/:id/approve', requireAccess('sdm.gaji', 'approve'), ctrl.approve);
router.put('/:id/posting', requireAccess('sdm.gaji', 'approve'), ctrl.approve);
router.put('/:id/unapprove', requireAccess('sdm.gaji', 'batalapprove'), ctrl.unapprove);
router.put('/:id/unpost', requireAccess('sdm.gaji', 'batalapprove'), ctrl.unapprove);
router.put('/:id/cancel', requireAccess('sdm.gaji', 'bataltransaksi'), ctrl.cancel);
router.put('/:id', requireAccess('sdm.gaji', 'ubah'), ctrl.update);
router.delete('/:id', requireAccess('sdm.gaji', 'bataltransaksi'), ctrl.cancel);

module.exports = router;
