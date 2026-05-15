const DEFAULT_CONFIGS = {
  GLOBAL: {
    CEKMINUS: 'TIDAK',
  },
  BARANG: {
    PAKAIBAHANBAKU: 'YA',
  },
};

let configTableReady = false;

async function ensureConfigTable(conn) {
  if (configTableReady) return;

  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`config\` (
      idtenant INT NOT NULL,
      modul    VARCHAR(50) NOT NULL,
      config   VARCHAR(50) NOT NULL,
      value    VARCHAR(100) DEFAULT NULL,
      status   INT DEFAULT 1,
      PRIMARY KEY (idtenant, modul, config),
      INDEX idx_config_tenant_modul (idtenant, modul)
    ) ENGINE=InnoDB
  `);

  configTableReady = true;
}

async function getConfigValue(conn, idtenant, modul, config) {
  await ensureConfigTable(conn);

  const normalizedModul = String(modul || '').toUpperCase();
  const normalizedConfig = String(config || '').toUpperCase();
  const [[row]] = await conn.query(
    'SELECT value FROM `config` WHERE idtenant = ? AND modul = ? AND config = ? AND status = 1 LIMIT 1',
    [idtenant, normalizedModul, normalizedConfig]
  );

  return row?.value || DEFAULT_CONFIGS[normalizedModul]?.[normalizedConfig] || null;
}

async function setConfigValue(conn, idtenant, modul, config, value, status = 1) {
  await ensureConfigTable(conn);

  await conn.query(
    `INSERT INTO \`config\` (idtenant, modul, config, value, status)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), status = VALUES(status)`,
    [
      idtenant,
      String(modul || '').toUpperCase(),
      String(config || '').toUpperCase(),
      String(value || '').toUpperCase(),
      status ? 1 : 0,
    ]
  );
}

async function isCekMinusEnabled(conn, idtenant) {
  const value = await getConfigValue(conn, idtenant, 'GLOBAL', 'CEKMINUS');
  return String(value || '').toUpperCase() === 'YA';
}

async function isPakaiBahanBakuEnabled(conn, idtenant) {
  const value = await getConfigValue(conn, idtenant, 'BARANG', 'PAKAIBAHANBAKU');
  return String(value || '').toUpperCase() === 'YA';
}

async function assertNoMinusStock(conn, { idtenant, idlokasi, idbarangList }) {
  const ids = [...new Set((idbarangList || []).map(Number).filter(Boolean))];
  if (!ids.length) return;

  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT b.idbarang, b.kodebarang, b.namabarang,
            COALESCE(SUM(CASE WHEN ks.jenis = 'M' THEN ks.jml ELSE -ks.jml END), 0) AS stok
     FROM barang b
     LEFT JOIN kartustok ks
       ON ks.idbarang = b.idbarang
      AND ks.idtenant = b.idtenant
      AND ks.idlokasi = ?
     WHERE b.idtenant = ? AND b.idbarang IN (${placeholders})
     GROUP BY b.idbarang, b.kodebarang, b.namabarang
     HAVING stok < 0`,
    [idlokasi, idtenant, ...ids]
  );

  if (rows.length) {
    const barangMinus = rows
      .map(row => `${row.kodebarang || row.idbarang} - ${row.namabarang} (stok ${Number(row.stok)})`)
      .join(', ');
    const err = new Error(`Stok barang menjadi minus: ${barangMinus}`);
    err.statusCode = 400;
    throw err;
  }
}

module.exports = {
  ensureConfigTable,
  getConfigValue,
  setConfigValue,
  isCekMinusEnabled,
  isPakaiBahanBakuEnabled,
  assertNoMinusStock,
};
