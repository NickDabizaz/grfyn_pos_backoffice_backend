const express = require('express');
const router = express.Router();
const auth = require('../../../middleware/auth');
const ctrl = require('../bpbController');

router.use(auth);

router.get('/', ctrl.getAll);
router.get('/:id', ctrl.getOne);
router.post('/', ctrl.create);
router.put('/:id/approve', ctrl.approve);
router.put('/:id/unapprove', ctrl.unapprove);
router.put('/:id', ctrl.update);

module.exports = router;
