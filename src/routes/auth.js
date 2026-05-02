const router = require('express').Router();
const ctrl = require('../controllers/authController');
const auth = require('../middleware/auth');

router.post('/login', ctrl.login);
router.get('/me', auth, ctrl.me);
router.put('/password', auth, ctrl.changePassword);

module.exports = router;
