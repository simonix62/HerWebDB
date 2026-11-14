require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const mysql = require('mysql2');
const mysqlPromise = require('mysql2/promise');
const { loadConfig } = require('./config');
const { loadSession, saveSession, destroySession, requireAuth, requireRole, requireConfirmed } = require('./auth');

const config = loadConfig(process.env);
fs.mkdirSync(config.uploadDir, { recursive: true });
const contactUploadDir = path.join(config.uploadDir, 'contact');
fs.mkdirSync(contactUploadDir, { recursive: true });
const peopleUploadDir = path.join(config.uploadDir, 'people');
fs.mkdirSync(peopleUploadDir, { recursive: true });
const contactUpload = multer({
  storage: multer.diskStorage({
    destination: contactUploadDir,
    filename: (req, file, cb) => {
      const safe = String(Date.now()) + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, safe);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => {
      const safe = String(Date.now()) + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, safe);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const peopleUpload = multer({
  storage: multer.diskStorage({
    destination: peopleUploadDir,
    filename: (req, file, cb) => {
      const safe = String(Date.now()) + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, safe);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});
const logDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const duplicateLog = path.join(logDir, 'import.log');

const pool = mysqlPromise.createPool({
  host: config.dbHost || 'localhost',
  port: config.dbPort || 3306,
  user: config.dbUser || 'root',
  password: config.dbPassword || 'root123',
  database: config.dbName || 'herwebdb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

pool.on('error', (err) => {
  console.error('MySQL pool error:', err.message);
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// Session middleware
app.use(loadSession(pool));

// JSON error handler - prevent HTML error pages
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const upload = multer({ dest: path.join(config.uploadDir, 'tmp') });

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

function norm(v){ return String(v==null?"":v).trim().toLowerCase(); }
function dupKey(r){ return norm(r['Name']||r['name']) + '|' + norm(r['Father']||r['father']) + '|' + norm(r['Family']||r['family']); }

// ---- Initialize database ----
(async () => {
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
        expire BIGINT NOT NULL
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

    // seed admin user if none exists
    const [countRows] = await pool.query('SELECT COUNT(*) AS c FROM users');
    const count = countRows[0].c;
    if (count === 0) {
      const username = process.env.ADMIN_USER || 'admin';
      const password = process.env.ADMIN_PASS || 'admin';
      const hash = bcrypt.hashSync(password, 10);
      await pool.query('INSERT INTO users (username, password, role, status, must_change) VALUES (?,?,?,\'confirmed\',1)', [username, hash, 'admin']);
      console.log(`Seeded admin user "${username}" (change password after first login)`);
    }

    // ensure existing admin users are confirmed
    try { await pool.query("UPDATE users SET status = 'confirmed' WHERE role = 'admin'"); } catch (_) {}
  } finally {
    conn.release();
  }

  app.listen(config.port, () => {
    console.log(`HerWebDB listening on http://localhost:${config.port}`);
  });
})().catch(err => {
  console.error('Failed to initialize database:', err.message);
  process.exit(1);
});

// ---- Auth routes ----
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const [rows] = await pool.query('SELECT id, username, password, role, status, must_change FROM users WHERE username = ?', [String(username).trim()]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(String(password), user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  if (!req.session) req.session = {};
  req.session.user = { id: user.id, username: user.username, role: user.role, status: user.status };
  req.sessionID = crypto.randomBytes(24).toString('hex');
  await saveSession(pool, req, res);
  res.json({ ok: true, user: req.session.user, mustChange: !!user.must_change });
});

// POST self-registration (open to anyone)
app.post('/api/register', async (req, res) => {
  const { full_name, email, username, password } = req.body || {};
  if (!full_name || !email || !username || !password) return res.status(400).json({ error: 'All fields are required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const [emailRows] = await pool.query('SELECT id FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
  if (emailRows.length > 0) return res.status(409).json({ error: 'Email already exists. Check your username or password.' });
  const [userRows] = await pool.query('SELECT id FROM users WHERE username = ?', [String(username).trim()]);
  if (userRows.length > 0) return res.status(409).json({ error: 'Username already exists. Choose another.' });
  try {
    const hash = bcrypt.hashSync(String(password), 10);
    await pool.query('INSERT INTO users (full_name, email, username, password, role, status, must_change) VALUES (?,?,?,?,\'viewer\',\'waiting\',0)', [
      String(full_name).trim(),
      String(email).trim().toLowerCase(),
      String(username).trim(),
      hash
    ]);
    res.json({ ok: true, message: 'Account created. Your registration is waiting for admin confirmation.' });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Email or username already exists' : e.message });
  }
});

app.post('/api/logout', async (req, res) => {
  destroySession(pool, req, res);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  if (req.session && req.session.user) {
    const [uRows] = await pool.query('SELECT status, must_change FROM users WHERE id = ?', [req.session.user.id]);
    const u = uRows[0];
    return res.json({ user: { id: req.session.user.id, username: req.session.user.username, role: req.session.user.role, status: u ? u.status : req.session.user.status }, mustChange: !!(u && u.must_change) });
  }
  res.status(401).json({ error: 'Not authenticated' });
});

// ---- Data routes (gated) ----
// GET all people: any authenticated confirmed user
app.get('/api/people', requireConfirmed, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM people ORDER BY name');
  res.json(rows);
});

// GET single person by ID (admin)
app.get('/api/people/:id', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM people WHERE id = ?', [Number(req.params.id)]);
  const person = rows[0];
  if (!person) return res.status(404).json({ error: 'Person not found' });
  res.json(person);
});

// UPDATE person (admin) with optional photo upload
app.put('/api/people/:id', requireRole('admin'), peopleUpload.single('photo'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, father, family, birth_year, city, country, profession, phone, email, hobbies, cv, blood_type, probable_donor, facebook, instagram } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const [personRows] = await pool.query('SELECT id, photo FROM people WHERE id = ?', [id]);
  const person = personRows[0];
  if (!person) return res.status(404).json({ error: 'Person not found' });
  let photoPath = person.photo;
  if (req.file) {
    photoPath = 'uploads/people/' + req.file.filename;
  }
  await pool.query(`UPDATE people SET name=?, father=?, family=?, birth_year=?, city=?, country=?, profession=?, phone=?, email=?, hobbies=?, cv=?, blood_type=?, probable_donor=?, photo=?, facebook=?, instagram=? WHERE id=?`, [
    name, father, family, birth_year, city, country, profession, phone, email, hobbies, cv, blood_type, probable_donor, photoPath, facebook, instagram, id
  ]);
  res.json({ ok: true });
});

// DELETE person (admin)
app.delete('/api/people/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const [personRows] = await pool.query('SELECT id FROM people WHERE id = ?', [id]);
  if (personRows.length === 0) return res.status(404).json({ error: 'Person not found' });
  await pool.query('DELETE FROM people WHERE id = ?', [id]);
  res.json({ ok: true });
});

// POST import an Excel file
app.post('/api/import', requireRole('admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

    const [existingRows] = await pool.query('SELECT name, father, family FROM people');
    const existing = new Set(existingRows.map(r => norm(r.name)+'|'+norm(r.father)+'|'+norm(r.family)));

    const seen = new Set();
    let imported = 0, skipped = 0, invalid = 0;
    const dupLines = [];

    const conn = await pool.getConnection();
    await conn.query('START TRANSACTION');
    try {
      for (const r of rows) {
        const name = r['Name'] || r['name'];
        if (!name) { invalid++; continue; }
        const key = dupKey(r);
        if (existing.has(key) || seen.has(key)) {
          skipped++;
          dupLines.push(`[${new Date().toISOString()}] DUPLICATE skipped: Name="${r['Name']||r['name']}", Father="${r['Father']||r['father']}", Family="${r['Family']||r['family']}" (file: ${req.file.originalname})`);
          continue;
        }
        await conn.query(`INSERT INTO people (name, father, family, birth_year, city, country, profession, phone, email, hobbies, cv, blood_type, probable_donor, photo, facebook, instagram) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          name,
          r['Father'] ?? r['father'] ?? null,
          r['Family'] ?? r['family'] ?? null,
          r['Year of birth'] ?? r['birth_year'] ?? null,
          r['City'] ?? r['city'] ?? null,
          r['Country'] ?? r['country'] ?? null,
          r['Profession'] ?? r['profession'] ?? null,
          r['Phone number'] ?? r['phone'] ?? null,
          r['email address'] ?? r['email'] ?? null,
          r['Hobbies'] ?? r['hobbies'] ?? null,
          r['CV'] ?? r['cv'] ?? null,
          r['Blood type'] ?? r['blood_type'] ?? null,
          r['Probable donor'] ?? r['probable_donor'] ?? null,
          r['Photo'] ?? r['photo'] ?? null,
          r['Facebook account'] ?? r['facebook'] ?? null,
          r['Instagram account'] ?? r['instagram'] ?? null,
        ]);
        seen.add(key);
        imported++;
      }
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    } finally {
      conn.release();
    }

    if (dupLines.length) {
      fs.appendFileSync(duplicateLog, dupLines.join('\n') + '\n', 'utf8');
    }

    fs.unlinkSync(req.file.path);
    res.json({ imported, skipped, invalid, total: rows.length, duplicateLog: dupLines.length ? duplicateLog : null });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// DELETE all people (reset)
app.delete('/api/people', requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM people');
  res.json({ ok: true });
});

// ---- Business Directory routes ----
// GET all businesses: any authenticated confirmed user
app.get('/api/businesses', requireConfirmed, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM businesses ORDER BY name');
  res.json(rows);
});

// GET single business by ID (admin)
app.get('/api/businesses/:id', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM businesses WHERE id = ?', [Number(req.params.id)]);
  const business = rows[0];
  if (!business) return res.status(404).json({ error: 'Business not found' });
  res.json(business);
});

// UPDATE business (admin) with optional photo upload
app.put('/api/businesses/:id', requireRole('admin'), peopleUpload.single('photo'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, business_type, city, country, owner, speciality, phone, email, facebook, instagram, tiktok } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Business name is required' });
  const [businessRows] = await pool.query('SELECT id, photo FROM businesses WHERE id = ?', [id]);
  const business = businessRows[0];
  if (!business) return res.status(404).json({ error: 'Business not found' });
  let photoPath = business.photo;
  if (req.file) {
    photoPath = 'uploads/people/' + req.file.filename;
  }
  await pool.query(`UPDATE businesses SET name=?, business_type=?, city=?, country=?, owner=?, speciality=?, phone=?, email=?, photo=?, facebook=?, instagram=?, tiktok=? WHERE id=?`, [
    name, business_type, city, country, owner, speciality, phone, email, photoPath, facebook, instagram, tiktok, id
  ]);
  res.json({ ok: true });
});

// DELETE business (admin)
app.delete('/api/businesses/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const [businessRows] = await pool.query('SELECT id FROM businesses WHERE id = ?', [id]);
  if (businessRows.length === 0) return res.status(404).json({ error: 'Business not found' });
  await pool.query('DELETE FROM businesses WHERE id = ?', [id]);
  res.json({ ok: true });
});

// DELETE all businesses (reset)
app.delete('/api/businesses', requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM businesses');
  res.json({ ok: true });
});

// POST import businesses Excel file
app.post('/api/import-businesses', requireRole('admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

    const existing = new Set();
    const seen = new Set();
    let imported = 0, skipped = 0, invalid = 0;
    const dupLines = [];

    const conn = await pool.getConnection();
    await conn.query('START TRANSACTION');
    try {
      for (const r of rows) {
        const name = r['Business name'] || r['name'];
        if (!name) { invalid++; continue; }
        const key = String(name).trim().toLowerCase() + '|' + String(r['City'] || r['city'] || '').trim().toLowerCase();
        if (seen.has(key)) {
          skipped++;
          dupLines.push(`[${new Date().toISOString()}] DUPLICATE skipped: Business="${name}", City="${r['City']||r['city']}" (file: ${req.file.originalname})`);
          continue;
        }
        await conn.query(`INSERT INTO businesses (name, business_type, city, country, owner, speciality, phone, email, photo, facebook, instagram, tiktok) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
          name,
          r['Type'] || r['business_type'] || null,
          r['City'] || r['city'] || null,
          r['Country'] || r['country'] || null,
          r['Owner'] || r['owner'] || null,
          r['Speciality'] || r['speciality'] || null,
          r['Phone'] || r['phone'] || null,
          r['email'] || r['Email'] || null,
          r['Photo'] || r['photo'] || null,
          r['Facebook'] || r['facebook'] || null,
          r['Instagram'] || r['instagram'] || null,
          r['TikTok'] || r['tiktok'] || null,
        ]);
        seen.add(key);
        imported++;
      }
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    } finally {
      conn.release();
    }

    fs.unlinkSync(req.file.path);
    res.json({ imported, skipped, invalid, total: rows.length, duplicateLog: dupLines.length ? dupLines.join('\n') : null });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// GET backup (dump SQL)
app.get('/api/backup', requireRole('admin'), async (req, res) => {
  try {
    const [tables] = await pool.query("SHOW TABLES");
    const tableNames = tables.map(t => Object.values(t)[0]);
    let sql = '-- HerWebDB MySQL Backup\n-- Generated: ' + new Date().toISOString() + '\n\n';
    for (const tableName of tableNames) {
      const [createRows] = await pool.query(`SHOW CREATE TABLE \`${tableName}\``);
      sql += createRows[0][`Create Table`] + ';\n\n';
      const [dataRows] = await pool.query(`SELECT * FROM \`${tableName}\``);
      for (const row of dataRows) {
        const cols = Object.keys(row).map(c => `\`${c}\``).join(', ');
        const vals = Object.values(row).map(v => {
          if (v === null) return 'NULL';
          if (typeof v === 'string') return "'" + v.replace(/'/g, "''") + "'";
          return String(v);
        }).join(', ');
        sql += `INSERT INTO \`${tableName}\` (${cols}) VALUES (${vals});\n`;
      }
      sql += '\n';
    }
    const tmp = path.join(config.uploadDir, `backup-${Date.now()}.sql`);
    fs.writeFileSync(tmp, sql, 'utf8');
    res.download(tmp, 'herwebdb-backup.sql', (err) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST restore (upload SQL file to replace current database)
app.post('/api/restore', requireRole('admin'), restoreUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const sqlContent = fs.readFileSync(req.file.path, 'utf8');

    // Clear all existing tables first (disable foreign key checks temporarily)
    await pool.query('SET FOREIGN_KEY_CHECKS = 0');
    const [tables] = await pool.query("SHOW TABLES");
    for (const t of tables) {
      const tableName = Object.values(t)[0];
      await pool.query(`DROP TABLE IF EXISTS \`${tableName}\``);
    }
    await pool.query('SET FOREIGN_KEY_CHECKS = 1');

    // Split by semicolons, filter out empty statements and comments
    const statements = sqlContent.split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      await pool.query(stmt);
    }

    fs.unlinkSync(req.file.path);
    // Clear session after restore (tables were recreated, old sessions are invalid)
    destroySession(pool, req, res);
    res.json({ ok: true });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// POST contact message (open to anyone) with optional CV and Photo uploads
app.post('/api/contact', contactUpload.fields([{ name: 'cv', maxCount: 1 }, { name: 'photo', maxCount: 1 }]), async (req, res) => {
  const { name, email, subject, message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' });
  const cvFile = req.files && req.files.cv ? req.files.cv[0] : null;
  const photoFile = req.files && req.files.photo ? req.files.photo[0] : null;
  const cvPath = cvFile ? 'uploads/contact/' + cvFile.filename : null;
  const photoPath = photoFile ? 'uploads/contact/' + photoFile.filename : null;
  await pool.query('INSERT INTO contact_messages (name, email, subject, message, cv_path, photo_path) VALUES (?,?,?,?,?,?)', [name||null, email||null, subject||null, String(message).trim(), cvPath, photoPath]);
  res.json({ ok: true });
});

// GET contact messages (admin inbox)
app.get('/api/contact/messages', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM contact_messages ORDER BY created_at DESC');
  res.json(rows);
});

// DELETE contact message (admin)
app.delete('/api/contact/messages/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('DELETE FROM contact_messages WHERE id = ?', [id]);
  res.json({ ok: true });
});

// ---- Password change (any authenticated user) ----
app.post('/api/change-password', requireAuth, async (req, res) => {
  const { current, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const [userRows] = await pool.query('SELECT id, password FROM users WHERE id = ?', [req.session.user.id]);
  const user = userRows[0];
  if (current && !bcrypt.compareSync(String(current), user.password)) return res.status(401).json({ error: 'Current password is incorrect' });
  const hash = bcrypt.hashSync(String(newPassword), 10);
  await pool.query('UPDATE users SET password = ?, must_change = 0 WHERE id = ?', [hash, req.session.user.id]);
  res.json({ ok: true });
});

// ---- User management (admin only) ----
app.get('/api/users', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT id, username, email, role, status, must_change, created_at FROM users ORDER BY id');
  res.json(rows);
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { username, email, password, role, status } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const r = (role === 'admin') ? 'admin' : 'viewer';
  const s = (status === 'confirmed') ? 'confirmed' : 'waiting';
  try {
    const hash = bcrypt.hashSync(String(password), 10);
    const [info] = await pool.query('INSERT INTO users (username, email, password, role, status) VALUES (?,?,?,?,?)', [String(username).trim(), email||null, hash, r, s]);
    res.json({ ok: true, id: info.insertId });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Username already exists' : e.message });
  }
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  await pool.query('DELETE FROM users WHERE id = ?', [id]);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-password', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const hash = bcrypt.hashSync(String(password), 10);
  await pool.query('UPDATE users SET password = ?, must_change = 1 WHERE id = ?', [hash, id]);
  res.json({ ok: true });
});

app.put('/api/users/:id/status', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!status || !['confirmed','waiting'].includes(status)) return res.status(400).json({ error: 'Status must be confirmed or waiting' });
  if (id === req.session.user.id && status === 'waiting') return res.status(400).json({ error: 'Cannot set yourself to waiting' });
  await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  res.json({ ok: true });
});

// Catch-all for unmatched API routes - return JSON instead of HTML
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && !res.headersSent) {
    res.status(404).json({ error: 'API endpoint not found' });
  } else {
    next();
  }
});
