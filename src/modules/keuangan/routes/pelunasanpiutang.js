const router = require('express').Router();
const ctrl = require('../pelunasanpiutangController');
const auth = require('../../../middleware/auth');
const { requireAccess } = require('../../../lib/access');
const { requireTransactionQuota } = require('../../../middleware/subscription');

router.get('/', auth, requireAccess('keuangan.pelunasanpiutang', 'hakakses'), ctrl.getAll);
router.get('/:id', auth, requireAccess('keuangan.pelunasanpiutang', 'hakakses'), ctrl.getOne);
router.post('/', auth, requireAccess('keuangan.pelunasanpiutang', 'tambah'), requireTransactionQuota(), ctrl.create);
router.put('/:id', auth, requireAccess('keuangan.pelunasanpiutang', 'ubah'), ctrl.update);
router.put('/:id/approve', auth, requireAccess('keuangan.pelunasanpiutang', 'ubah'), ctrl.approve);
router.put('/:id/unapprove', auth, requireAccess('keuangan.pelunasanpiutang', 'ubah'), ctrl.unapprove);
router.put('/:id/batal', auth, requireAccess('keuangan.pelunasanpiutang', 'ubah'), ctrl.cancel);
router.delete('/:id', auth, requireAccess('keuangan.pelunasanpiutang', 'ubah'), ctrl.remove);

module.exports = router;
