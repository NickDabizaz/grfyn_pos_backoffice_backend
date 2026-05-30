const express = require('express');
const router = express.Router();
const auth = require('../../../middleware/auth');
const { requireAccess } = require('../../../lib/access');
const ctrl = require('../karyawanController');

router.use(auth);

router.get('/', requireAccess('master.karyawan', 'hakakses'), ctrl.getAll);
router.get('/:id', requireAccess('master.karyawan', 'hakakses'), ctrl.getOne);
router.post('/', requireAccess('master.karyawan', 'tambah'), ctrl.create);
router.put('/:id', requireAccess('master.karyawan', 'ubah'), ctrl.update);
router.delete('/:id', requireAccess('master.karyawan', 'tambah'), ctrl.remove);

module.exports = router;
