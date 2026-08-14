const fs = require('fs');
const path = require('path');

// Find and delete stale credentials file
const dir = path.join('D:', 'Portable', 'khy-os', '.khy', 'credentials');
const file = path.join(dir, 'default-admin.json');
console.log('Checking:', file);
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf-8');
  console.log('Found credentials file:', content);
  fs.unlinkSync(file);
  console.log('Deleted stale credentials file');
} else {
  console.log('Credentials file does not exist');
  // List dir contents
  try {
    const files = fs.readdirSync(dir);
    console.log('Dir contents:', files);
  } catch(e) {
    console.log('Cannot read dir:', e.message);
  }
}
