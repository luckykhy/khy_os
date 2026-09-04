const fs = require('fs');
const path = require('path');

// Search for the exact problematic require pattern (without ./)
const searchDir = (dir, depth = 0) => {
  if (depth > 5) return;
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
        // Look for require without ./
        const hasBadRequire = content.includes("require('domain/desktop/browser/engine") || 
                               content.includes('require("domain/desktop/browser/engine');
        if (hasBadRequire) {
          console.log('FOUND problematic require in:', full);
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('domain/desktop/browser/engine') && !lines[i].includes('./domain')) {
              console.log('  Line ' + (i+1) + ':', lines[i].trim());
            }
          }
        }
      }
    }
  } catch {}
};

searchDir('./src');
console.log('Search complete');
