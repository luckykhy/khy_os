// tickCsvParser.test.js — 锁 src/utils/tickCsvParser.js 的 CSV→K线解析口径
// 覆盖：分隔符探测、表头别名映射、时间戳多格式、聚合分桶、异常输入
import { describe, it, expect } from 'vitest'
import { parseTickCsvToKline } from '@/utils/tickCsvParser'

// 20 根日线所需的合成 CSV（tick 级时间戳取 13 位毫秒）
function makeCsv(rows) {
  const ts = (day) => `${1700000000000 + day * 86400000}`
  return [
    'timestamp,close,volume',
    ...rows.map((day, i) => `${ts(day)},${100 + i},5000`)
  ].join('\n')
}

describe('parseTickCsvToKline 异常输入', () => {
  it('空内容抛出明确错误', () => {
    expect(() => parseTickCsvToKline('')).toThrow('Tick CSV content is empty')
    expect(() => parseTickCsvToKline('   ')).toThrow('Tick CSV content is empty')
    expect(() => parseTickCsvToKline(null)).toThrow('Tick CSV content is empty')
  })

  it('只有表头没有数据行时抛出错误', () => {
    expect(() => parseTickCsvToKline('timestamp,close')).toThrow(
      'Tick CSV must include header and data rows'
    )
  })

  it('有效行数不足 minRows 时抛出数量错误', () => {
    const csv = makeCsv([0, 1, 2])
    expect(() => parseTickCsvToKline(csv, { minRows: 20 })).toThrow(
      /insufficient valid rows \(3\), need at least 20/
    )
  })
})

describe('parseTickCsvToKline 正常解析', () => {
  it('解析 20 行 CSV，输出 meta 与时间升序的 K 线', () => {
    const rows = Array.from({ length: 20 }, (_, i) => i)
    const { data, meta } = parseTickCsvToKline(makeCsv(rows))
    expect(meta.sourceRows).toBe(20)
    expect(meta.parsedRows).toBe(20)
    expect(meta.outputRows).toBe(20)
    expect(meta.invalidRows).toBe(0)
    expect(meta.delimiter).toBe(',')
    expect(meta.aggregation).toBe('tick')

    // tick 模式下每根 K 线来自单点：时间戳取整到秒
    expect(data[0].timestamp).toBe(1700000000)
    expect(data[19].timestamp).toBe(1700000000 + 19 * 86400)
    for (let i = 1; i < data.length; i++) {
      expect(data[i].timestamp).toBeGreaterThan(data[i - 1].timestamp)
    }
    expect(data[0].close).toBe(100)
    expect(data[0].volume).toBe(5000)
    // startTime/endTime 为 ISO 字符串
    expect(meta.startTime).toBe(new Date(1700000000000).toISOString())
  })

  it('支持中文表头别名（交易时间/最新价/成交量）并识别分隔符', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      `2023-11-15 10:0${i % 10}:00|${10 + i},200`.replace(',', '|')
    )
    const csv = ['交易时间|最新价|成交量', ...rows].join('\n')
    const { data, meta } = parseTickCsvToKline(csv)
    expect(meta.delimiter).toBe('|')
    expect(meta.parsedRows).toBe(20)
    expect(data[0].close).toBe(10)
    expect(data[0].volume).toBe(200)
    // 日期时间均为 2023-11-15 10:00-10:09（本地时区解析）
    const t0 = new Date(data[0].timestamp * 1000)
    expect(`${t0.getFullYear()}-${t0.getMonth() + 1}-${t0.getDate()}`).toBe('2023-11-15')
  })

  it('分号与制表符分隔符自动探测', () => {
    const semi = ['timestamp;close', ...Array.from({ length: 20 }, (_, i) => `2024-01-0${i + 1},100`).map(r => r.replace(',', ';'))].join('\n')
    expect(parseTickCsvToKline(semi).meta.delimiter).toBe(';')

    const tab = ['datetime\tclose', ...Array.from({ length: 20 }, (_, i) => `1700000000000\t${100 + i}`)].join('\n')
    expect(parseTickCsvToKline(tab).meta.delimiter).toBe('\t')
  })

  it('13 位毫秒与 10 位秒时间戳均可解析', () => {
    const ms = ['timestamp,close', ...Array.from({ length: 20 }, (_, i) => `${1700000000000 + i},100`)].join('\n')
    expect(parseTickCsvToKline(ms).data[0].timestamp).toBe(1700000000)

    const sec = ['timestamp,close', ...Array.from({ length: 20 }, (_, i) => `${1700000000 + i * 60},100`)].join('\n')
    expect(parseTickCsvToKline(sec).data[19].timestamp).toBe(1700000000 + 19 * 60)
  })

  it('紧凑日期时间（yyyyMMdd 间隔时间）可解析为本地时间', () => {
    // 值含空格 → 走 compact 14 位数字分支（纯数字会先命中毫秒分支）
    const compact = ['timestamp,close', ...Array.from({ length: 20 }, (_, i) =>
      `20240615 ${String(10 + i).padStart(2, '0')}:30:00,100`)].join('\n')
    const { data } = parseTickCsvToKline(compact)
    const t0 = new Date(data[0].timestamp * 1000)
    expect([t0.getFullYear(), t0.getMonth() + 1, t0.getDate(), t0.getHours()]).toEqual([2024, 6, 15, 10])
  })

  it('无效行（无价格/坏时间戳）计入 invalidRows 并跳过', () => {
    const base = 1700000000000
    const lines = [
      'timestamp,close',
      'garbage,100',                        // 坏时间戳
      `${base},abc`,                        // 坏价格
      `${base + 60},100`
    ]
    const csv = lines.concat(
      Array.from({ length: 19 }, (_, i) => `${base + (i + 1) * 60000},100`)
    ).join('\n')
    const { data, meta } = parseTickCsvToKline(csv)
    expect(meta.invalidRows).toBe(2)
    expect(meta.parsedRows).toBe(20)
    expect(data.length).toBe(20)
  })
})

describe('聚合（aggregation）', () => {
  it('1m 聚合把同分钟 tick 合并：high 取最大、close 取最后、volume 累加', () => {
    const base = 1700000000000
    const lines = ['timestamp,open,high,low,close,volume',
      `${base},10,11,9,10.5,100`,
      `${base + 15000},10.5,12,9.5,11,200`,   // 同 1 分钟桶
      `${base + 90000},11,12,10,11.5,50`     // 下一分钟桶
    ]
    const csv = lines.concat(
      Array.from({ length: 17 }, (_, i) => `${base + (i + 2) * 60000},${10 + i / 10}`)
    ).join('\n')
    const { data, meta } = parseTickCsvToKline(csv, { aggregation: '1m', minRows: 1 })
    expect(meta.aggregation).toBe('60s')
    expect(meta.outputRows).toBe(19)
    const first = data[0]
    expect(first.timestamp).toBe(Math.floor(base / 60000) * 60)
    expect(first.high).toBe(12)
    expect(first.low).toBe(9)
    expect(first.close).toBe(11)
    expect(first.volume).toBe(300)
  })

  it('tick/未知聚合都按逐点输出', () => {
    const base = 1700000000000
    const csv = ['timestamp,close', ...Array.from({ length: 20 }, (_, i) => `${base + i * 60000},100`)].join('\n')
    expect(parseTickCsvToKline(csv, { aggregation: 'weird' }).meta.aggregation).toBe('tick')
    expect(parseTickCsvToKline(csv, { aggregation: 'tick' }).meta.outputRows).toBe(20)
  })

  it('5m 聚合把 5 分钟内 tick 合成一根 K 线', () => {
    // 桶边界对齐：base 为 300000ms 的整数倍；1 分钟间隔的 tick → 每 5 根合成 1 桶
    const base = 5666667 * 300000
    const csv = ['timestamp,close', ...Array.from({ length: 24 }, (_, i) => `${base + i * 60000},10`)].join('\n')
    const { data, meta } = parseTickCsvToKline(csv, { aggregation: '5m', minRows: 1 })
    expect(meta.outputRows).toBe(5)
    expect(data[0].timestamp).toBe(Math.floor(base / 300000) * 300)
  })
})
