const fs = require('fs');
const path = require('path');

function findStandaloneTestFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findStandaloneTestFiles(full));
    } else if (entry.name.endsWith('.test.js')) {
      const src = fs.readFileSync(full, 'utf8');
      const JEST_REGISTER_RE = /(?:describe|test|it)\s*\.\s*each\s*\(|\b(?:describe|test|it)\s*\(\s*['"`]/;
      const NODE_TEST_RE = /require\s*\(\s*['"]node:test['"]\s*\)|from\s*['"]node:test['"]/;
      if (!JEST_REGISTER_RE.test(src) && !NODE_TEST_RE.test(src)) {
        found.push(full);
      }
    }
  }
  return found;
}

const existingRoots = ['tests', 'src'].map(r => path.join('services/backend', r)).filter(p => fs.existsSync(p));
const ignored = existingRoots.flatMap(findStandaloneTestFiles);
console.log('Ignored files:', ignored.length);
ignored.slice(0, 20).forEach(f => console.log(f));
