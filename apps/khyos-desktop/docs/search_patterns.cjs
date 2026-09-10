const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const pattern = process.argv[3];
const maxResults = parseInt(process.argv[4] || '50');

const data = fs.readFileSync(file, 'utf8');
const lines = data.split('\n');
const regex = new RegExp(pattern, 'i');

let count = 0;
for (let i = 0; i < lines.length; i++) {
  if (regex.test(lines[i])) {
    console.log(`L${i + 1}: ${lines[i].substring(0, 250)}`);
    count++;
    if (count >= maxResults) break;
  }
}
console.log(`\n--- Total matches: ${count} ---`);
