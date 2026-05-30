const express = require('express');
const router = express.Router();
const auth = require('../../../middleware/auth');
const { requireAccess } = require('../../../lib/access');
const { requireTransactionQuota } = require('../../../middleware/subscription');
const ctrl = require('../absensiController');

router.use(auth);

router.get('/rekap', requireAccess('sdm.absensi', 'hakakses'), ctrl.rekapBulanan);
router.get('/', requireAccess('sdm.absensi', 'hakakses'), ctrl.getAll);
router.get('/:id', requireAccess('sdm.absensi', 'hakakses'), ctrl.getOne);
router.post('/', requireAccess('sdm.absensi', 'tambah'), requireTransactionQuota(), ctrl.create);
router.put('/:id/approve', requireAccess('sdm.absensi', 'approve'), ctrl.approve);
router.put('/:id/unapprove', requireAccess('sdm.absensi', 'batalapprove'), ctrl.unapprove);
router.put('/:id/cancel', requireAccess('sdm.absensi', 'bataltransaksi'), ctrl.cancel);
router.put('/:id', requireAccess('sdm.absensi', 'ubah'), ctrl.update);

module.exports = router;
