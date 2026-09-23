// Round 3: extract the automations i18n segment with proper UTF-8 decoding
const fs = require('fs')

const ASAR = 'C:/Program Files/ZCode/resources/app.asar'
const buf = fs.readFileSync(ASAR)
const lat = buf.toString('latin1')

// Anchor on a rare key, then decode a generous byte window as UTF-8 so the
// Chinese values survive (unlike the latin1 sanitizer pass).
const anchors = ['automations.breadcrumbLabel', 'automations.runNow', 'automations.createManually']
const seen = new Set()
for (const anchor of anchors) {
  let idx = lat.indexOf(anchor)
  while (idx !== -1) {
    const start = Math.max(0, idx - 3000)
    const end = Math.min(buf.length, idx + 12000)
    const text = buf.slice(start, end).toString('utf8')
    // Pull every "automations.*"/"settings.automations.*" key with its value
    const re = /"(automations\.[A-Za-z0-9_.]+|settings\.automations\.[A-Za-z0-9_.]+)":\s*`([^`]*)`/g
    let m
    while ((m = re.exec(text)) !== null) {
      const k = m[1]
      if (!seen.has(k)) {
        seen.add(k)
        console.log(k + ' = ' + m[2].replace(/\s+/g, ' ').trim())
      }
    }
    idx = lat.indexOf(anchor, idx + anchor.length)
    if (seen.size > 120) break
  }
}
console.log('---- total keys:', seen.size)
