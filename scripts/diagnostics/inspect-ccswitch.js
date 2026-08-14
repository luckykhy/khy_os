const db = require('better-sqlite3')('C:/Users/25789/.cc-switch/cc-switch.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', JSON.stringify(tables));
for (const t of tables) {
  console.log('\n=== Table:', t.name, '===');
  const cols = db.prepare('PRAGMA table_info("' + t.name + '")').all();
  cols.forEach(c => console.log('  col:', c.name, '-', c.type));
  const rows = db.prepare('SELECT * FROM "' + t.name + '" LIMIT 2').all();
  console.log(JSON.stringify(rows, null, 2));
}
