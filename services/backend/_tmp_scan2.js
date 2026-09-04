const fs = require('fs');
const path = require('path');

// Search ALL JS files for require('domain/ without ./
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
        // Look for require('domain/ or require("domain/ (without ./)
        const hasBadRequire = content.includes("require('domain/") || 
                               content.includes('require("domain/');
        if (hasBadRequire) {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const hasBadLine = (lines[i].includes("require('domain/") || lines[i].includes('require("domain/')) && 
                               !lines[i].includes('./domain');
            if (hasBadLine) {
              results.push({ file: full, line: i+1, text: lines[i].trim() });
            }
          }
        }
      }
    }
  } catch {}
};

searchDir('./src');
console.log('Bad requires (without ./):');
results.forEach(r => console.log('  ' + r.file + ':' + r.line + '  ' + r.text));
if (results.length === 0) console.log('  None found');
