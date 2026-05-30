const express = require('express');
const router = express.Router();
const auth = require('../../../middleware/auth');
const { requireAccess } = require('../../../lib/access');
const ctrl = require('../settingAbsensiController');

router.use(auth);

router.get('/', requireAccess('sdm.settingabsensi', 'hakakses'), ctrl.getAll);
router.post('/', requireAccess('sdm.settingabsensi', 'tambah'), ctrl.create);
router.put('/:id', requireAccess('sdm.settingabsensi', 'ubah'), ctrl.update);

module.exports = router;
