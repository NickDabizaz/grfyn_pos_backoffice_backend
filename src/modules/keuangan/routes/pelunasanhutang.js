const router = require('express').Router();
const ctrl = require('../pelunasanhutangController');
const auth = require('../../../middleware/auth');
const { requireAccess } = require('../../../lib/access');
const { requireTransactionQuota } = require('../../../middleware/subscription');

router.get('/', auth, requireAccess('keuangan.pelunasanhutang', 'hakakses'), ctrl.getAll);
router.get('/:id', auth, requireAccess('keuangan.pelunasanhutang', 'hakakses'), ctrl.getOne);
router.post('/', auth, requireAccess('keuangan.pelunasanhutang', 'tambah'), requireTransactionQuota(), ctrl.create);
router.put('/:id', auth, requireAccess('keuangan.pelunasanhutang', 'ubah'), ctrl.update);
router.put('/:id/approve', auth, requireAccess('keuangan.pelunasanhutang', 'ubah'), ctrl.approve);
router.put('/:id/unapprove', auth, requireAccess('keuangan.pelunasanhutang', 'ubah'), ctrl.unapprove);
router.put('/:id/batal', auth, requireAccess('keuangan.pelunasanhutang', 'ubah'), ctrl.cancel);
router.delete('/:id', auth, requireAccess('keuangan.pelunasanhutang', 'ubah'), ctrl.remove);

module.exports = router;
