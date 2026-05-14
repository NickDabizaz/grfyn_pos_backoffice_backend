const router = require('express').Router();
const ctrl = require('../pelunasanpiutangController');
const auth = require('../../../middleware/auth');

router.get('/', auth, ctrl.getAll);
router.get('/:id', auth, ctrl.getOne);
router.post('/', auth, ctrl.create);
router.delete('/:id', auth, ctrl.remove);

module.exports = router;