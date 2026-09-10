// host 进程：Agent 运行时适配
// Phase 0c 只做进程启动，通过 stdin/stdout 与主进程通信

console.log('[host] 进程启动, pid:', process.pid)

process.stdin.on('data', (data) => {
  try {
    const msg = JSON.parse(data.toString())
    console.log('[host] 收到消息:', msg)
  } catch (e) {
    // ignore
  }
})

process.stdout.write(JSON.stringify({ type: 'ready', pid: process.pid }) + '\n')
