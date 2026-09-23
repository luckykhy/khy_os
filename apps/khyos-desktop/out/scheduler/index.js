const startedAt = Date.now();
function uptimeMs() {
  return Date.now() - startedAt;
}
function send(msg) {
  if (process.send) process.send(msg);
}
console.log("[scheduler] 进程启动, pid:", process.pid);
send({ type: "ready", pid: process.pid });
process.on("message", (msg) => {
  const m = msg;
  if (!m || typeof m !== "object") return;
  if (m.type === "ping") {
    send({ type: "pong", pid: process.pid, uptimeMs: uptimeMs() });
    return;
  }
  if (m.type === "shutdown") {
    console.log("[scheduler] 收到 shutdown，准备退出");
    process.exit(0);
  }
});
const heartbeat = setInterval(() => {
  send({ type: "heartbeat", pid: process.pid, uptimeMs: uptimeMs() });
}, 3e4);
process.on("disconnect", () => {
  clearInterval(heartbeat);
  console.log("[scheduler] IPC 断开，退出");
  process.exit(0);
});
