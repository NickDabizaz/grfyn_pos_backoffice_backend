const router = require('express').Router();
const ctrl = require('../hitunghppController');
const auth = require('../../../middleware/auth');

router.get('/', auth, ctrl.getAll);
router.get('/check/:periodbulan', auth, ctrl.checkPeriod);
router.get('/:id', auth, ctrl.getOne);
router.post('/', auth, ctrl.create);
router.put('/:id/cancel', auth, ctrl.cancel);

module.exports = router;
