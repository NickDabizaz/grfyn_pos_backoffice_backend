const router = require('express').Router();
const ctrl = require('../controllers/settingController');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo_${Date.now()}${ext}`);
  }
});

const upload = multer({ storage });

router.get('/toko', auth, ctrl.getToko);
router.put('/toko', auth, ctrl.updateToko);
router.put('/logo', auth, upload.single('logo'), ctrl.updateLogo);

module.exports = router;
