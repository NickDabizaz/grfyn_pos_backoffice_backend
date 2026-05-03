require('dotenv').config();
const mysql = require('mysql2/promise');

async function alter() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    port: parseInt(process.env.DB_PORT) || 3306,
    database: process.env.DB_NAME || 'grfyn_pos'
  });

  console.log('Connected to MySQL');

  try {
    await connection.query(`
      ALTER TABLE jual
      ADD COLUMN IF NOT EXISTS jenis ENUM('POS','JUAL') DEFAULT 'POS'
    `);
    console.log('Column jenis added to jual table');
  } catch (err) {
    console.log('Alter error (column may already exist):', err.message);
  }

  await connection.end();
  process.exit(0);
}

alter().catch(err => {
  console.error('Alter failed:', err);
  process.exit(1);
});
