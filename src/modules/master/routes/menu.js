const router = require('express').Router();
const ctrl = require('../menuController');
const auth = require('../../../middleware/auth');

router.get('/all', auth, ctrl.getAll);
router.get('/my', auth, ctrl.myMenu);

module.exports = router;
