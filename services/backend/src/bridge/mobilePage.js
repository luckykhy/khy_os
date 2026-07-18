/**
 * KHY Remote — collaborative control page for phones and desktops.
 * Dark theme, Chinese UI, inline CSS+JS, no external dependencies.
 *
 * Key design decisions:
 * - Responsive: auto-detects phone vs desktop, renders different layouts
 * - Login/register screen with username+password (Chinese UI)
 * - WS connects to location.host (not hardcoded port) — works behind nginx
 * - ws/wss auto-detected from page protocol — works with HTTPS nginx
 * - visualViewport API for iOS keyboard-aware layout
 * - Safe area insets for notched phones
 * - Desktop: wider layout, keyboard shortcuts, session info sidebar
 */
'use strict';

function buildMobileHTML(port) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0d1117">
<meta name="format-detection" content="telephone=no">
<title>KHY Remote \u2014 \u534F\u4F5C\u63A7\u5236\u53F0</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0d1117;--card:#161b22;--border:#30363d;
  --accent:#58a6ff;--accent2:#3fb950;--red:#f85149;--yellow:#d29922;
  --text:#c9d1d9;--dim:#8b949e;--thinking:#484f58;
  --font:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Segoe UI',sans-serif;
  --mono:'SF Mono','Menlo','Cascadia Code','Fira Code',Consolas,monospace;
  --safe-top:env(safe-area-inset-top,0px);
  --safe-bottom:env(safe-area-inset-bottom,0px);
  --safe-left:env(safe-area-inset-left,0px);
  --safe-right:env(safe-area-inset-right,0px);
  --kb-height:0px;
}
html{height:100%;background:var(--bg)}
body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font);overflow:hidden;
  padding-top:var(--safe-top);padding-left:var(--safe-left);padding-right:var(--safe-right)}

/* ── Login Screen ── */
.login-screen{
  position:fixed;top:0;left:0;right:0;bottom:0;z-index:100;
  background:var(--bg);display:flex;align-items:center;justify-content:center;
  padding:20px;
}
.login-card{
  background:var(--card);border:1px solid var(--border);border-radius:16px;
  padding:32px 28px;width:100%;max-width:360px;text-align:center;
}
.login-card .logo{font-size:36px;margin-bottom:8px;display:block}
.login-card h2{font-size:20px;font-weight:600;margin-bottom:4px;color:var(--text)}
.login-card .subtitle{font-size:13px;color:var(--dim);margin-bottom:20px}
/* Tabs */
.auth-tabs{display:flex;margin-bottom:20px;border-bottom:1px solid var(--border)}
.auth-tab{flex:1;padding:10px;font-size:14px;font-weight:600;color:var(--dim);
  background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;
  transition:color .2s,border-color .2s}
.auth-tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.auth-tab:active{opacity:.7}
/* Form */
.auth-form{display:none}
.auth-form.active{display:block}
.login-card label{display:block;text-align:left;font-size:13px;color:var(--dim);margin-bottom:5px;margin-top:12px}
.login-card label:first-child{margin-top:0}
.auth-input{
  width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);
  border-radius:10px;padding:12px 14px;font-family:var(--font);font-size:16px;
  outline:none;transition:border-color .2s;
}
.auth-input:focus{border-color:var(--accent)}
.auth-input::placeholder{color:var(--thinking)}
.login-btn{
  width:100%;margin-top:18px;padding:14px;background:var(--accent);color:#fff;
  border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;
  min-height:48px;transition:opacity .15s;
}
.login-btn:active{opacity:.7}
.login-btn:disabled{background:var(--border);opacity:.5;cursor:not-allowed}
.login-error{
  margin-top:12px;font-size:13px;color:var(--red);min-height:18px;
  transition:opacity .2s;
}
.auth-switch{margin-top:16px;font-size:12px;color:var(--dim)}
.auth-switch a{color:var(--accent);cursor:pointer;text-decoration:none}
.auth-switch a:active{opacity:.7}
.pin-link{margin-top:14px;font-size:11px;color:var(--thinking);cursor:pointer}
.pin-link:active{opacity:.7}
/* PIN form (hidden by default) */
.pin-form{display:none}
.pin-form.active{display:block}
.pin-input{
  width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);
  border-radius:10px;padding:14px;font-family:var(--mono);font-size:24px;
  text-align:center;letter-spacing:8px;outline:none;transition:border-color .2s;
  -moz-appearance:textfield;
}
.pin-input::-webkit-outer-spin-button,.pin-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.pin-input:focus{border-color:var(--accent)}
.pin-input::placeholder{letter-spacing:2px;font-size:16px}

/* ── App (hidden until login) ── */
#app{display:none;flex-direction:column;height:100%;max-height:100%}
#app.visible{display:flex}

/* ── Header ── */
.header{
  background:var(--card);border-bottom:1px solid var(--border);
  padding:10px 16px;display:flex;align-items:center;justify-content:space-between;
  flex-shrink:0;min-height:44px;
}
.header h1{font-size:16px;font-weight:600;white-space:nowrap}
.header-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;transition:background .3s}
.dot.on{background:var(--accent2)}.dot.off{background:var(--red)}.dot.warn{background:var(--yellow)}
.conn-text{font-size:12px;color:var(--dim);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.online-count{font-size:10px;background:var(--accent);color:#fff;border-radius:8px;padding:1px 7px;white-space:nowrap;display:none}
.online-count.show{display:inline-block}
.client-badge{font-size:10px;background:var(--accent);color:#fff;border-radius:8px;padding:1px 6px;margin-left:4px}
.logout-btn{background:none;border:1px solid var(--border);color:var(--dim);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer}
.logout-btn:active{opacity:.7}

/* ── Transcript ── */
.transcript{
  flex:1;overflow-y:auto;padding:12px 14px;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;
  scroll-behavior:auto;
}
.msg{margin-bottom:10px;max-width:90%;animation:fadeIn .15s ease;word-break:break-word;-webkit-user-select:text;user-select:text;position:relative}
@keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
/* User message */
.msg.user{
  margin-left:auto;
  background:rgba(88,166,255,.12);border:1px solid rgba(88,166,255,.25);
  border-radius:14px 14px 4px 14px;padding:8px 14px;font-size:14px;line-height:1.5;
}
/* AI message */
.msg.ai{
  background:var(--card);border:1px solid var(--border);
  border-radius:14px 14px 14px 4px;padding:10px 14px;font-size:14px;line-height:1.65;
}
.msg.ai pre{
  background:var(--bg);border:1px solid var(--border);border-radius:6px;
  padding:10px 12px;overflow-x:auto;-webkit-overflow-scrolling:touch;
  font-family:var(--mono);font-size:12px;margin:8px 0;
  white-space:pre-wrap;word-break:break-all;line-height:1.5;
}
.msg.ai code{
  background:rgba(110,118,129,.25);padding:1px 5px;border-radius:3px;
  font-family:var(--mono);font-size:12px;
}
.msg.ai pre code{background:none;padding:0}
.msg.ai h3,.msg.ai h4{font-size:14px;font-weight:600;margin:10px 0 4px;color:var(--accent)}
.msg.ai strong{color:#e6edf3}
.msg.ai ul,.msg.ai ol{padding-left:18px;margin:4px 0}
.msg.ai li{margin-bottom:2px}

/* ── Thinking ── */
.thinking{
  background:rgba(72,79,88,.12);border-left:3px solid var(--thinking);
  border-radius:0 8px 8px 0;padding:8px 12px;margin-bottom:8px;
  font-size:13px;color:var(--dim);line-height:1.5;
}
.thinking summary{cursor:pointer;font-style:italic;font-size:12px;color:var(--thinking);user-select:none;padding:2px 0}
.thinking .think-content{margin-top:6px;white-space:pre-wrap;word-break:break-word}

/* ── Tool card ── */
.tool-card{background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden}
.tool-header{
  padding:8px 12px;background:rgba(88,166,255,.06);
  border-bottom:1px solid var(--border);font-size:12px;font-weight:600;color:var(--accent);
  cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none;
  min-height:36px;
}
.tool-header .arrow{transition:transform .2s;font-size:10px}
.tool-header .arrow.open{transform:rotate(90deg)}
.tool-body{
  padding:8px 12px;font-family:var(--mono);font-size:11px;
  white-space:pre-wrap;word-break:break-all;max-height:180px;overflow-y:auto;color:var(--dim);
}
.tool-body.hidden{display:none}
.tool-result{
  border-top:1px solid var(--border);padding:8px 12px;
  font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-all;
  max-height:140px;overflow-y:auto;color:var(--accent2);
}

/* ── Status ── */
.status-msg{text-align:center;font-size:12px;color:var(--dim);padding:6px 0;margin-bottom:4px}
.spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:4px}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── Approval ── */
.approval{background:var(--card);border:1px solid var(--yellow);border-radius:10px;padding:14px;margin-bottom:10px}
.approval .title{font-size:13px;font-weight:600;color:var(--yellow);margin-bottom:8px}
.approval .detail{font-family:var(--mono);font-size:11px;color:var(--dim);margin-bottom:12px;max-height:80px;overflow-y:auto;word-break:break-all}
.approval .btns{display:flex;gap:10px}
.approval .btns button{flex:1;padding:12px;border-radius:8px;font-size:15px;font-weight:600;border:none;cursor:pointer;min-height:44px}
.btn-approve{background:var(--accent2);color:#fff}
.btn-deny{background:var(--red);color:#fff}
.btn-approve:active,.btn-deny:active{opacity:.7}

/* ── Input area ── */
.input-area{
  flex-shrink:0;background:var(--card);border-top:1px solid var(--border);
  padding:8px 12px;padding-bottom:max(8px,var(--safe-bottom));
  display:flex;align-items:flex-end;gap:8px;
  transition:padding-bottom .15s ease;
}
.input-area textarea{
  flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);
  border-radius:10px;padding:10px 14px;font-family:var(--font);font-size:16px;
  line-height:1.4;resize:none;outline:none;
  min-height:44px;max-height:120px;
  transition:border-color .2s;
}
.input-area textarea:focus{border-color:var(--accent)}
.input-area textarea::placeholder{color:var(--dim)}
.input-area .send-btn{
  background:var(--accent);color:#fff;border:none;border-radius:10px;
  width:44px;height:44px;font-size:18px;cursor:pointer;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  transition:opacity .15s,background .15s;
}
.input-area .send-btn:active{opacity:.7}
.input-area .send-btn:disabled{background:var(--border);opacity:.4;cursor:not-allowed}
.input-area .attach-btn{
  background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:10px;
  width:44px;height:44px;font-size:18px;cursor:pointer;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  transition:opacity .15s,border-color .15s;
}
.input-area .attach-btn:active{opacity:.7}
.input-area .attach-btn:disabled{opacity:.4;cursor:not-allowed}

/* ── Pending attachment chips (above the input) ── */
.attach-bar{
  flex-shrink:0;display:none;flex-wrap:wrap;gap:6px;
  background:var(--card);border-top:1px solid var(--border);
  padding:8px 12px 0;
}
.attach-chip{
  display:inline-flex;align-items:center;gap:6px;max-width:100%;
  background:var(--bg);border:1px solid var(--border);border-radius:8px;
  padding:5px 8px;font-size:12px;color:var(--text);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.attach-chip.uploading{color:var(--dim)}
.attach-chip .attach-x{cursor:pointer;color:var(--dim);font-size:14px;line-height:1}
.attach-chip .attach-x:active{opacity:.6}
.attach-chip.mini{font-size:11px;padding:3px 6px}
.msg-attach{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}

/* ── Landscape ── */
@media (orientation:landscape) and (max-height:500px){
  .header{padding:6px 16px;min-height:36px}
  .header h1{font-size:14px}
  .transcript{padding:8px 14px}
  .msg{font-size:13px}
  .input-area textarea{max-height:80px;font-size:14px}
  .login-card{padding:24px 20px}
  .pin-input{font-size:20px;padding:10px}
}

/* ── Copy button ── */
.copy-btn{
  position:absolute;top:4px;right:4px;background:var(--border);color:var(--dim);
  border:none;border-radius:5px;padding:2px 8px;font-size:11px;cursor:pointer;
  opacity:0;transition:opacity .15s;z-index:1;line-height:1.5;
}
.msg:hover .copy-btn,.msg:active .copy-btn{opacity:1}
.copy-btn.copied{background:var(--accent2);color:#fff;opacity:1}
/* Code block copy */
.msg.ai pre{position:relative}
.pre-copy{
  position:absolute;top:4px;right:4px;background:var(--border);color:var(--dim);
  border:none;border-radius:4px;padding:2px 7px;font-size:10px;cursor:pointer;
  opacity:0;transition:opacity .15s;z-index:1;
}
.msg.ai pre:hover .pre-copy,.msg.ai pre:active .pre-copy{opacity:1}
.pre-copy.copied{background:var(--accent2);color:#fff;opacity:1}
/* Links in AI messages */
.msg.ai a{color:var(--accent);text-decoration:underline;word-break:break-all}
.msg.ai a:active{opacity:.7}

/* ── Empty state ── */
.empty-hint{
  text-align:center;color:var(--dim);padding:40px 20px;font-size:14px;line-height:1.8;
}
.empty-hint .icon{font-size:36px;display:block;margin-bottom:12px;opacity:.5}

/* ── Device badge ── */
.device-badge{font-size:10px;background:var(--border);color:var(--dim);border-radius:8px;padding:1px 7px;margin-left:4px}
/* Clickable header device-name badge (tap to rename) */
.device-name-badge{font-size:11px;background:var(--border);color:var(--text);border-radius:8px;
  padding:2px 8px;margin-left:2px;cursor:pointer;max-width:130px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.device-name-badge:active{opacity:.7}

/* ── Device naming overlay (forced on first login; reopened to rename) ── */
.device-overlay{position:fixed;inset:0;z-index:200;background:rgba(13,17,23,.92);
  display:none;align-items:center;justify-content:center;padding:20px}
.device-overlay.show{display:flex}
.device-card{background:var(--card);border:1px solid var(--border);border-radius:16px;
  padding:28px 24px;width:100%;max-width:360px;text-align:center}
.device-card h2{font-size:18px;font-weight:600;margin-bottom:6px;color:var(--text)}
.dev-detected{font-size:13px;color:var(--dim);margin-bottom:18px}
.dev-detected b{color:var(--accent)}
.device-name-row{display:flex;align-items:stretch;border:1px solid var(--border);
  border-radius:10px;overflow:hidden;background:var(--bg)}
.device-name-row:focus-within{border-color:var(--accent)}
.device-name-row .pfx{padding:12px 4px 12px 12px;color:var(--dim);font-size:16px;font-family:var(--mono)}
.device-name-row input{flex:1;background:none;border:none;color:var(--text);
  font-family:var(--font);font-size:16px;padding:12px 2px;outline:none;min-width:0}
.device-name-row .sfx{padding:12px 12px 12px 2px;color:var(--accent);font-size:16px;white-space:nowrap}
.device-preview{font-size:13px;color:var(--dim);margin-top:10px;min-height:18px}
.device-preview b{color:var(--accent2)}
.device-btns{display:flex;gap:10px;margin-top:18px}
.device-btns button{flex:1;padding:12px;border-radius:10px;font-size:15px;font-weight:600;
  border:none;cursor:pointer;min-height:46px;transition:opacity .15s}
.dev-ok{background:var(--accent);color:#fff}
.dev-auto{background:var(--border);color:var(--text)}
.dev-ok:active,.dev-auto:active{opacity:.7}
.dev-ok:disabled{background:var(--border);opacity:.5;cursor:not-allowed}

/* ── Desktop layout (min-width 768px) ── */
@media (min-width:768px){
  body{display:flex;justify-content:center}
  #app{max-width:900px;width:100%;border-left:1px solid var(--border);border-right:1px solid var(--border)}
  .login-card{max-width:400px}
  .header{padding:10px 24px}
  .header h1{font-size:18px}
  .transcript{padding:16px 24px}
  .msg{max-width:80%;font-size:15px}
  .msg.ai{padding:14px 18px}
  .msg.user{padding:10px 16px}
  .input-area{padding:12px 24px;padding-bottom:max(12px,var(--safe-bottom))}
  .input-area textarea{font-size:15px;padding:12px 16px;max-height:160px}
  .empty-hint{padding:60px 20px;font-size:15px}
  .empty-hint .icon{font-size:42px}
  /* Desktop keyboard hints */
  .kb-hint{display:inline}
  .header-right{gap:10px}
  .conn-text{max-width:200px;font-size:13px}
}
@media (max-width:767px){
  .kb-hint{display:none}
}
</style>
</head>
<body>

<!-- ── Login Screen ── -->
<div class="login-screen" id="loginScreen">
  <div class="login-card">
    <span class="logo">\uD83D\uDD10</span>
    <h2>KHY Remote</h2>
    <div class="subtitle">\u8FDC\u7A0B\u63A7\u5236\u53F0</div>

    <!-- Tabs -->
    <div class="auth-tabs">
      <button class="auth-tab active" id="tabLogin" onclick="switchTab('login')">\u767B\u5F55</button>
      <button class="auth-tab" id="tabRegister" onclick="switchTab('register')">\u6CE8\u518C</button>
    </div>

    <!-- Login Form -->
    <div class="auth-form active" id="formLogin">
      <label>\u7528\u6237\u540D</label>
      <input class="auth-input" id="loginUsername" type="text" placeholder="\u8BF7\u8F93\u5165\u7528\u6237\u540D" autocomplete="username">
      <label>\u5BC6\u7801</label>
      <input class="auth-input" id="loginPassword" type="password" placeholder="\u8BF7\u8F93\u5165\u5BC6\u7801" autocomplete="current-password">
      <button class="login-btn" id="loginBtn">\u767B\u5F55</button>
      <div class="auth-switch">\u8FD8\u6CA1\u6709\u8D26\u53F7\uFF1F<a onclick="switchTab('register')">\u70B9\u51FB\u6CE8\u518C</a></div>
    </div>

    <!-- Register Form -->
    <div class="auth-form" id="formRegister">
      <label>\u7528\u6237\u540D</label>
      <input class="auth-input" id="regUsername" type="text" placeholder="2-20 \u4E2A\u5B57\u7B26" autocomplete="username">
      <label>\u5BC6\u7801</label>
      <input class="auth-input" id="regPassword" type="password" placeholder="\u81F3\u5C11 6 \u4F4D" autocomplete="new-password">
      <label>\u786E\u8BA4\u5BC6\u7801</label>
      <input class="auth-input" id="regConfirm" type="password" placeholder="\u518D\u6B21\u8F93\u5165\u5BC6\u7801" autocomplete="new-password">
      <button class="login-btn" id="regBtn">\u6CE8\u518C</button>
      <div class="auth-switch">\u5DF2\u6709\u8D26\u53F7\uFF1F<a onclick="switchTab('login')">\u70B9\u51FB\u767B\u5F55</a></div>
    </div>

    <!-- PIN admin form (hidden) -->
    <div class="pin-form" id="formPin">
      <label>\u7BA1\u7406\u5458 PIN (6 \u4F4D\u6570\u5B57)</label>
      <input class="pin-input" id="pinInput" type="tel" maxlength="6" pattern="[0-9]*"
             inputmode="numeric" placeholder="\u00B7\u00B7\u00B7\u00B7\u00B7\u00B7" autocomplete="off">
      <button class="login-btn" id="pinBtn">\u8FDE\u63A5</button>
      <div class="auth-switch"><a onclick="switchTab('login')">\u8FD4\u56DE\u8D26\u53F7\u767B\u5F55</a></div>
    </div>

    <div class="login-error" id="loginError"></div>
    <div class="pin-link" id="pinLink" onclick="switchTab('pin')">\u7BA1\u7406\u5458 PIN \u767B\u5F55</div>
  </div>
</div>

<!-- ── Main App (hidden until authenticated) ── -->
<div id="app">

<div class="header">
  <h1>KHY Remote</h1>
  <div class="header-right">
    <span class="device-name-badge" id="deviceNameBadge" title="\u70B9\u51FB\u6539\u540D" style="display:none"></span>
    <button class="logout-btn" id="logoutBtn">\u9000\u51FA</button>
    <span class="dot off" id="dot"></span>
    <span class="conn-text" id="wsStatus">\u8FDE\u63A5\u4E2D...</span>
    <span class="online-count" id="onlineCount"></span>
  </div>
</div>

<div class="transcript" id="transcript">
  <div class="empty-hint" id="emptyHint">
    <span class="icon" id="emptyIcon">\uD83D\uDCF1</span>
    <span id="emptyText">\u5728\u4E0B\u65B9\u8F93\u5165\u6846\u53D1\u9001\u547D\u4EE4<br>AI \u7684\u56DE\u590D\u4F1A\u5B9E\u65F6\u663E\u793A\u5728\u8FD9\u91CC</span>
    <span class="kb-hint"><br><br><code>Enter</code> \u53D1\u9001 &nbsp; <code>Shift+Enter</code> \u6362\u884C</span>
  </div>
</div>

<div class="attach-bar" id="attachBar"></div>
<div class="input-area" id="inputArea">
  <input type="file" id="fileInput" multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.md,.csv,.json,.log,.xml,.yaml,.yml" style="display:none">
  <button class="attach-btn" id="attachBtn" disabled>&#x1F4CE;</button>
  <textarea id="input" placeholder="\u8F93\u5165\u547D\u4EE4..." rows="1" disabled></textarea>
  <button class="send-btn" id="sendBtn" disabled>&#x27A4;</button>
</div>

</div>

<!-- \u2500\u2500 Device naming overlay (forced on first login) \u2500\u2500 -->
<div class="device-overlay" id="deviceOverlay">
  <div class="device-card">
    <h2>\u7ED9\u8FD9\u53F0\u8BBE\u5907\u8D77\u4E2A\u540D\u5B57</h2>
    <div class="dev-detected" id="devDetected">\u68C0\u6D4B\u5230\uFF1A<b>\u8BBE\u5907</b></div>
    <div class="device-name-row">
      <span class="pfx">_</span>
      <input id="devNameInput" type="text" placeholder="\u4F60\u7684\u540D\u5B57\uFF0C\u5982 \u5C0F\u660E" autocomplete="off" maxlength="24">
      <span class="sfx" id="devNameSuffix">\u8BBE\u5907</span>
    </div>
    <div class="device-preview" id="devPreview"></div>
    <div class="device-btns">
      <button class="dev-auto" id="devAutoBtn">\u81EA\u52A8\u547D\u540D</button>
      <button class="dev-ok" id="devOkBtn">\u786E\u5B9A</button>
    </div>
  </div>
</div>
<script>
(function(){
  'use strict';
  /* ── Config ── */
  var DIRECT_PORT = ${parseInt(port, 10)};

  /* ── Auth state ── */
  var token = null;       // JWT or PIN used for WS auth
  var wsReady = false;    // WS connected but not yet authenticated
  var authenticated = false;

  /* Try to restore JWT from sessionStorage */
  (function initToken(){
    var saved = sessionStorage.getItem('khy_jwt');
    if(saved){ token = saved; }
  })();

  /* ── Tab switching ── */
  window.switchTab = function(tab){
    var tabs = document.querySelectorAll('.auth-tab');
    var forms = document.querySelectorAll('.auth-form');
    var pinForm = $('formPin');
    var pinLink = $('pinLink');
    tabs.forEach(function(t){ t.classList.remove('active'); });
    forms.forEach(function(f){ f.classList.remove('active'); });
    pinForm.classList.remove('active');
    $('loginError').textContent = '';

    if(tab === 'login'){
      $('tabLogin').classList.add('active');
      $('formLogin').classList.add('active');
      pinLink.style.display = '';
      $('loginUsername').focus();
    } else if(tab === 'register'){
      $('tabRegister').classList.add('active');
      $('formRegister').classList.add('active');
      pinLink.style.display = '';
      $('regUsername').focus();
    } else if(tab === 'pin'){
      pinForm.classList.add('active');
      pinLink.style.display = 'none';
      $('pinInput').focus();
    }
  };

  /* ── Base URL for API and WS (handles direct vs nginx proxy) ── */
  var pageBase = (function(){
    // Ensure trailing slash for relative URL resolution
    var p = location.pathname;
    if(p.charAt(p.length - 1) !== '/') p += '/';
    return p;
  })();

  function buildWsUrl(){
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var pagePort = location.port ? parseInt(location.port) : (location.protocol === 'https:' ? 443 : 80);
    if(pagePort === DIRECT_PORT){
      return proto + '//' + location.host + '/';
    } else {
      var base = location.pathname.replace(/\\/+$/,'');
      return proto + '//' + location.host + base + '/ws';
    }
  }

  function apiUrl(path){
    // Build API URL relative to page location, works behind nginx
    return pageBase + path;
  }

  /* ── State ── */
  var ws = null, reconnTimer = null, autoScroll = true;
  var currentAiEl = null, currentToolEl = null, busy = false;

  var $ = function(id){ return document.getElementById(id); };
  var dot = $('dot'), statusEl = $('wsStatus'), onlineCountEl = $('onlineCount');
  var transcript = $('transcript'), inputEl = $('input'), sendBtn = $('sendBtn');
  var emptyHint = $('emptyHint'), inputArea = $('inputArea');
  var fileInput = $('fileInput'), attachBtn = $('attachBtn'), attachBar = $('attachBar');
  var pendingAttachments = [];   // descriptors uploaded but not yet sent
  var loginScreen = $('loginScreen');
  var loginBtn = $('loginBtn'), loginError = $('loginError');
  var logoutBtn = $('logoutBtn'), appEl = $('app');

  /* ── Login UI ── */
  function showLogin(){
    loginScreen.style.display = 'flex';
    appEl.classList.remove('visible');
    loginError.textContent = '';
    authenticated = false;
  }

  function showApp(){
    loginScreen.style.display = 'none';
    appEl.classList.add('visible');
    authenticated = true;
    inputEl.disabled = false;
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    inputEl.focus();
  }

  function showError(msg){ $('loginError').textContent = msg; }
  function setLoading(btn, loading){
    btn.disabled = loading;
    btn.textContent = loading ? '\u8BF7\u7A0D\u5019...' : btn.dataset.label;
  }

  /* ── Login (fetch /api/login → JWT → WS auth) ── */
  loginBtn.dataset.label = '\u767B\u5F55';
  loginBtn.addEventListener('click', doLogin);
  $('loginPassword').addEventListener('keydown', function(e){ if(e.key==='Enter') doLogin(); });

  function doLogin(){
    var u = $('loginUsername').value.trim();
    var p = $('loginPassword').value;
    if(!u || !p){ showError('\u8BF7\u8F93\u5165\u7528\u6237\u540D\u548C\u5BC6\u7801'); return; }
    setLoading(loginBtn, true);
    showError('');
    fetch(apiUrl('api/login'), {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:u, password:p})
    })
    .then(function(r){
      if(!r.ok && r.status === 404) throw new Error('\u670D\u52A1\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5');
      return r.json();
    })
    .then(function(data){
      setLoading(loginBtn, false);
      if(data.ok && data.token){
        token = data.token;
        sessionStorage.setItem('khy_jwt', token);
        if(ws && ws.readyState === 1){
          sendAuth();
        } else {
          connect();
        }
      } else {
        var err = data.error || '\u767B\u5F55\u5931\u8D25';
        if(err.indexOf('\u7528\u6237\u540D') >= 0 || err.indexOf('\u5BC6\u7801') >= 0){
          err += '\uFF08\u9996\u6B21\u4F7F\u7528\u8BF7\u5148\u6CE8\u518C\uFF09';
        }
        showError(err);
      }
    })
    .catch(function(e){ setLoading(loginBtn, false); showError('\u7F51\u7EDC\u9519\u8BEF: ' + (e.message||'\u8BF7\u91CD\u8BD5')); });
  }

  /* ── Register (fetch /api/register → auto login) ── */
  var regBtn = $('regBtn');
  regBtn.dataset.label = '\u6CE8\u518C';
  regBtn.addEventListener('click', doRegister);
  $('regConfirm').addEventListener('keydown', function(e){ if(e.key==='Enter') doRegister(); });

  function doRegister(){
    var u = $('regUsername').value.trim();
    var p = $('regPassword').value;
    var c = $('regConfirm').value;
    if(!u || !p){ showError('\u8BF7\u586B\u5199\u7528\u6237\u540D\u548C\u5BC6\u7801'); return; }
    if(p !== c){ showError('\u4E24\u6B21\u5BC6\u7801\u4E0D\u4E00\u81F4'); return; }
    setLoading(regBtn, true);
    showError('');
    fetch(apiUrl('api/register'), {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:u, password:p})
    })
    .then(function(r){
      if(!r.ok && r.status === 404) throw new Error('\u670D\u52A1\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5');
      return r.json();
    })
    .then(function(data){
      setLoading(regBtn, false);
      if(data.ok){
        // Auto-login after successful registration
        $('loginUsername').value = u;
        $('loginPassword').value = p;
        switchTab('login');
        doLogin();
      } else {
        showError(data.error || '\u6CE8\u518C\u5931\u8D25');
      }
    })
    .catch(function(e){ setLoading(regBtn, false); showError('\u7F51\u7EDC\u9519\u8BEF: ' + (e.message||'\u8BF7\u91CD\u8BD5')); });
  }

  /* ── PIN login (admin shortcut) ── */
  var pinBtn = $('pinBtn');
  pinBtn.dataset.label = '\u8FDE\u63A5';
  pinBtn.addEventListener('click', doPinLogin);
  $('pinInput').addEventListener('keydown', function(e){ if(e.key==='Enter') doPinLogin(); });

  function doPinLogin(){
    var pin = $('pinInput').value.trim();
    if(!pin){ showError('\u8BF7\u8F93\u5165 PIN'); return; }
    token = pin;
    setLoading(pinBtn, true);
    showError('');
    if(ws && ws.readyState === 1){
      sendAuth();
    } else {
      connect();
    }
  }

  logoutBtn.addEventListener('click', function(){
    sessionStorage.removeItem('khy_jwt');
    token = null;
    authenticated = false;
    if(ws) try{ws.close();}catch(e){}
    showLogin();
  });

  /* ── WebSocket ── */
  function connect(){
    var url = buildWsUrl();
    try{ ws = new WebSocket(url); }catch(e){ scheduleReconnect(); return; }
    ws.onopen = function(){
      wsReady = true;
      dot.className = 'dot warn'; statusEl.textContent = '\u9A8C\u8BC1\u4E2D...';
      if(reconnTimer){ clearInterval(reconnTimer); reconnTimer = null; }
      // Auth is handled when server sends auth_required
    };
    ws.onclose = function(){
      wsReady = false;
      dot.className = 'dot off'; statusEl.textContent = '\u91CD\u8FDE\u4E2D...';
      inputEl.disabled = true; sendBtn.disabled = true; attachBtn.disabled = true;
      if(authenticated) scheduleReconnect();
    };
    ws.onerror = function(){ try{ws.close();}catch(e){} };
    ws.onmessage = function(evt){
      try{ handleMsg(JSON.parse(evt.data)); }catch(e){}
    };
  }
  function scheduleReconnect(){
    if(!reconnTimer) reconnTimer = setInterval(connect, 3000);
  }

  function handleMsg(msg){
    switch(msg.type){
      case 'auth_required':
        if(token){
          // Auto-auth with saved token/PIN
          sendAuth();
        }
        // else: wait for user to enter PIN on login screen
        break;
      case 'auth_ok':
        dot.className = 'dot on'; statusEl.textContent = '\u5DF2\u8FDE\u63A5';
        sessionStorage.setItem('khy_jwt', token);
        // Reset all loading states
        loginBtn.disabled = false; loginBtn.textContent = loginBtn.dataset.label;
        if(pinBtn){ pinBtn.disabled = false; pinBtn.textContent = pinBtn.dataset.label; }
        showApp();
        renderDeviceBadge();
        // First login on this device \u2192 force the naming overlay.
        if(msg.needsDeviceName && !deviceName){ openDeviceOverlay({}); }
        break;
      case 'auth_failed':
        dot.className = 'dot off';
        loginBtn.disabled = false; loginBtn.textContent = loginBtn.dataset.label;
        if(pinBtn){ pinBtn.disabled = false; pinBtn.textContent = pinBtn.dataset.label; }
        sessionStorage.removeItem('khy_jwt');
        token = null;
        showError('\u8BA4\u8BC1\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55');
        showLogin();
        break;
      case 'turn_start':
        busy = true; currentAiEl = null; currentToolEl = null;
        hideEmpty();
        if(msg.input && msg.input !== _lastSentText) addUserMsg(msg.input);
        _lastSentText = null;
        addStatusMsg('<span class="spinner"></span>\u601D\u8003\u4E2D...');
        break;
      case 'turn_complete':
        busy = false; currentAiEl = null; currentToolEl = null;
        removeSpinnerStatus();
        break;
      case 'chunk_text':
        appendAiText(msg.content || '');
        break;
      case 'chunk_thinking':
        appendThinking(msg.content || '');
        break;
      case 'chunk_tool_use':
        addToolCard(msg.tool || 'tool', msg.input || '', msg.toolId || '');
        break;
      case 'chunk_tool_result':
        appendToolResult(msg.content || '');
        break;
      case 'chunk_status':
        addStatusMsg(esc(msg.content || ''));
        break;
      case 'approval_request':
        addApproval(msg.requestId, msg.tool, msg.input);
        break;
      case 'approval_resolved':
        resolveApproval(msg.requestId, msg.decision);
        break;
      case 'presence':
        if(onlineCountEl && typeof msg.online === 'number'){
          onlineCountEl.textContent = msg.online + ' \u4EBA\u5728\u7EBF';
          onlineCountEl.className = 'online-count show';
          // Hover/long-press reveals which named devices are online.
          if(Array.isArray(msg.devices)){
            var names = msg.devices.map(function(d){ return d && d.name ? d.name : ''; })
              .filter(function(s){ return s; });
            onlineCountEl.title = names.length ? names.join('\u3001') : '';
          }
        }
        break;
      case 'device_named':
        // Server assigned/confirmed this device's name \u2192 persist + reflect in UI.
        deviceName = msg.name || '';
        deviceType = msg.deviceType || deviceType;
        try{
          if(deviceName) localStorage.setItem('khy_device_name', deviceName);
          if(deviceType) localStorage.setItem('khy_device_type', deviceType);
        }catch(e){}
        if(devOkBtn){ devOkBtn.disabled = false; }
        if(devAutoBtn){ devAutoBtn.disabled = false; }
        closeDeviceOverlay();
        renderDeviceBadge();
        break;
      case 'device_suggestion':
        // Non-committal prefill for the open overlay (best real name we found).
        if(devOverlay && devOverlay.classList.contains('show')){
          if(msg.label){
            devSuffix.textContent = msg.label;
            devDetected.innerHTML = '\u68C0\u6D4B\u5230\uFF1A<b>' + esc(msg.label) + '</b>';
          }
          if(msg.deviceType) deviceType = msg.deviceType;
          if(msg.suggestedXx && !(devInput.value || '').trim()){
            devInput.value = msg.suggestedXx;
            updateDevPreview();
          }
        }
        break;
      case 'pong':
        if(msg.timestamp && lastPingSent){
          lastRtt = Date.now() - lastPingSent;
          updateLatencyDisplay();
        }
        break;
    }
  }

  function wsSend(obj){
    if(ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  /* ── Attachment upload (image / document / video) ── */
  var KIND_LABELS = {
    image:'图片', video:'视频', audio:'音频', document:'文档',
    text:'文本', code:'代码', archive:'压缩包', other:'文件'
  };
  function kindLabel(k){ return KIND_LABELS[k] || '文件'; }
  function humanSizeJs(n){
    n = Number(n) || 0;
    if(n < 1024) return n + ' B';
    if(n < 1048576) return (n/1024).toFixed(1) + ' KB';
    if(n < 1073741824) return (n/1048576).toFixed(1) + ' MB';
    return (n/1073741824).toFixed(2) + ' GB';
  }
  function attachMeta(a){
    if(a.extracted) return ' · 已提取正文';   /* · 已提取正文 */
    if(a.transcript) return ' · 已转写';             /* · 已转写 */
    return '';
  }
  function renderAttachBar(uploading){
    attachBar.innerHTML = '';
    pendingAttachments.forEach(function(a, idx){
      var chip = mkEl('span','attach-chip');
      chip.appendChild(document.createTextNode(kindLabel(a.kind) + ' ' + a.name + ' (' + humanSizeJs(a.size) + ')' + attachMeta(a)));
      var x = mkEl('span','attach-x'); x.textContent = '×';
      x.addEventListener('click', function(){ pendingAttachments.splice(idx, 1); renderAttachBar(false); });
      chip.appendChild(x);
      attachBar.appendChild(chip);
    });
    if(uploading){
      var up = mkEl('span','attach-chip uploading');
      up.textContent = '上传中…';   /* 上传中… */
      attachBar.appendChild(up);
    }
    attachBar.style.display = (pendingAttachments.length || uploading) ? 'flex' : 'none';
  }
  attachBtn.addEventListener('click', function(){ if(!attachBtn.disabled) fileInput.click(); });
  fileInput.addEventListener('change', function(){
    var files = fileInput.files;
    if(files && files.length) uploadFiles(Array.prototype.slice.call(files));
    fileInput.value = '';
  });
  function uploadFiles(files){
    var fd = new FormData();
    files.forEach(function(f){ fd.append('file', f); });
    var headers = {};
    if(token) headers['Authorization'] = 'Bearer ' + token;
    attachBtn.disabled = true;
    renderAttachBar(true);
    fetch(apiUrl('api/upload'), { method:'POST', headers: headers, body: fd })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if(data && data.success && Array.isArray(data.attachments)){
          data.attachments.forEach(function(a){ if(a) pendingAttachments.push(a); });
        } else {
          addStatusMsg('⚠️ ' + esc((data && data.error) || '上传失败'));
        }
      })
      .catch(function(){ addStatusMsg('⚠️ 上传失败，请重试'); })  /* 上传失败，请重试 */
      .then(function(){ attachBtn.disabled = !authenticated; renderAttachBar(false); });
  }

  /* ── Send command ── */
  sendBtn.addEventListener('click', doSend);
  var _lastSentText = null;
  function doSend(){
    var text = inputEl.value.trim();
    var atts = pendingAttachments.map(function(a){ return a.id; });
    if((!text && !atts.length) || !ws || ws.readyState !== 1) return;
    _lastSentText = text;
    wsSend({type:'input', text: text, attachments: atts});
    hideEmpty();
    addUserMsg(text, pendingAttachments.slice());
    inputEl.value = '';
    pendingAttachments = [];
    renderAttachBar(false);
    autoSize();
    inputEl.focus();
  }

  /* ── Transcript rendering ── */
  function hideEmpty(){
    if(emptyHint){ emptyHint.remove(); emptyHint = null; }
  }

  function addUserMsg(text, atts){
    hideEmpty();
    var div = mkEl('div','msg user');
    if(text) div.appendChild(document.createTextNode(text));
    if(atts && atts.length){
      var ab = mkEl('div','msg-attach');
      atts.forEach(function(a){
        var c = mkEl('span','attach-chip mini');
        c.textContent = kindLabel(a.kind) + ' ' + a.name;
        ab.appendChild(c);
      });
      div.appendChild(ab);
    }
    div.appendChild(makeCopyBtn(text || ''));
    transcript.appendChild(div);
    scrollBottom();
  }

  function addStatusMsg(html){
    var div = mkEl('div','status-msg');
    div.innerHTML = html;
    transcript.appendChild(div);
    scrollBottom();
  }

  function removeSpinnerStatus(){
    var msgs = transcript.querySelectorAll('.status-msg');
    for(var i = msgs.length - 1; i >= 0; i--){
      if(msgs[i].querySelector('.spinner')){ msgs[i].remove(); break; }
    }
  }

  function appendAiText(text){
    hideEmpty();
    if(!currentAiEl){
      currentAiEl = mkEl('div','msg ai');
      currentAiEl._raw = '';
      transcript.appendChild(currentAiEl);
    }
    currentAiEl._raw += text;
    currentAiEl.innerHTML = renderMd(currentAiEl._raw);
    // Add copy buttons to code blocks
    var pres = currentAiEl.querySelectorAll('pre');
    for(var p = 0; p < pres.length; p++){
      if(!pres[p].querySelector('.pre-copy')){
        var codeText = pres[p].textContent;
        pres[p].appendChild(makePreCopyBtn(codeText));
      }
    }
    // Add message-level copy button (once)
    if(!currentAiEl.querySelector('.copy-btn')){
      currentAiEl.appendChild(makeCopyBtn(currentAiEl._raw));
    } else {
      // Update copy button data with latest text
      currentAiEl.querySelector('.copy-btn')._copyText = currentAiEl._raw;
    }
    scrollBottom();
  }

  function appendThinking(text){
    hideEmpty();
    var last = transcript.lastElementChild;
    if(last && last._isThinking){
      last._raw += text;
      last.querySelector('.think-content').textContent = last._raw;
    } else {
      var det = mkEl('details','thinking');
      det._isThinking = true; det._raw = text;
      var sum = document.createElement('summary');
      sum.textContent = '\u601D\u8003\u8FC7\u7A0B...';
      det.appendChild(sum);
      var cont = mkEl('div','think-content');
      cont.textContent = text;
      det.appendChild(cont);
      transcript.appendChild(det);
    }
    scrollBottom();
  }

  function addToolCard(name, input, id){
    hideEmpty();
    var card = mkEl('div','tool-card');
    card._id = id;
    var hdr = mkEl('div','tool-header');
    hdr.innerHTML = '<span class="arrow open">&#x25B6;</span>' + esc(name);
    var cardRef = card;
    hdr.onclick = function(){
      var body = cardRef.querySelector('.tool-body');
      var arrow = hdr.querySelector('.arrow');
      if(body.classList.contains('hidden')){
        body.classList.remove('hidden'); arrow.classList.add('open');
      } else {
        body.classList.add('hidden'); arrow.classList.remove('open');
      }
    };
    card.appendChild(hdr);
    var body = mkEl('div','tool-body');
    body.textContent = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    card.appendChild(body);
    transcript.appendChild(card);
    currentToolEl = card;
    scrollBottom();
  }

  function appendToolResult(text){
    if(!currentToolEl) return;
    var res = currentToolEl.querySelector('.tool-result');
    if(!res){ res = mkEl('div','tool-result'); currentToolEl.appendChild(res); }
    res.textContent += text;
    var body = currentToolEl.querySelector('.tool-body');
    if(body) body.classList.add('hidden');
    var arrow = currentToolEl.querySelector('.arrow');
    if(arrow) arrow.classList.remove('open');
    currentToolEl = null;
    scrollBottom();
  }

  function resolveApproval(requestId, decision){
    var el = document.querySelector('[data-request-id="' + requestId + '"]');
    if(!el) return;
    if(decision === 'allow'){
      el.innerHTML = '<div class="status-msg" style="color:var(--accent2)">\u2714 \u5DF2\u5141\u8BB8</div>';
    } else {
      el.innerHTML = '<div class="status-msg" style="color:var(--red)">\u2716 \u5DF2\u62D2\u7EDD</div>';
    }
  }

  function addApproval(requestId, tool, input){
    hideEmpty();
    var div = mkEl('div','approval');
    div.setAttribute('data-request-id', requestId);
    div.innerHTML = '<div class="title">\u6743\u9650\u8BF7\u6C42\uFF1A' + esc(tool || 'tool') + '</div>'
      + '<div class="detail">' + esc(typeof input === 'string' ? input : JSON.stringify(input || '').slice(0,500)) + '</div>'
      + '<div class="btns">'
      + '<button class="btn-approve">\u5141\u8BB8</button>'
      + '<button class="btn-deny">\u62D2\u7EDD</button>'
      + '</div>';
    div.querySelector('.btn-approve').onclick = function(){
      wsSend({type:'approve', requestId: requestId});
      div.innerHTML = '<div class="status-msg" style="color:var(--accent2)">\u2714 \u5DF2\u5141\u8BB8</div>';
    };
    div.querySelector('.btn-deny').onclick = function(){
      wsSend({type:'deny', requestId: requestId});
      div.innerHTML = '<div class="status-msg" style="color:var(--red)">\u2716 \u5DF2\u62D2\u7EDD</div>';
    };
    transcript.appendChild(div);
    scrollBottom();
    playBeep();
  }

  /* ── Markdown renderer ── */
  function renderMd(raw){
    var t = esc(raw);
    t = t.replace(/\\\`\\\`\\\`(?:[a-zA-Z]*)\\n?([\\s\\S]*?)\\\`\\\`\\\`/g, function(_,c){ return '<pre><code>'+c.trim()+'</code></pre>'; });
    t = t.replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>');
    t = t.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    t = t.replace(/^#{4} (.+)$/gm, '<h4>$1</h4>');
    t = t.replace(/^#{3} (.+)$/gm, '<h3>$1</h3>');
    t = t.replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>');
    // Linkify URLs (but not inside tags)
    t = t.replace(/(https?:\\/\\/[^\\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\\n/g, '<br>');
    return t;
  }

  /* ── Copy helpers ── */
  function doCopy(text, btn){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){
        flashCopied(btn);
      }).catch(function(){ fallbackCopy(text, btn); });
    } else {
      fallbackCopy(text, btn);
    }
  }
  function fallbackCopy(text, btn){
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand('copy'); flashCopied(btn); }catch(e){}
    document.body.removeChild(ta);
  }
  function flashCopied(btn){
    if(!btn) return;
    var orig = btn.textContent;
    btn.textContent = '\u2713 \u5DF2\u590D\u5236';
    btn.classList.add('copied');
    setTimeout(function(){ btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  }
  function makeCopyBtn(text){
    var btn = mkEl('button','copy-btn');
    btn.textContent = '\u590D\u5236';
    btn._copyText = text;
    btn.onclick = function(e){ e.stopPropagation(); doCopy(btn._copyText || text, btn); };
    return btn;
  }
  function makePreCopyBtn(text){
    var btn = mkEl('button','pre-copy');
    btn.textContent = '\u590D\u5236';
    btn.onclick = function(e){
      e.stopPropagation();
      // Get fresh code text from parent pre
      var pre = btn.parentElement;
      var code = pre ? pre.querySelector('code') : null;
      doCopy(code ? code.textContent : text, btn);
    };
    return btn;
  }

  /* ── Helpers ── */
  function mkEl(tag, cls){
    var el = document.createElement(tag);
    if(cls) el.className = cls;
    return el;
  }
  function esc(s){
    if(!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function scrollBottom(){
    if(!autoScroll) return;
    requestAnimationFrame(function(){ transcript.scrollTop = transcript.scrollHeight; });
  }

  /* Pause auto-scroll when user scrolls up */
  var scrollDebounce = null;
  transcript.addEventListener('scroll', function(){
    if(scrollDebounce) return;
    scrollDebounce = setTimeout(function(){
      scrollDebounce = null;
      var atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 50;
      autoScroll = atBottom;
    }, 100);
  }, {passive:true});

  /* ── Textarea auto-resize ── */
  function autoSize(){
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }
  inputEl.addEventListener('input', autoSize);
  inputEl.addEventListener('keydown', function(e){
    if(e.key === 'Enter' && !e.shiftKey && !e.isComposing){
      e.preventDefault();
      doSend();
    }
  });

  /* ── Keyboard handling (mobile only — desktop uses native layout) ── */
  function setupKeyboardHandling(){
    if(!window.visualViewport) return;
    // Only use visualViewport resize on mobile (desktop doesn't have virtual keyboard)
    if(!/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return;
    var vv = window.visualViewport;
    function onResize(){
      var kbH = window.innerHeight - vv.height;
      if(kbH < 0) kbH = 0;
      document.documentElement.style.setProperty('--kb-height', kbH + 'px');
      appEl.style.height = vv.height + 'px';
      if(kbH > 50) scrollBottom();
    }
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
  }
  setupKeyboardHandling();

  window.addEventListener('resize', function(){
    if(window.visualViewport && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)){
      appEl.style.height = window.visualViewport.height + 'px';
    }
    scrollBottom();
  });

  /* ── Audio beep ── */
  var _audioCtx = null;
  function playBeep(){
    try{
      if(!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = _audioCtx.createOscillator();
      var gain = _audioCtx.createGain();
      osc.connect(gain); gain.connect(_audioCtx.destination);
      osc.frequency.value = 660; gain.gain.value = 0.08;
      osc.start(); osc.stop(_audioCtx.currentTime + 0.12);
    }catch(e){}
  }

  /* ── Heartbeat + Latency ── */
  var lastPingSent = 0, lastRtt = 0;
  function updateLatencyDisplay(){
    if(!lastRtt) return;
    var label = lastRtt + 'ms';
    var color = lastRtt < 100 ? 'var(--accent2)' : lastRtt < 300 ? 'var(--yellow)' : 'var(--red)';
    statusEl.textContent = '\u5DF2\u8FDE\u63A5 \u00B7 ' + label;
    statusEl.style.color = color;
    dot.className = lastRtt < 300 ? 'dot on' : 'dot warn';
  }
  setInterval(function(){
    if(ws && ws.readyState === 1){
      lastPingSent = Date.now();
      wsSend({type:'ping'});
    }
  }, 15000);

  /* ── Device detection ── */
  var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  var isDesktop = !isMobile;
  (function applyDeviceUI(){
    // Update empty hint based on device
    var icon = $('emptyIcon');
    var text = $('emptyText');
    if(icon && text){
      if(isDesktop){
        icon.textContent = '\uD83D\uDCBB';
        text.innerHTML = '\u5728\u4E0B\u65B9\u8F93\u5165\u6846\u53D1\u9001\u547D\u4EE4<br>AI \u7684\u56DE\u590D\u4F1A\u5B9E\u65F6\u540C\u6B65\u5230\u8FD9\u91CC';
      }
    }
    // Header subtitle
    var sub = document.querySelector('.subtitle');
    if(sub) sub.textContent = isDesktop ? '\u684C\u9762\u534F\u4F5C\u7EC8\u7AEF' : '\u79FB\u52A8\u63A7\u5236\u53F0';
    // Input placeholder
    if(inputEl) inputEl.placeholder = isDesktop ? '\u8F93\u5165\u547D\u4EE4\u6216\u95EE\u9898\uFF0CEnter \u53D1\u9001...' : '\u8F93\u5165\u547D\u4EE4...';
    // Desktop: auto-focus username on login
    if(isDesktop){
      var lu = $('loginUsername');
      if(lu) setTimeout(function(){ lu.focus(); }, 100);
    }
  })();

  /* ── Device identity (forced naming on first login; rename anytime) ── */
  var LABELS = { phone:'手机', tablet:'平板', desktop:'电脑' };
  var deviceName = '';   // canonical "_xx label", persisted in localStorage
  var deviceType = '';   // 'phone' | 'tablet' | 'desktop'
  var deviceHints = null; // cached UA Client Hints (model/platform/...)

  (function initDeviceState(){
    try{
      var n = localStorage.getItem('khy_device_name');
      var t = localStorage.getItem('khy_device_type');
      if(n) deviceName = n;
      if(t) deviceType = t;
    }catch(e){}
  })();

  /* Compact local three-way classification (mirrors shared deviceIdentity). */
  function classifyLocal(){
    var ua = navigator.userAgent || '';
    var h = deviceHints || {};
    var isAndroid = /Android/i.test(ua) || /android/i.test(h.platform || '');
    var maxTouch = navigator.maxTouchPoints || 0;
    var isIpad = /iPad/i.test(ua) || (/Mac/i.test(ua) && maxTouch > 1);
    var isAndroidTablet = isAndroid && (/Tablet/i.test(ua) || !/Mobile/i.test(ua));
    var isPhone = /iPhone|iPod/i.test(ua) || (isAndroid && /Mobile/i.test(ua));
    var type;
    if(isIpad || isAndroidTablet || /Tablet|PlayBook|Silk/i.test(ua)){ type = 'tablet'; }
    else if(isPhone){ type = 'phone'; }
    else if(h.mobile === true){ type = 'phone'; }
    else { type = 'desktop'; }
    return { type: type, label: LABELS[type] };
  }

  /* Collect UA Client Hints (real Android model etc.); always resolves. */
  function collectHints(){
    var uad = navigator.userAgentData;
    var base = {
      mobile: (uad && uad.mobile) || false,
      platform: (uad && uad.platform) || '',
      touch: (navigator.maxTouchPoints || 0) > 1
    };
    if(uad && uad.getHighEntropyValues){
      return uad.getHighEntropyValues(['model','platform','platformVersion'])
        .then(function(hi){
          return {
            mobile: base.mobile, touch: base.touch,
            model: hi.model || '',
            platform: hi.platform || base.platform,
            platformVersion: hi.platformVersion || ''
          };
        })
        .catch(function(){ return base; });
    }
    return Promise.resolve(base);
  }
  // Warm the hints cache early so the overlay opens with classification ready.
  collectHints().then(function(h){ deviceHints = h; });

  /* Auth send that carries a returning device's stored name (skips re-naming). */
  function sendAuth(){
    var payload = { type:'auth', token: token };
    if(deviceName){ payload.deviceName = deviceName; payload.deviceType = deviceType; }
    wsSend(payload);
  }

  /* ── Naming overlay ── */
  var devOverlay = $('deviceOverlay');
  var devInput = $('devNameInput');
  var devSuffix = $('devNameSuffix');
  var devDetected = $('devDetected');
  var devPreview = $('devPreview');
  var devOkBtn = $('devOkBtn');
  var devAutoBtn = $('devAutoBtn');
  var devNameBadge = $('deviceNameBadge');

  function _previewName(){
    var xx = (devInput.value || '').trim().replace(/^_+/, '');
    var lb = devSuffix.textContent || '';
    if(lb && xx.slice(-lb.length) === lb) xx = xx.slice(0, -lb.length);
    return '_' + xx + lb;
  }
  function updateDevPreview(){
    devPreview.innerHTML = '预览：<b>' + esc(_previewName()) + '</b>';
  }
  function closeDeviceOverlay(){ if(devOverlay) devOverlay.classList.remove('show'); }

  function openDeviceOverlay(opts){
    opts = opts || {};
    var c = classifyLocal();
    if(!deviceType) deviceType = c.type;
    devSuffix.textContent = c.label;
    devDetected.innerHTML = '检测到：<b>' + esc(c.label) + '</b>';
    // Prefill: explicit suggestion > the xx from an existing name (rename case).
    var pre = '';
    if(opts.suggestedXx){ pre = opts.suggestedXx; }
    else if(deviceName){
      pre = deviceName.replace(/^_/, '');
      if(pre.slice(-c.label.length) === c.label) pre = pre.slice(0, -c.label.length);
    }
    devInput.value = pre;
    updateDevPreview();
    devOverlay.classList.add('show');
    setTimeout(function(){ try{ devInput.focus(); }catch(e){} }, 50);
    // Ask the host for a best-effort real-name suggestion (non-committal).
    collectHints().then(function(h){
      deviceHints = h;
      wsSend({ type:'resolve_device', hints: h, userAgent: navigator.userAgent });
    });
  }

  function submitDeviceName(xx){
    collectHints().then(function(h){
      deviceHints = h;
      if(devOkBtn) devOkBtn.disabled = true;
      if(devAutoBtn) devAutoBtn.disabled = true;
      wsSend({ type:'set_device', xx: xx, hints: h, userAgent: navigator.userAgent });
    });
  }

  function renderDeviceBadge(){
    if(!devNameBadge) return;
    if(deviceName){
      devNameBadge.textContent = deviceName;
      devNameBadge.style.display = '';
    } else {
      devNameBadge.style.display = 'none';
    }
  }

  if(devInput){
    devInput.addEventListener('input', updateDevPreview);
    devInput.addEventListener('keydown', function(e){
      if(e.key === 'Enter'){ e.preventDefault(); if(devOkBtn) devOkBtn.click(); }
    });
  }
  if(devOkBtn) devOkBtn.addEventListener('click', function(){ submitDeviceName((devInput.value || '').trim()); });
  if(devAutoBtn) devAutoBtn.addEventListener('click', function(){ submitDeviceName(''); });
  if(devNameBadge) devNameBadge.addEventListener('click', function(){ openDeviceOverlay({}); });

  /* ── Start ──
   * If we have a token (from URL or sessionStorage), connect immediately.
   * Otherwise show login screen and wait for PIN input. */
  if(token){
    connect();
  } else {
    showLogin();
  }
})();
</script>
</body>
</html>`;
}

module.exports = { buildMobileHTML };
