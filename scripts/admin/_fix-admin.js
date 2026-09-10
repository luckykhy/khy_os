'use strict';
const bcrypt = require('bcryptjs');
const http = require('http');
const fs = require('fs');
const path = require('path');

// khyquant DB lives inside the project data home
const DB_PATH = path.join(__dirname, '..', '..', '.khy', 'khyquant', 'data', 'khy-quant.db');

function query(sql, params = []) {
  const sqlite3 = require('sqlite3').verbose();
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.all(sql, params, (err, rows) => {
      db.close();
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function main() {
  // Delete existing admin
  await query('DELETE FROM users');
  console.log('Deleted existing users');

  // Insert admin with bcrypt hash
  const hash = bcrypt.hashSync('testpass123', 10);
  await query(
    'INSERT INTO users (username, email, password, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))',
    ['qiqiaoban', 'qiqiaoban@khy-quant.com', hash, 'admin', 'active']
  );
  console.log('Inserted user with bcrypt hash');

  // Verify login
  function loginReq(username, password) {
    return new Promise((resolve) => {
      const body = JSON.stringify({ username, password });
      const port = parseInt(process.env.PORT || process.env.BACKEND_PORT || '3000', 10);
      const r = http.request('http://127.0.0.1:' + port + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d) }));
      });
      r.on('error', e => resolve({ status: 0, error: e.message }));
      r.write(body); r.end();
    });
  }

  const result = await loginReq('qiqiaoban', 'testpass123');
  console.log('Login result:', result.status, result.data?.message || result.data?.success || result.data?.token);

  // Save credentials file
  // Repo root = two levels up from scripts/admin/.
  const credsDir = path.join(__dirname, '..', '..', '.khy', 'credentials');
  try {
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(path.join(credsDir, 'default-admin.json'), JSON.stringify({ username: 'qiqiaoban', password: 'testpass123', note: 'Test admin for vision testing' }, null, 2));
    console.log('Saved credentials file');
  } catch (e) {
    console.log('Could not save creds file:', e.message);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
