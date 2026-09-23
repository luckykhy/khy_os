// Round 2: context around ZCode's own "Automations" UI strings + schedule labels
const fs = require('fs')

const ASAR = 'C:/Program Files/ZCode/resources/app.asar'
const lat = fs.readFileSync(ASAR).toString('latin1')

function show(needle, label, max = 10, before = 100, after = 200) {
  console.log(`==== ${label || needle} ====`)
  let idx = 0
  let shown = 0
  while ((idx = lat.indexOf(needle, idx)) !== -1 && shown < max) {
    const start = Math.max(0, idx - before)
    const end = Math.min(lat.length, idx + after)
    const ctx = lat
      .slice(start, end)
      .replace(/[^\x20-\x7E\u4E00-\u9FFF\u3000-\u303F，。：；！？（）、「」·—…]/g, ' ')
      .replace(/\s+/g, ' ')
    console.log('--\n' + ctx)
    shown++
    idx += needle.length
  }
  if (shown === 0) console.log('(none)')
}

show('"Automations"', 'quoted Automations', 8)
show("'Automations'", 'single-quoted Automations', 8)
show('automations.', 'automations. key paths', 12)
show('New automation', 'New automation', 6)
show('Run now', 'Run now', 6)
show(Buffer.from('立即运行', 'utf8').toString('latin1'), '立即运行', 6)
show(Buffer.from('新建自动化', 'utf8').toString('latin1'), '新建自动化', 6)
show(Buffer.from('每天', 'utf8').toString('latin1'), '每天(schedule)', 8)
show(Buffer.from('小时', 'utf8').toString('latin1'), '小时', 6)
