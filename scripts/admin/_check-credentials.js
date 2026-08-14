const fs = require('fs');
const p = 'D:\\Portable\\khy-os\\.khy\\credentials\\default-admin.json';
try {
  const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
  console.log('user:', d.username);
  console.log('pass:', d.password);
} catch(e) {
  console.log('Error:', e.message);
}
