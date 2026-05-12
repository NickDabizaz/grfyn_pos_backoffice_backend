const router = require('express').Router();
const ctrl = require('../controllers/menuController');
const auth = require('../middleware/auth');

router.get('/all', auth, ctrl.getAll);
router.get('/my', auth, ctrl.myMenu);

module.exports = router;
