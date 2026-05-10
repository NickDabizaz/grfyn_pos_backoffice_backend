// Library untuk pencatatan log error (ke file JSON) dan history aktivitas (ke database).
// Log error disimpan per hari dengan format error-YYYY-MM-DD.json, otomatis dibersihkan setelah 30 hari.
// History aktivitas disimpan ke tabel historyprogram untuk keperluan audit trail.

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs'); // Direktori penyimpanan file log

/**
 * Mendapatkan path file log berdasarkan tanggal.
 * Format nama file: error-YYYY-MM-DD.json
 */
function getLogFilePath(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `error-${y}-${m}-${day}.json`);
}

/**
 * Membersihkan file log yang lebih tua dari retentionDays (default 30 hari).
 */
function cleanOldLogs(retentionDays = 30) {
  if (!fs.existsSync(LOG_DIR)) return;
  const files = fs.readdirSync(LOG_DIR);
  const now = new Date();
  let deleted = 0;
  for (const f of files) {
    const match = f.match(/^error-(\d{4})-(\d{2})-(\d{2})\.json$/);
    if (!match) continue;
    const fileDate = new Date(`${match[1]}-${match[2]}-${match[3]}`);
    const diffDays = Math.floor((now - fileDate) / (1000 * 60 * 60 * 24));
    if (diffDays > retentionDays) {
      try {
        fs.unlinkSync(path.join(LOG_DIR, f));
        deleted++;
      } catch (_) {}
    }
  }
  if (deleted > 0) console.log(`[logger] Cleaned ${deleted} old log files`);
}

/**
 * Mencatat error ke file log harian dalam format JSON Lines.
 *
 * @param {Error} err - Error object
 * @param {object} context - Konteks tambahan: req, idtenant, iduser, path, method
 */
async function error(err, context = {}) {
  const { req, idtenant, iduser, path: reqPath, method } = context;

  const entry = {
    ts: new Date().toISOString(),       // Timestamp ISO
    level: 'error',
    message: err?.message || String(err),
    stack: err?.stack || null,
    idtenant: idtenant || null,
    iduser: iduser || null,
    path: reqPath || req?.originalUrl || req?.url || null,
    method: method || req?.method || null
  };

  try {
    const filePath = getLogFilePath();
    // Append satu baris JSON ke file log harian
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (writeErr) {
    console.error('[logger] Failed to write error log:', writeErr.message);
  }
}

/**
 * Mencatat history aktivitas user ke tabel historyprogram (audit trail).
 *
 * @param {string} action - Jenis aksi (LOGIN, REGISTER, USER_CREATE, dll)
 * @param {object} context - Konteks: idtenant, idlokasi, iduser, ref, detail, req
 */
async function history(action, context = {}) {
  const { idtenant, idlokasi, iduser, ref, detail, req } = context;

  const ip = req?.ip || req?.socket?.remoteAddress || null;
  const useragent = req?.headers?.['user-agent'] || null;

  try {
    await pool.query(
      `INSERT INTO historyprogram (idtenant, idlokasi, iduser, action, ref, detail, ip, useragent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        idtenant || null,
        idlokasi || null,
        iduser || null,
        action,
        ref || null,
        detail ? JSON.stringify(detail) : null, // Detail disimpan sebagai JSON string
        ip,
        useragent ? useragent.substring(0, 255) : null // Batasi 255 karakter
      ]
    );
  } catch (dbErr) {
    console.error('[logger] Failed to write history:', dbErr.message);
  }
}

module.exports = { error, history, cleanOldLogs };
