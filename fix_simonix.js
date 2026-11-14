const Database = require('better-sqlite3');
const db = new Database('data/herwebdb.sqlite');
db.prepare("UPDATE users SET status = 'confirmed' WHERE username = 'simonix'").run();
const user = db.prepare('SELECT id, username, status FROM users WHERE username = ?').get('simonix');
console.log('simonix now:', JSON.stringify(user));
db.close();
