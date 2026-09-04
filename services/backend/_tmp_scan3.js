const fs = require('fs');
const path = require('path');

// Find all top-level requires of domain/ without ./
const results = [];
const searchDir = (dir, depth = 0) => {
  if (depth > 6) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.') && entry.name !== 'dist') {
          searchDir(full, depth + 1);
        }
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs') || entry.name.endsWith('.mjs')) {
        const content = fs.readFileSync(full, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          // Check for require('domain/ at the start of a line (top-level)
          if (line.startsWith("require('domain/") || line.startsWith('require("domain/')) {
            if (!line.includes('./domain') && !line.includes('domain/desktop/browser/engine')) {
              results.push({ file: full, line: i+1, text: line });
            }
          }
        }
      }
    }
  } catch {}
};

searchDir('./src');
console.log('Top-level requires of domain/ without ./:');
results.forEach(r => console.log('  ' + r.file + ':' + r.line + '  ' + r.text));
if (results.length === 0) console.log('  None found');
