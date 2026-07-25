/**
 * Self-contained HTML page for the AI Web Relay.
 * Dark theme, Chinese UI, inline CSS+JS, no external dependencies.
 */
function buildRelayHTML(port, token) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>khy OS AI 中转站</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--accent:#58a6ff;--accent2:#3fb950;--red:#f85149;--yellow:#d29922;--text:#c9d1d9;--dim:#8b949e;--font:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;--mono:'Cascadia Code','Fira Code','Source Code Pro',Consolas,monospace}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;display:flex;flex-direction:column}
header{background:var(--card);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
header h1{font-size:18px;font-weight:600}
header h1 .icon{font-size:22px;margin-right:8px}
.status-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px;transition:background .3s}
.status-dot.online{background:var(--accent2)}
.status-dot.offline{background:var(--red)}
.status-label{font-size:13px;color:var(--dim)}
main{flex:1;max-width:900px;width:100%;margin:0 auto;padding:24px}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px}
.card h2{font-size:15px;font-weight:600;margin-bottom:12px;color:var(--accent)}
.card h2 .emoji{margin-right:6px}
.prompt-box{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:16px;font-family:var(--mono);font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;color:var(--text);transition:border-color .3s}
.prompt-box.highlight{border-color:var(--accent);animation:pulse .6s ease}
@keyframes pulse{0%,100%{box-shadow:none}50%{box-shadow:0 0 15px rgba(88,166,255,.3)}}
.empty{color:var(--dim);font-style:italic}
.actions{display:flex;gap:10px;margin-top:14px;align-items:center}
button{background:var(--accent);color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:14px;cursor:pointer;font-family:var(--font);transition:opacity .2s}
button:hover{opacity:.85}
button:active{opacity:.7}
button.submit{background:var(--accent2)}
button:disabled{opacity:.4;cursor:not-allowed}
.feedback{font-size:13px;color:var(--accent2);opacity:0;transition:opacity .3s}
.feedback.show{opacity:1}
.hint{font-size:13px;color:var(--dim);margin-top:10px}
textarea{width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:14px;font-family:var(--mono);font-size:14px;line-height:1.6;resize:vertical;outline:none;transition:border-color .2s}
textarea:focus{border-color:var(--accent)}
textarea::placeholder{color:var(--dim)}
.history-item{border-bottom:1px solid var(--border);padding:10px 0;font-size:13px}
.history-item:last-child{border-bottom:none}
.history-item .ts{color:var(--dim);font-size:12px}
.history-item .label{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;margin-right:6px}
.label.prompt-label{background:rgba(88,166,255,.15);color:var(--accent)}
.label.response-label{background:rgba(63,185,80,.15);color:var(--accent2)}
.history-text{font-family:var(--mono);font-size:13px;white-space:pre-wrap;margin-top:4px;max-height:100px;overflow:hidden}
footer{text-align:center;padding:12px;color:var(--dim);font-size:12px;border-top:1px solid var(--border)}
.counter{background:var(--yellow);color:#000;border-radius:10px;padding:2px 8px;font-size:12px;font-weight:600;margin-left:8px}
</style>
</head>
<body>

<header>
  <h1><span class="icon">◉</span>khy OS AI 中转站</h1>
  <div>
    <span class="status-dot offline" id="dot"></span>
    <span class="status-label" id="wsStatus">连接中...</span>
  </div>
</header>

<main>
  <section class="card" id="promptSection">
    <h2><span class="emoji">📋</span>当前待处理的提示<span class="counter" id="promptCount" style="display:none">0</span></h2>
    <div class="prompt-box empty" id="promptText">等待终端发送新的提示...</div>
    <div class="actions">
      <button id="copyBtn" disabled onclick="copyPrompt()">📋 一键复制提示</button>
      <span class="feedback" id="copyFeedback">已复制!</span>
    </div>
    <p class="hint">复制后粘贴到任意 AI 网页 — ChatGPT · Claude.ai · Gemini · 通义千问 · 文心一言 · Kimi 等</p>
  </section>

  <section class="card">
    <h2><span class="emoji">📝</span>粘贴 AI 回复</h2>
    <textarea id="responseText" placeholder="将 AI 的回复粘贴到这里..." rows="10" disabled></textarea>
    <div class="actions">
      <button class="submit" id="submitBtn" disabled onclick="submitResponse()">🚀 提交回复到终端</button>
    </div>
  </section>

  <section class="card">
    <h2><span class="emoji">📜</span>交互历史</h2>
    <div id="historyLog"><p class="empty">暂无记录</p></div>
  </section>
</main>

<footer>khy OS 平台终端 · AI 中转网关 · 端口 ${port}</footer>

<script>
(function(){
  const PORT = ${parseInt(port, 10)};
  const TOKEN = '${(token || '').replace(/'/g, "\\'")}';
  let ws = null;
  let currentId = null;
  let reconnectTimer = null;
  let totalPrompts = 0;

  const $ = id => document.getElementById(id);
  const dot = $('dot');
  const statusLabel = $('wsStatus');
  const promptBox = $('promptText');
  const copyBtn = $('copyBtn');
  const copyFeedback = $('copyFeedback');
  const responseText = $('responseText');
  const submitBtn = $('submitBtn');
  const historyLog = $('historyLog');
  const promptCount = $('promptCount');

  function connect() {
    ws = new WebSocket('ws://localhost:' + PORT + '/?token=' + encodeURIComponent(TOKEN));

    ws.onopen = function() {
      dot.className = 'status-dot online';
      statusLabel.textContent = '已连接';
      if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    };

    ws.onclose = function() {
      dot.className = 'status-dot offline';
      statusLabel.textContent = '已断开 — 重连中...';
      currentId = null;
      copyBtn.disabled = true;
      responseText.disabled = true;
      submitBtn.disabled = true;
      if (!reconnectTimer) reconnectTimer = setInterval(connect, 3000);
    };

    ws.onerror = function() { ws.close(); };

    ws.onmessage = function(evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.type === 'prompt') {
          currentId = msg.id;
          promptBox.textContent = msg.text;
          promptBox.className = 'prompt-box highlight';
          copyBtn.disabled = false;
          responseText.disabled = false;
          responseText.value = '';
          submitBtn.disabled = false;
          totalPrompts++;
          promptCount.textContent = totalPrompts;
          promptCount.style.display = 'inline';
          addHistory('prompt', msg.text);
          playBeep();
          setTimeout(function(){ promptBox.className = 'prompt-box'; }, 600);
        } else if (msg.type === 'status') {
          statusLabel.textContent = msg.message;
        } else if (msg.type === 'pong') {
          // heartbeat ok
        }
      } catch(e) { console.error('Parse error:', e); }
    };
  }

  window.copyPrompt = function() {
    if (!currentId) return;
    var text = promptBox.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showCopied).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showCopied();
    }
    function showCopied() {
      copyFeedback.className = 'feedback show';
      setTimeout(function(){ copyFeedback.className = 'feedback'; }, 2000);
    }
  };

  window.submitResponse = function() {
    if (!currentId || !ws || ws.readyState !== 1) return;
    var text = responseText.value.trim();
    if (!text) { responseText.focus(); return; }
    ws.send(JSON.stringify({ type: 'response', id: currentId, text: text }));
    addHistory('response', text);
    responseText.value = '';
    responseText.disabled = true;
    submitBtn.disabled = true;
    copyBtn.disabled = true;
    promptBox.textContent = '等待下一个提示...';
    promptBox.className = 'prompt-box empty';
    currentId = null;
    statusLabel.textContent = '已提交 ✓';
    setTimeout(function(){ statusLabel.textContent = '已连接'; }, 2000);
  };

  function addHistory(type, text) {
    if (historyLog.querySelector('.empty')) historyLog.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'history-item';
    var now = new Date().toLocaleTimeString('zh-CN');
    var label = type === 'prompt'
      ? '<span class="label prompt-label">提示</span>'
      : '<span class="label response-label">回复</span>';
    var preview = text.length > 200 ? text.substring(0, 200) + '...' : text;
    div.innerHTML = '<span class="ts">' + escapeHtml(now) + '</span> ' + label
      + '<div class="history-text">' + escapeHtml(preview) + '</div>';
    historyLog.insertBefore(div, historyLog.firstChild);
    // Limit history to 50 entries
    while (historyLog.children.length > 50) historyLog.removeChild(historyLog.lastChild);
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  var _audioCtx = null;
  function playBeep() {
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = _audioCtx.createOscillator();
      var gain = _audioCtx.createGain();
      osc.connect(gain);
      gain.connect(_audioCtx.destination);
      osc.frequency.value = 660;
      gain.gain.value = 0.1;
      osc.start();
      osc.stop(_audioCtx.currentTime + 0.15);
    } catch(e) { /* audio not supported */ }
  }

  // Heartbeat
  setInterval(function(){
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);

  connect();
})();
</script>
</body>
</html>`;
}

module.exports = { buildRelayHTML };
