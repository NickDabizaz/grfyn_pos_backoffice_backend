require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    port: parseInt(process.env.DB_PORT) || 3306
  });

  console.log('Connected to MySQL');

  // Create database
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'grfyn_pos'}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.query(`USE \`${process.env.DB_NAME || 'grfyn_pos'}\``);
  console.log(`Database ${process.env.DB_NAME} ready`);

  // Drop tables in reverse dependency order
  const tables = [
    'closing', 'kartustok', 'saldostokdtl', 'saldostok',
    'saldoawaldtl', 'saldoawal',
    'penyesuaianstokdtl', 'penyesuaianstok',
    'belidtl', 'beli', 'jualdtl', 'jual',
    'hargajual', 'hargabeli',
    'barang', 'supplier', 'customer', 'users'
  ];
  for (const t of tables) {
    await connection.query(`DROP TABLE IF EXISTS \`${t}\``);
  }
  console.log('Tables dropped');

  // 1. users
  await connection.query(`
    CREATE TABLE users (
      iduser INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      email VARCHAR(100),
      pass VARCHAR(255) NOT NULL,
      namatoko VARCHAR(100),
      alamat TEXT,
      hp VARCHAR(20),
      logo VARCHAR(255),
      ppn DECIMAL(5,2) DEFAULT 11.00,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // 2. customer
  await connection.query(`
    CREATE TABLE customer (
      idcustomer INT AUTO_INCREMENT PRIMARY KEY,
      kodecustomer VARCHAR(20) NOT NULL UNIQUE,
      namacustomer VARCHAR(100) NOT NULL,
      alamat TEXT,
      hp VARCHAR(20)
    ) ENGINE=InnoDB
  `);

  // 3. supplier
  await connection.query(`
    CREATE TABLE supplier (
      idsupplier INT AUTO_INCREMENT PRIMARY KEY,
      kodesupplier VARCHAR(20) NOT NULL UNIQUE,
      namasupplier VARCHAR(100) NOT NULL,
      alamat TEXT,
      hp VARCHAR(20)
    ) ENGINE=InnoDB
  `);

  // 4. barang
  await connection.query(`
    CREATE TABLE barang (
      idbarang INT AUTO_INCREMENT PRIMARY KEY,
      kodebarang VARCHAR(20) NOT NULL UNIQUE,
      namabarang VARCHAR(200) NOT NULL,
      satuan VARCHAR(20),
      stokmin INT DEFAULT 0,
      status INT DEFAULT 1
    ) ENGINE=InnoDB
  `);

  // 5. hargabeli
  await connection.query(`
    CREATE TABLE hargabeli (
      idhargabeli INT AUTO_INCREMENT PRIMARY KEY,
      idbarang INT NOT NULL,
      hargabeli DECIMAL(15,2) NOT NULL,
      tgltrans DATE NOT NULL,
      FOREIGN KEY (idbarang) REFERENCES barang(idbarang) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // 6. hargajual
  await connection.query(`
    CREATE TABLE hargajual (
      idhargajual INT AUTO_INCREMENT PRIMARY KEY,
      idbarang INT NOT NULL,
      hargajual DECIMAL(15,2) NOT NULL,
      tgltrans DATE NOT NULL,
      FOREIGN KEY (idbarang) REFERENCES barang(idbarang) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // 7. jual
  await connection.query(`
    CREATE TABLE jual (
      idjual INT AUTO_INCREMENT PRIMARY KEY,
      kodejual VARCHAR(30) NOT NULL UNIQUE,
      tgltrans DATE NOT NULL,
      idcustomer INT,
      idkasir INT,
      grandtotal DECIMAL(15,2) DEFAULT 0,
      bayar DECIMAL(15,2) DEFAULT 0,
      kembali DECIMAL(15,2) DEFAULT 0,
      status INT DEFAULT 1,
      FOREIGN KEY (idcustomer) REFERENCES customer(idcustomer),
      FOREIGN KEY (idkasir) REFERENCES users(iduser)
    ) ENGINE=InnoDB
  `);

  // 8. jualdtl
  await connection.query(`
    CREATE TABLE jualdtl (
      idjualdtl INT AUTO_INCREMENT PRIMARY KEY,
      idjual INT NOT NULL,
      kodejual VARCHAR(30),
      idbarang INT,
      jml INT NOT NULL,
      harga DECIMAL(15,2) NOT NULL,
      ppn DECIMAL(15,2) DEFAULT 0,
      diskon DECIMAL(5,2) DEFAULT 0,
      subtotal DECIMAL(15,2) NOT NULL,
      FOREIGN KEY (idjual) REFERENCES jual(idjual) ON DELETE CASCADE,
      FOREIGN KEY (idbarang) REFERENCES barang(idbarang)
    ) ENGINE=InnoDB
  `);

  // 9. beli
  await connection.query(`
    CREATE TABLE beli (
      idbeli INT AUTO_INCREMENT PRIMARY KEY,
      kodebeli VARCHAR(30) NOT NULL UNIQUE,
      tgltrans DATE NOT NULL,
      idsupplier INT,
      idkasir INT,
      grandtotal DECIMAL(15,2) DEFAULT 0,
      bayar DECIMAL(15,2) DEFAULT 0,
      status INT DEFAULT 1,
      FOREIGN KEY (idsupplier) REFERENCES supplier(idsupplier),
      FOREIGN KEY (idkasir) REFERENCES users(iduser)
    ) ENGINE=InnoDB
  `);

  // 10. belidtl
  await connection.query(`
    CREATE TABLE belidtl (
      idbelidtl INT AUTO_INCREMENT PRIMARY KEY,
      idbeli INT NOT NULL,
      kodebeli VARCHAR(30),
      idbarang INT,
      jml INT NOT NULL,
      harga DECIMAL(15,2) NOT NULL,
      ppn DECIMAL(15,2) DEFAULT 0,
      diskon DECIMAL(5,2) DEFAULT 0,
      subtotal DECIMAL(15,2) NOT NULL,
      FOREIGN KEY (idbeli) REFERENCES beli(idbeli) ON DELETE CASCADE,
      FOREIGN KEY (idbarang) REFERENCES barang(idbarang)
    ) ENGINE=InnoDB
  `);

  // 11. penyesuaianstok
  await connection.query(`
    CREATE TABLE penyesuaianstok (
      idpenyesuaianstok INT AUTO_INCREMENT PRIMARY KEY,
      kodepenyesuaianstok VARCHAR(30) NOT NULL UNIQUE,
      tgltrans DATE NOT NULL,
      idkasir INT,
      keterangan TEXT,
      status INT DEFAULT 1,
      FOREIGN KEY (idkasir) REFERENCES users(iduser)
    ) ENGINE=InnoDB
  `);

  // 12. penyesuaianstokdtl
  await connection.query(`
    CREATE TABLE penyesuaianstokdtl (
      idpenyesuaianstokdtl INT AUTO_INCREMENT PRIMARY KEY,
      idpenyesuaianstok INT NOT NULL,
      kodepenyesuaianstok VARCHAR(30),
      idbarang INT,
      jml INT NOT NULL,
      selisih INT NOT NULL,
      keterangan TEXT,
      FOREIGN KEY (idpenyesuaianstok) REFERENCES penyesuaianstok(idpenyesuaianstok) ON DELETE CASCADE,
      FOREIGN KEY (idbarang) REFERENCES barang(idbarang)
    ) ENGINE=InnoDB
  `);

  // 13. saldostok
  await connection.query(`
    CREATE TABLE saldostok (
      idsaldostok INT AUTO_INCREMENT PRIMARY KEY,
      kodesaldostok VARCHAR(30) NOT NULL UNIQUE,
      tgltrans DATE NOT NULL,
      keterangan VARCHAR(200),
      status INT DEFAULT 1
    ) ENGINE=InnoDB
  `);

  // 14. saldostokdtl
  await connection.query(`
    CREATE TABLE saldostokdtl (
      idsaldostokdtl INT AUTO_INCREMENT PRIMARY KEY,
      idsaldostok INT NOT NULL,
      kodesaldostok VARCHAR(30),
      idbarang INT,
      jml INT NOT NULL,
      FOREIGN KEY (idsaldostok) REFERENCES saldostok(idsaldostok) ON DELETE CASCADE,
      FOREIGN KEY (idbarang) REFERENCES barang(idbarang)
    ) ENGINE=InnoDB
  `);

  // 15. kartustok
  await connection.query(`
    CREATE TABLE kartustok (
      idkartustok INT AUTO_INCREMENT PRIMARY KEY,
      kodetrans VARCHAR(30) NOT NULL,
      idbarang INT,
      jml INT NOT NULL,
      jenis ENUM('M', 'K') NOT NULL,
      tgltrans DATE NOT NULL,
      keterangan TEXT,
      idref INT,
      jenisref VARCHAR(30),
      FOREIGN KEY (idbarang) REFERENCES barang(idbarang)
    ) ENGINE=InnoDB
  `);

  // 16. saldoawal
  await connection.query(`
    CREATE TABLE saldoawal (
      idsaldoawal INT AUTO_INCREMENT PRIMARY KEY,
      kodesaldoawal VARCHAR(30) NOT NULL UNIQUE,
      tgltrans DATE NOT NULL,
      catatan TEXT,
      status INT DEFAULT 1
    ) ENGINE=InnoDB
  `);

  // 17. saldoawaldtl
  await connection.query(`
    CREATE TABLE saldoawaldtl (
      idsaldoawaldtl INT AUTO_INCREMENT PRIMARY KEY,
      idsaldoawal INT NOT NULL,
      kodesaldoawal VARCHAR(30),
      idbarang INT,
      jml INT NOT NULL,
      harga DECIMAL(15,2) NOT NULL,
      subtotal DECIMAL(15,2) NOT NULL,
      FOREIGN KEY (idsaldoawal) REFERENCES saldoawal(idsaldoawal) ON DELETE CASCADE,
      FOREIGN KEY (idbarang) REFERENCES barang(idbarang)
    ) ENGINE=InnoDB
  `);

  // 18. closing
  await connection.query(`
    CREATE TABLE closing (
      idclosing INT AUTO_INCREMENT PRIMARY KEY,
      kodeclosing VARCHAR(30) NOT NULL UNIQUE,
      tglclosing DATE NOT NULL,
      jenis ENUM('harian', 'bulanan') NOT NULL,
      status INT DEFAULT 1
    ) ENGINE=InnoDB
  `);

  // Indexes
  await connection.query(`CREATE INDEX idx_kartustok_barang ON kartustok(idbarang, tgltrans)`);
  await connection.query(`CREATE INDEX idx_kartustok_tgl ON kartustok(tgltrans)`);
  await connection.query(`CREATE INDEX idx_jual_tgl ON jual(tgltrans)`);
  await connection.query(`CREATE INDEX idx_beli_tgl ON beli(tgltrans)`);
  await connection.query(`CREATE INDEX idx_saldostok_tgl ON saldostok(tgltrans)`);
  await connection.query(`CREATE INDEX idx_hargabeli_barang ON hargabeli(idbarang, tgltrans DESC)`);
  await connection.query(`CREATE INDEX idx_hargajual_barang ON hargajual(idbarang, tgltrans DESC)`);

  console.log('All tables created');

  // Seed data
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('admin123', 10);

  await connection.query(`INSERT INTO users (username, email, pass, namatoko, alamat, hp) VALUES (?, ?, ?, ?, ?, ?)`,
    ['admin', 'admin@grfyn.com', hash, 'Grfyn POS', 'Jl. Contoh No. 123', '081234567890']);

  await connection.query(`INSERT INTO customer (kodecustomer, namacustomer, alamat, hp) VALUES (?, ?, ?, ?)`,
    ['CST-0001', 'CASH', 'Umum', '-']);

  await connection.query(`INSERT INTO supplier (kodesupplier, namasupplier, alamat, hp) VALUES (?, ?, ?, ?)`,
    ['SUP-0001', 'Supplier Umum', '-', '-']);

  console.log('Seed data inserted');
  console.log('Migration completed successfully!');
  console.log('Default login: admin / admin123');

  await connection.end();
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
