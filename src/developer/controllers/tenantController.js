const { pool } = require('../../config/db');

exports.index = async (req, res) => {
  try {
    const [tenants] = await pool.query(
      `SELECT t.*,
        (SELECT COUNT(*) FROM user WHERE idtenant = t.idtenant) as jml_user,
        (SELECT COUNT(*) FROM lokasi WHERE idtenant = t.idtenant) as jml_lokasi,
        (SELECT COUNT(*) FROM jual WHERE idtenant = t.idtenant) as jml_jual,
        (SELECT COUNT(*) FROM beli WHERE idtenant = t.idtenant) as jml_beli,
        (SELECT MAX(tgltrans) FROM jual WHERE idtenant = t.idtenant) as last_jual,
        (SELECT MAX(tgltrans) FROM beli WHERE idtenant = t.idtenant) as last_beli
       FROM tenant t ORDER BY t.idtenant`
    );

    res.render('layout', { view: 'tenants', 
      title: 'Tenant Overview',
      active: 'tenants',
      tenants
    });
  } catch (err) {
    res.render('layout', { view: 'tenants', 
      title: 'Tenant Overview',
      active: 'tenants',
      tenants: [],
      error: err.message
    });
  }
};
