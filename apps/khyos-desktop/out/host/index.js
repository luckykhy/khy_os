console.log("[host] 进程启动, pid:", process.pid);
process.stdin.on("data", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    console.log("[host] 收到消息:", msg);
  } catch (e) {
  }
});
process.stdout.write(JSON.stringify({ type: "ready", pid: process.pid }) + "\n");
