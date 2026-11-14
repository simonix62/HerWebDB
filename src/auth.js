const crypto = require('node:crypto');

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(cookie => {
    const eqIdx = cookie.indexOf('=');
    if (eqIdx > 0) {
      const name = cookie.substring(0, eqIdx).trim();
      const value = cookie.substring(eqIdx + 1).trim();
      cookies[name] = value;
    }
  });
  return cookies;
}

// Load session from MySQL into req.session
function loadSession(pool) {
  return (req, res, next) => {
    const cookies = parseCookies(req);
    const sid = cookies.connect_sid;
    if (sid) {
      pool.query('SELECT sess, expire FROM sessions WHERE sid = ?', [sid])
        .then(([results]) => {
          if (!results || results.length === 0) {
            req.session = null;
            return next();
          }
          const row = results[0];
          if (row.expire < Date.now()) {
            return pool.query('DELETE FROM sessions WHERE sid = ?', [sid])
              .then(() => {
                req.session = null;
                next();
              });
          }
          try {
            req.session = JSON.parse(row.sess);
            req.sessionID = sid;
          } catch (e) {
            req.session = null;
          }
          next();
        })
        .catch(err => {
          req.session = null;
          next();
        });
    } else {
      req.session = null;
      next();
    }
  };
}

// Save session to MySQL and set cookie on response
async function saveSession(pool, req, res) {
  if (!req.session) return;
  const sid = req.sessionID || crypto.randomBytes(24).toString('hex');
  const expire = Date.now() + 86400000; // 7 days
  await pool.query(
    'INSERT INTO sessions (sid, sess, expire) VALUES (?,?,?) ON DUPLICATE KEY UPDATE sess=VALUES(sess), expire=VALUES(expire)',
    [sid, JSON.stringify(req.session), expire]
  );
  req.sessionID = sid;
  res.setHeader('Set-Cookie', `connect_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expire - Date.now()) / 1000)}`);
}

async function destroySession(pool, req, res) {
  if (req.sessionID) {
    await pool.query('DELETE FROM sessions WHERE sid = ?', [req.sessionID]).catch(() => {});
  }
  res.setHeader('Set-Cookie', 'connect_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  req.session = null;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Authentication required' });
}

function requireConfirmed(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.session.user.status !== 'confirmed') return res.status(403).json({ error: 'Account not confirmed by administrator' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.session.user.role !== role && req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

module.exports = { loadSession, saveSession, destroySession, requireAuth, requireRole, requireConfirmed };
