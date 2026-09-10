// Show i18n keys under one or more prefixes.
// Usage: node show-group.cjs <groups.tsv> prefix1 prefix2 ...
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
const prefixes = process.argv.slice(3);
let shown = 0;
for (const line of lines) {
  if (!line) continue;
  const tab = line.indexOf('\t');
  const key = tab >= 0 ? line.slice(0, tab) : line;
  if (prefixes.some((p) => key === p || key.startsWith(p + '.'))) {
    console.log(line);
    shown++;
  }
}
process.stderr.write(`--- ${shown} keys shown ---\n`);
