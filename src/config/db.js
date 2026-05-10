/**
 * Konfigurasi koneksi database MySQL dengan multi-tenant support.
 * Menggunakan mysql2/promise untuk async/await dan cls-hooked untuk menyimpan
 * konteks tenant (idtenant, idlokasi, iduser) di Continuation-Local Storage.
 *
 * Fungsi utama:
 *   pool          — connection pool MySQL
 *   tenantQuery   — SELECT dengan auto-inject WHERE idtenant = ?
 *   tenantExecute — INSERT/UPDATE/DELETE dengan validasi kolom idtenant
 *   getConnection — mendapatkan koneksi dari pool (untuk transaksi manual)
 */
const mysql = require('mysql2/promise');
const { createNamespace, getNamespace } = require('cls-hooked');
require('dotenv').config();

const TENANT_NS = 'grfyn_tenant';

let ns = null;

// Inisialisasi namespace CLS untuk menyimpan konteks tenant per request
function initTenantNamespace() {
  ns = createNamespace(TENANT_NS);
  return ns;
}

// Membaca konteks tenant (idtenant, idlokasi, iduser) dari namespace CLS
function getTenantContext() {
  const ns = getNamespace(TENANT_NS);
  if (!ns) return { idtenant: null, idlokasi: null, iduser: null };
  return {
    idtenant: ns.get('idtenant'),
    idlokasi: ns.get('idlokasi'),
    iduser: ns.get('iduser'),
  };
}

// Pool koneksi MySQL (config dari environment variable)
const pool = mysql.createPool({
  host              : process.env.DB_HOST || 'localhost',
  user              : process.env.DB_USER || 'root',
  password          : process.env.DB_PASS || '',
  database          : process.env.DB_NAME || 'grfyn_pos',
  port              : parseInt(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit   : 10,
  queueLimit        : 0
});

// Inject WHERE idtenant = ? ke query SELECT jika belum ada klausa idtenant
// Mencari kata kunci SQL (WHERE, GROUP BY, ORDER BY, dll) lalu menyisipkan idtenant sebelum kata kunci pertama
function injectTenantWhere(sql, idtenant) {
  const trimmed = sql.trim();
  if (!/^SELECT/i.test(trimmed)) return { sql, injected: false };
  if (/idtenant/i.test(trimmed)) return { sql, injected: false };

  const keywords = /\b(WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|PROCEDURE|INTO\s+OUTFILE|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE)\b/i;

  const match = trimmed.match(keywords);
  if (match) {
    const idx = match.index;
    const before = trimmed.substring(0, idx);
    const after = trimmed.substring(idx);
    if (match[1].toUpperCase() === 'WHERE') {
      return { sql: `${before} WHERE idtenant = ? AND ${after.substring(5).trim()}`, injected: true };
    }
    return { sql: `${before} WHERE idtenant = ? ${after}`, injected: true };
  }

  return { sql: `${trimmed} WHERE idtenant = ?`, injected: true };
}

// tenantQuery: untuk query SELECT, otomatis inject WHERE idtenant = ? jika belum ada
async function tenantQuery(sql, params = []) {
  const ctx = getTenantContext();
  if (!ctx.idtenant) throw new Error('TENANT_NOT_FOUND: idtenant tidak tersedia di context');

  if (/^\s*SELECT/i.test(sql.trim())) {
    const { sql: modSql, injected } = injectTenantWhere(sql, ctx.idtenant);
    if (injected) {
      params = [ctx.idtenant, ...params];
    }
    const [rows] = await pool.query(modSql, params);
    return rows;
  }

  const [rows] = await pool.query(sql, params);
  return rows;
}

// tenantExecute: untuk INSERT/UPDATE/DELETE, validasi bahwa kolom idtenant wajib disertakan dalam query
async function tenantExecute(sql, params = []) {
  const ctx = getTenantContext();
  if (!ctx.idtenant) throw new Error('TENANT_NOT_FOUND: idtenant tidak tersedia di context');

  if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql.trim())) {
    if (!/idtenant/i.test(sql)) {
      throw new Error('MISSING_TENANT: INSERT/UPDATE/DELETE wajib menyertakan kolom idtenant');
    }
  }

  const [result] = await pool.query(sql, params);
  return result;
}

// Mendapatkan satu koneksi dari pool (digunakan untuk transaksi dengan beginTransaction/commit/rollback manual)
async function getConnection() {
  return pool.getConnection();
}

module.exports = {
  pool,
  tenantQuery,
  tenantExecute,
  getConnection,
  getTenantContext,
  initTenantNamespace,
  getNamespace,
  TENANT_NS,
};
