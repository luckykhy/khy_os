// One-off: require every route module to surface load-time crashes fast.
const fs = require('fs')
const path = require('path')
const routesDir = path.join(__dirname, '..', 'src', 'routes')
const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js')).sort()
const failures = []
for (const f of files) {
  try {
    require(path.join(routesDir, f))
  } catch (e) {
    failures.push({ file: f, message: e.message.split('\n')[0] })
  }
}
if (failures.length === 0) {
  console.log(`ALL-ROUTES-LOAD-OK (${files.length} modules)`)
} else {
  for (const f of failures) console.log(`FAIL ${f.file}: ${f.message}`)
  console.log(`FAILURES: ${failures.length}/${files.length}`)
}
