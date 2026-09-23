// scheduler 进程：定时任务、闲时算力（092 Phase 0d 四进程架构的第四位）。
//
// 由 main fork 拉起（startSchedulerProcess），经 IPC 与 main 通信：
//   ← { type: 'ping' }      → { type: 'pong', pid, uptimeMs }
//   ← { type: 'shutdown' }  → 优雅退出
// 自动化调度当前由 main 侧的 tick 驱动（automationStore 在 main），本进程负责
// 常驻存活、心跳与后续闲时算力任务的宿主；业务编排见 Phase 10。
//
// 必须常驻：早前版本只打印一行就结束，导致「四进程」实际只有三位在跑。
// 这里显式挂住事件循环（IPC 监听 + 30s 心跳），并如实上报存活。

const startedAt = Date.now()

function uptimeMs(): number {
  return Date.now() - startedAt
}

function send(msg: unknown): void {
  if (process.send) process.send(msg)
}

console.log('[scheduler] 进程启动, pid:', process.pid)
send({ type: 'ready', pid: process.pid })

process.on('message', (msg: unknown) => {
  const m = msg as { type?: string } | null
  if (!m || typeof m !== 'object') return
  if (m.type === 'ping') {
    send({ type: 'pong', pid: process.pid, uptimeMs: uptimeMs() })
    return
  }
  if (m.type === 'shutdown') {
    console.log('[scheduler] 收到 shutdown，准备退出')
    process.exit(0)
  }
})

// 心跳：每 30s 上报一次存活（纯状态上报，非任务截止 —— 规则 3 无涉）。
// ref'd interval 同时保证事件循环不空转退出。
const heartbeat = setInterval(() => {
  send({ type: 'heartbeat', pid: process.pid, uptimeMs: uptimeMs() })
}, 30_000)

// main 断开 IPC（应用退出）时自行退出，避免留下孤儿进程
process.on('disconnect', () => {
  clearInterval(heartbeat)
  console.log('[scheduler] IPC 断开，退出')
  process.exit(0)
})
