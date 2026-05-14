/**
 * Controller untuk menu navigasi berdasarkan hak akses user.
 * Endpoint: GET /api/menu/my
 */
const { pool, getTenantContext } = require('../../config/db');
const logger = require('../../lib/logger');

// GET /api/menu/all — Mengambil semua menu (untuk user management)
exports.getAll = async (req, res) => {
  try {
    const [menus] = await pool.query(
      'SELECT * FROM menu ORDER BY urutan ASC'
    );
    function buildTree(items, parentId = null) {
      return items
        .filter(item => item.idparent === parentId)
        .map(item => ({
          ...item,
          children: buildTree(items, item.idmenu),
        }));
    }
    const tree = buildTree(menus);
    res.json(tree);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/menu/my — Mengambil menu dalam bentuk tree sesuai user yang sedang login
exports.myMenu = async (req, res) => {
  try {
    const ctx = getTenantContext();
    const iduser = ctx.iduser;

    let sql = `SELECT m.* FROM menu m
       JOIN usermenu um ON m.idmenu = um.idmenu AND um.iduser = ?
       WHERE um.status = 'AKTIF'
       ORDER BY m.urutan ASC`;
    // Ambil semua menu yang diizinkan untuk user ini
    const [menus] = await pool.query(sql, [iduser]);

    // Fungsi rekursif membangun struktur tree menu (parent-child)
    function buildTree(items, parentId = null) {
      return items
        .filter(item => item.idparent === parentId)
        .map(item => ({
          ...item,
          children: buildTree(items, item.idmenu),
        }));
    }

    const tree = buildTree(menus);
    res.json(tree);
  } catch (err) {
    logger.error(err, { req });
    res.status(500).json({ message: err.message });
  }
};
