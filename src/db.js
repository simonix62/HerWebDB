const mysql = require('mysql2/promise');

let pool;

async function createDb(config) {
  pool = mysql.createPool({
    host: config.dbHost || 'localhost',
    port: config.dbPort || 3306,
    user: config.dbUser || 'root',
    password: config.dbPassword || 'root123',
    database: config.dbName || 'herwebdb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS people (
        id INTEGER PRIMARY KEY AUTO_INCREMENT,
        name TEXT NOT NULL,
        father TEXT,
        family TEXT,
        birth_year INTEGER,
        city TEXT,
        country TEXT,
        profession TEXT,
        phone TEXT,
        email TEXT,
        hobbies TEXT,
        cv TEXT,
        blood_type TEXT,
        probable_donor TEXT,
        photo TEXT,
        facebook TEXT,
        instagram TEXT,
        created_at TEXT NOT NULL DEFAULT (NOW())
      )
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS contact_messages (
        id INTEGER PRIMARY KEY AUTO_INCREMENT,
        name TEXT,
        email TEXT,
        subject TEXT,
        message TEXT NOT NULL,
        cv_path TEXT,
        photo_path TEXT,
        created_at TEXT NOT NULL DEFAULT (NOW())
      )
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(100) NOT NULL UNIQUE,
        email VARCHAR(255),
        full_name VARCHAR(255),
        password TEXT NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        status VARCHAR(20) NOT NULL DEFAULT 'waiting',
        must_change INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (NOW())
      )
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid VARCHAR(128) PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
      )
    `);

    async function ensureIndex(table, indexName, columnDef) {
      const [rows] = await conn.query(
        `SELECT COUNT(*) AS c FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, indexName]
      );
      if (rows[0].c === 0) {
        await conn.query(`CREATE INDEX \`${indexName}\` ON \`${table}\` (${columnDef})`);
      }
    }

    await ensureIndex('people', 'idx_people_name', 'name(100)');
    await ensureIndex('people', 'idx_people_family', 'family(100)');
    await ensureIndex('people', 'idx_people_city', 'city(100)');
    await ensureIndex('sessions', 'idx_sessions_expire', 'expire');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id INTEGER PRIMARY KEY AUTO_INCREMENT,
        name TEXT NOT NULL,
        business_type TEXT,
        city TEXT,
        country TEXT,
        owner TEXT,
        speciality TEXT,
        phone TEXT,
        email TEXT,
        photo TEXT,
        facebook TEXT,
        instagram TEXT,
        tiktok TEXT,
        created_at TEXT NOT NULL DEFAULT (NOW())
      )
    `);
    await ensureIndex('businesses', 'idx_businesses_name', 'name(100)');
    await ensureIndex('businesses', 'idx_businesses_city', 'city(100)');
    await ensureIndex('businesses', 'idx_businesses_country', 'country(100)');
  } finally {
    conn.release();
  }

  return pool;
}

function getDb() {
  return pool;
}

module.exports = { createDb, getDb };
