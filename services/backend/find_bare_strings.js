'use strict';

const fs = require('fs');
const code = fs.readFileSync('D:/Portable/khy-os/services/backend/src/cli/tui/ink-components/App.js', 'utf8');
const lines = code.split('\n');

console.log('=== Looking for Box with bare string children ===\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('h(Box') || lines[i].includes('h(Box,')) {
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const trimmed = lines[j].trim();
      if (trimmed.startsWith('h(Text') || trimmed.startsWith('h(Box') ||
          trimmed.startsWith('//') || trimmed === '' ||
          trimmed.startsWith('}') || trimmed.startsWith(')') ||
          trimmed.startsWith(':') || trimmed.startsWith('?')) {
        continue;
      }
      // Check for string literal (single or double quoted)
      const singleQ = trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 2;
      const doubleQ = trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2;
      const backtick = trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length > 2;
      if (singleQ || doubleQ || backtick) {
        console.log(`Line ${i + 1}: ${lines[i].trim().substring(0, 70)}`);
        console.log(`  -> Line ${j + 1}: ${trimmed}`);
      }
      break;
    }
  }
}
