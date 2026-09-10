const fs = require('fs');
const file = process.argv[2];
const pattern = process.argv[3];
const contextLines = parseInt(process.argv[4] || '5');

const data = fs.readFileSync(file, 'utf8');
const lines = data.split('\n');
const regex = new RegExp(pattern, 'i');

let count = 0;
for (let i = 0; i < lines.length; i++) {
  if (regex.test(lines[i])) {
    const start = Math.max(0, i - contextLines);
    const end = Math.min(lines.length - 1, i + contextLines);
    console.log(`\n=== MATCH ${++count} at line ${i + 1} ===`);
    for (let j = start; j <= end; j++) {
      const marker = j === i ? '>>>' : '   ';
      console.log(`${marker} L${j + 1}: ${lines[j].substring(0, 300)}`);
    }
    if (count >= 20) break;
  }
}
console.log(`\n--- Total matches: ${count} ---`);
