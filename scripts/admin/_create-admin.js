'use strict';
/**
 * Directly create admin user using the User model to ensure correct bcrypt hash.
 */
const path = require('path');

// Resolve paths from this script's location (scripts/admin/ -> repo root -> backend)
const repoRoot = path.resolve(__dirname, '..', '..');
const backendDir = path.join(repoRoot, 'services', 'backend');
const dbPath = path.join(repoRoot, '.khy', 'khyquant', 'data', 'khy-quant.db');

// Ensure we're in the backend directory
process.chdir(backendDir);

// Set up required env vars
process.env.NODE_ENV = 'development';
process.env.IDLE_SHUTDOWN = 'false';

// The SQLite database path (inside the project data home)
process.env.DB_PATH = dbPath;

async function main() {
  // Delete existing user
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database(dbPath);
  db.run('DELETE FROM users');
  console.log('Deleted all users');

  // Now create user via the User model (which uses bcryptjs)
  const { Sequelize } = require('sequelize');

  // We need to use the same sequelize instance as the app
  // Let's use the direct model module
  const User = require('D:/Portable/khy-os/platform/packages/shared/src/models/User');

  // Check if User has sequelize configured
  console.log('User model loaded');

  // Alternative: just use bcryptjs directly
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('testpass123', 10);
  console.log('bcryptjs hash:', hash);

  // Insert with bcryptjs hash
  db.run(
    'INSERT INTO users (username, email, password, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))',
    ['qiqiaoban', 'qiqiaoban@khy-quant.com', hash, 'admin', 'active'],
    function(err) {
      if (err) { console.error('Insert error:', err); process.exit(1); }
      console.log('Inserted user with id:', this.lastID);

      // Verify
      db.get('SELECT * FROM users WHERE username = ?', ['qiqiaoban'], (err, row) => {
        if (err) { console.error('Query error:', err); }
        else {
          console.log('Stored user:', { id: row.id, username: row.username, pwLen: row.password.length, pwPrefix: row.password.substring(0, 4) });
          console.log('Compare testpass123:', bcrypt.compareSync('testpass123', row.password));
        }
        db.close();
      });
    }
  );
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
