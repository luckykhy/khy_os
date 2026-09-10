const fs = require('fs')
const path = require('path')

const rawPath = path.join(__dirname, '../../zcode-analysis/i18n-zh.json')
const outputPath = path.join(__dirname, '../../src/renderer/i18n/zh-CN.json')

if (!fs.existsSync(rawPath)) {
  console.error('真源文件不存在:', rawPath)
  process.exit(1)
}

const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'))

function replaceBrand(obj) {
  const result = {}
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'object' && val !== null) {
      result[key] = replaceBrand(val)
    } else if (typeof val === 'string') {
      result[key] = val
        .replace(/ZCode/g, 'KhyOS')
        .replace(/zcode\.z\.ai/g, 'khyquant.top')
        .replace(/智谱/g, 'KhyOS')
        .replace(/GLM/g, 'KhyOS')
    } else {
      result[key] = val
    }
  }
  return result
}

const replaced = replaceBrand(raw)
const outputDir = path.dirname(outputPath)
fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(replaced, null, 2))
console.log('品牌替换完成，已写入', outputPath)
console.log('总键数:', Object.keys(replaced).length)
