const fs = require('fs');
const path = require('path');
// Repo root = two levels up from scripts/admin/.
const p = path.join(__dirname, '..', '..', '.khy', 'credentials', 'default-admin.json');
try {
  const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
  console.log('user:', d.username);
  console.log('pass:', d.password);
} catch(e) {
  console.log('Error:', e.message);
}
