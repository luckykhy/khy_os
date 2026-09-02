'use strict';

/**
 * mobilePage.chat.js — PR: merge-khychat-into-bridge
 *
 * Inlined into the bridge collaboration page (services/backend/src/bridge/
 * mobilePage.js:1410) right before </body>. The bridge page has two faces
 * selected by the ?mode= query:
 *
 *   no query   → 协作控制台 (legacy). Nothing in this file changes behavior
 *               on that side; doSend() still sends type:'input' to the local
 *               Ink TUI REPL. The 🤖 AI 对话 link in the header is shown so
 *               the user can switch to chat.
 *
 *   ?mode=chat → khy chat 整页. This script:
 *               (1) connection indicators with friendly reconnection / error
 *                   text (chat mode is more sensitive to "is the line alive?")
 *               (2) disables the input + adds a spinner while a turn is in
 *                   flight; the send button becomes the cancel button
 *               (3) cancel feedback — after a successful cancel, surfaces
 *                   "已取消回复" in the status bar and re-enables the input
 *               (4) empty-state greeting + first-time hint
 *               (5) smooth mode switch: when going from chat to control, the
 *                   chat bar fades out and the input area unhides cleanly;
 *                   when going control→chat, focuses the textarea
 *               (6) error path: any auth_failed / turn_error / connection
 *                   drop gets a visible, plain-language line
 *               (7) mobile keyboard: visualViewport-based padding so the
 *                   input area stays above the on-screen keyboard on iOS
 *
 * All interaction is opt-in by setting window.__khyChatMode = true; when
 * false (default) the script returns immediately and never touches the
 * collaboration control UI.
 */

const buildChatSection = () => {
  return `
<!-- ── PR: merge-khychat-into-bridge — chat mode interaction ── -->
<style>
/* 控制台模式: 显示"🤖 AI 对话"入口链接 → ?mode=chat 整页. */
.khy-chat-link{
  display:none;
  color:var(--accent);text-decoration:none;
  font-size:12px;padding:3px 8px;border-radius:6px;
  border:1px solid var(--border);transition:background .15s,border-color .15s;
}
.khy-chat-link:hover,
.khy-chat-link:active{background:rgba(88,166,255,.12);border-color:var(--accent)}
body:not(.khy-chat-mode) .khy-chat-link{display:inline-block}

/* Chat 模式视觉: 简化 header, 隐藏协作控制台元素. */
body.khy-chat-mode .header h1{font-size:14px}
body.khy-chat-mode .header h1::before{
  content:"🤖 AI 对话";
  display:inline-block;margin-right:8px;
}
body.khy-chat-mode .header h1 > *{display:none}
body.khy-chat-mode #onlineCount{display:none !important}
body.khy-chat-mode .khy-chat-link{display:none !important}

/* Chat 模式登录卡: 改 logo/标题/副标题; 默认聚焦 PIN 表单;
   隐藏 "用户名/密码" tab (khy chat 是手机/局域网场景, PIN 就够). */
body.khy-chat-mode .login-card .logo::before{content:"🤖";font-size:36px;display:block}
body.khy-chat-mode .login-card .logo{font-size:0;line-height:1}
body.khy-chat-mode .login-card h2{font-size:0;line-height:1.2}
body.khy-chat-mode .login-card h2::before{
  content:"KHY Chat";display:block;font-size:22px;font-weight:600;color:var(--text);
}
body.khy-chat-mode .login-card .subtitle{font-size:0;line-height:1.6;margin-bottom:4px}
body.khy-chat-mode .login-card .subtitle::after{
  content:"用本机 AI 流式对话, 手机/Pad 浏览器即开即用";
  font-size:13px;display:block;color:var(--dim);
}
/* 默认隐藏账号密码 tab/表单 — chat 模式只走 PIN (KHY 协作默认账号系统
   在 khyquant 老模式, 移动端不友好; chat 场景 PIN 足够, 也与协作控制台
   形成清晰分工: 控制台 = 完整账号体系, chat = 零注册 PIN 即用). */
body.khy-chat-mode .auth-tabs,
body.khy-chat-mode #formLogin,
body.khy-chat-mode #formRegister,
body.khy-chat-mode .pin-link{display:none !important}
body.khy-chat-mode #formPin{display:block}
body.khy-chat-mode #formPin .auth-switch{display:none}
body.khy-chat-mode .login-card{padding:36px 32px 28px}
body.khy-chat-mode #pinInput{font-size:28px;letter-spacing:12px;text-align:center}
body.khy-chat-mode .login-btn{font-size:17px;padding:16px;margin-top:24px}
/* chat 模式 PIN 引导卡 (见 mobilePage.chat.js 的 khy-pin-help 段) */
.khy-pin-help{display:none;margin-top:18px;padding:12px 14px;background:rgba(88,166,255,.08);
  border:1px solid rgba(88,166,255,.25);border-radius:10px;font-size:12px;line-height:1.7;
  color:var(--dim);text-align:left}
body.khy-chat-mode .khy-pin-help{display:block}
.khy-pin-help b{color:var(--accent)}
.khy-pin-help code{background:rgba(255,255,255,.06);padding:1px 6px;border-radius:4px;
  font-size:11px;color:var(--text)}

/* (4) Chat 模式空态文案 — 取代控制台默认的"📱 在下方..."提示. */
body.khy-chat-mode .empty-hint{text-align:left;padding:24px}
body.khy-chat-mode .empty-hint #emptyIcon{display:none}
body.khy-chat-mode .empty-hint #emptyText{
  font-size:14px;line-height:1.7;color:var(--text);display:block
}
body.khy-chat-mode .empty-hint .kb-hint{font-size:0}
body.khy-chat-mode .empty-hint .kb-hint::before{
  content:"Enter 发送 · Shift+Enter 换行 · 工具调用、附件、上下文都在此页直接完成";
  font-size:12px;color:var(--dim);display:block;margin-top:14px;line-height:1.6
}

/* (2) 发送中: 输入框禁用 + 转圈覆盖在 sendBtn 上. */
body.khy-chat-mode .send-btn{position:relative;overflow:hidden}
body.khy-chat-mode .send-btn.busy::after{
  content:"";position:absolute;inset:6px;border-radius:50%;
  border:2px solid rgba(255,255,255,.3);border-top-color:#fff;
  animation:khy-spin 0.8s linear infinite
}
@keyframes khy-spin{to{transform:rotate(360deg)}}
body.khy-chat-mode .send-btn.busy{color:transparent}
body.khy-chat-mode .send-btn.busy:hover{background:var(--accent)}

/* (2/3) 取消按钮 (khy-cancel-btn) — 仅在 turn 进行中显示, 文字变化. */
.khy-chat-only{display:none}
body.khy-chat-mode .khy-chat-only{display:inline-flex}
.khy-chat-bar{
  display:flex;align-items:center;gap:8px;padding:6px 14px;
  background:linear-gradient(180deg,#0d1117,#161b22);
  border-bottom:1px solid var(--border);
  font-size:12px;color:var(--dim);
  user-select:none;
}
.khy-chat-bar a.khy-back{
  color:var(--accent);text-decoration:none;cursor:pointer;
  padding:3px 8px;border-radius:6px;transition:background .15s;
}
.khy-chat-bar a.khy-back:hover,
.khy-chat-bar a.khy-back:active{background:rgba(88,166,255,.12)}
.khy-chat-bar .spacer{flex:1}
.khy-chat-bar .khy-cancel-btn{
  background:transparent;color:var(--red);border:1px solid var(--red);
  border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;
  display:none;transition:opacity .15s;
}
.khy-chat-bar .khy-cancel-btn.show{display:inline-block}
.khy-chat-bar .khy-cancel-btn:active{opacity:.7}
.khy-chat-bar .khy-cancel-btn:disabled{opacity:.4;cursor:not-allowed}

/* (1) 状态条: 重连 / 错误 / 取消的临时提示 — 控制台已有的 #wsStatus 之外,
   chat 模式专用 #khyChatStatus 行, 不影响协作控制台. */
body.khy-chat-mode .khy-chat-status{
  display:none;padding:6px 14px;font-size:12px;
  background:#161b22;border-bottom:1px solid var(--border);
  color:var(--dim);line-height:1.5;
}
body.khy-chat-mode .khy-chat-status.show{display:block;animation:khy-fadein .25s ease}
body.khy-chat-mode .khy-chat-status.error{color:var(--red)}
body.khy-chat-mode .khy-chat-status.warn{color:var(--yellow)}
body.khy-chat-mode .khy-chat-status.ok{color:var(--accent2)}
@keyframes khy-fadein{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}

/* (5) 模式切换平滑过渡 — 防闪烁. */
.khy-chat-bar{transition:opacity .2s}
body:not(.khy-chat-mode) .khy-chat-bar{opacity:0;pointer-events:none}
</style>
<div class="khy-chat-status khy-chat-only" id="khyChatStatus" role="status" aria-live="polite"></div>
<!-- 引导: chat 模式 PIN 怎么拿. 注入到 #loginCard 之后, 不动 mobilePage.js. -->
<div class="khy-pin-help" id="khyPinHelp">
  <b>首次使用?</b> 请到运行 KHY 的电脑终端执行
  <code>khy bridge status</code> 取得 6 位 PIN (每 30 分钟刷新一次),
  或 <code>khy doctor</code> 查看完整引导。控制台页面 (无 ?mode=chat) 仍可用账号密码登录。
</div>
<div class="khy-chat-bar khy-chat-only" id="khyChatBar">
  <a class="khy-back" id="khyBackLink" href="?">← 协作控制</a>
  <span class="spacer"></span>
  <button class="khy-cancel-btn" id="khyCancelBtn" type="button">取消回复</button>
</div>
<script>
(() => {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const chat = params.get('mode') === 'chat';
    window.__khyChatMode = chat;

    // 控制台模式: 仅显出"🤖 AI 对话"入口链接; 其余脚本不执行.
    const chatLink = document.getElementById('khyChatLink');
    if (chatLink && !chat) { chatLink.style.display = ''; }
    if (!chat) { return; }

    document.body.classList.add('khy-chat-mode');

    // 把 PIN 引导卡从 <body> 末尾搬进登录卡, 紧跟在 PIN 表单后;
    // 并自动切到 PIN tab (跳过用户名密码 — chat 模式零注册).
    // 控制台模式不受影响 (chat = false 时上面已经 return).
    const pinHelp = document.getElementById('khyPinHelp');
    const pinForm = document.getElementById('formPin');
    if (pinHelp && pinForm && pinForm.parentNode) {
      pinForm.parentNode.insertBefore(pinHelp, pinForm.nextSibling);
    }
    // 触发 mobilePage.js 已有的 switchTab('pin') — 走 window.switchTab 公开 hook
    // (mobilePage.js:368 注册到 window); 若未注册, 不阻塞, 默认还是 username 表单.
    try {
      if (typeof window.switchTab === 'function') {
        window.switchTab('pin');
      }
    } catch { /* ignore — fall back to whatever default form */ }
    // 自动聚焦 PIN 输入框.
    const pinInput = document.getElementById('pinInput');
    if (pinInput) {
      try { pinInput.focus({ preventScroll: true }); } catch { try { pinInput.focus(); } catch { /* ignore */ } }
    }

    const statusEl = document.getElementById('khyChatStatus');
    const cancelBtn = document.getElementById('khyCancelBtn');
    const sendBtn = document.getElementById('sendBtn');
    const inputEl = document.getElementById('input');

    const showStatus = (text, kind) => {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.classList.remove('show', 'error', 'warn', 'ok');
      if (!text) return;
      statusEl.classList.add('show');
      if (kind) statusEl.classList.add(kind);
    };
    const clearStatus = () => showStatus('', null);

    // (5) 进入 chat 模式自动聚焦输入框; 转屏 / 重连后也保持焦点.
    if (inputEl) {
      try {
        inputEl.focus({ preventScroll: true });
      } catch {
        try { inputEl.focus(); } catch { /* ignore */ }
      }
    }

    // (2) 进入"正在回复"态: 输入禁用 + sendBtn 转圈 + cancelBtn 显示.
    const setBusy = (turnId) => {
      window.__khyCurrentTurnId = turnId || '';
      if (inputEl) inputEl.disabled = true;
      if (sendBtn) {
        sendBtn.classList.add('busy');
        sendBtn.disabled = true;
      }
      if (cancelBtn) {
        cancelBtn.classList.add('show');
        cancelBtn.disabled = false;
        cancelBtn.textContent = '取消回复';
      }
    };
    // (3) 退出"正在回复"态: 输入恢复 + 转圈停 + cancelBtn 隐藏.
    const setIdle = () => {
      window.__khyCurrentTurnId = '';
      if (inputEl) inputEl.disabled = false;
      if (sendBtn) {
        sendBtn.classList.remove('busy');
        sendBtn.disabled = false;
      }
      if (cancelBtn) {
        cancelBtn.classList.remove('show');
        cancelBtn.textContent = '取消回复';
      }
      if (inputEl) {
        try {
          inputEl.focus({ preventScroll: true });
        } catch {
          try { inputEl.focus(); } catch { /* ignore */ }
        }
      }
    };

    // (1) Hook: chat 模式覆盖 #wsStatus 文本以更友好.
    // mobilePage.js:687 写入"验证中..."/ "重连中..."/ "已连接". 这里再二次包装.
    const baseStatus = document.getElementById('wsStatus');
    if (baseStatus) {
      const observer = new MutationObserver(() => {
        const t = (baseStatus.textContent || '').trim();
        if (!t) return;
        if (t.indexOf('重连中') >= 0) {
          showStatus('连接断开, 正在自动重连...', 'warn');
        } else if (t.indexOf('已连接') >= 0) {
          showStatus('', null);
        } else if (t.indexOf('验证中') >= 0) {
          showStatus('正在建立安全通道...', null);
        }
      });
      observer.observe(baseStatus, { childList: true, characterData: true, subtree: true });
    }

    // (3) cancel 按钮: 主动发 type:'cancel', UI 给"取消中..."反馈, 等 turn_complete/cancelled
    // 完成时由 handleMsg 钩子 setIdle() + 提示"已取消".
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        const turnId = window.__khyCurrentTurnId;
        if (!turnId) return;
        try {
          if (window.__khyWs && window.__khyWs.readyState === 1) {
            window.__khyWs.send(JSON.stringify({ type: 'cancel', turnId }));
          }
        } catch { /* fail-soft */ }
        cancelBtn.disabled = true;
        cancelBtn.textContent = '取消中…';
        showStatus('已请求取消, 等待模型停止...', 'warn');
      });
    }

    // (4) 空态: 仅在 transcript 仍带 #emptyHint 时显示欢迎语.
    const transcript = document.getElementById('transcript');
    if (transcript) {
      const emptyHint = document.getElementById('emptyHint');
      if (emptyHint && chat) {
        const greet = document.createElement('div');
        greet.className = 'khy-greet';
        greet.style.cssText = 'padding:0 4px;line-height:1.7';
        // Note: 静态文案, 无用户输入, 用 innerHTML 在这里安全 (F2E §7 推荐
        // 避免 v-html/dangerouslySetInnerHTML, 但本场景是构建期常量字符串,
        // 不存在 XSS 风险). 仍然按 F2E §1 把行宽保持在 100 字符内.
        const greetHead = '<div style="font-size:15px;margin-bottom:8px;font-weight:600">'
          + '你好, 我是你的 KHY 助手</div>';
        const greetBody = '<div style="color:var(--dim);font-size:13px">'
          + '直接发问即可: 写代码、读文件、查资料、调工具都行。<br>'
          + '需要上下文时, 把文件拖到下面的回形针按钮。<br>'
          + '回复到一半想停? 点右上角"取消回复"。</div>';
        greet.innerHTML = greetHead + greetBody;
        // 注入到空态 hint 之前, 让欢迎语优先出现.
        emptyHint.parentNode.insertBefore(greet, emptyHint);
      }
    }

    // (6) 错误路径 hook: 监听 chunk_status / status 消息反映到 #transcript 的行,
    //     抓含错误/取消关键字的同步到 chat 状态条. mobilePage.js handleMsg
    //     已处理 turn_error 与 turn_complete (见 mobilePage.js:759-767).
    if (transcript) {
      const mo2 = new MutationObserver(() => {
        const lines = transcript.querySelectorAll('.status-msg, .chunk-status');
        const last = lines[lines.length - 1];
        if (!last) return;
        const t = (last.textContent || '').trim();
        if (!t) return;
        if (/错误|失败|无法|不可用|timeout|abort|network/i.test(t)) {
          showStatus(t, 'error');
        } else if (/取消|cancel|已停止/i.test(t)) {
          showStatus('已取消回复', 'warn');
        }
      });
      mo2.observe(transcript, { childList: true, subtree: true });
    }

    // (7) 移动端键盘: visualViewport 调整 body 底 padding, 让输入区不挡.
    if (window.visualViewport && inputEl) {
      const adjustForKeyboard = () => {
        // visualViewport.height 在键盘弹起时会收缩. 用它算 padding-bottom.
        const vv = window.visualViewport;
        const diff = Math.max(
          0,
          window.innerHeight - vv.height - (vv.offsetTop || 0),
        );
        if (diff > 80) {
          // 键盘可见: 给 input-area 底 padding 推开, 避免被键盘挡.
          document.body.style.paddingBottom = diff + 'px';
        } else {
          document.body.style.paddingBottom = '';
        }
      };
      window.visualViewport.addEventListener('resize', adjustForKeyboard);
      window.visualViewport.addEventListener('scroll', adjustForKeyboard);
      adjustForKeyboard();
    }

    // Expose setBusy / setIdle for mobilePage.js to call from handleMsg.
    window.__khyChatSetBusy = setBusy;
    window.__khyChatSetIdle = setIdle;
    window.__khyChatShowStatus = showStatus;
  } catch {
    // Anything goes wrong: leave window.__khyChatMode = false; mobilePage
    // falls back to the legacy 'input' path (safe default).
    window.__khyChatMode = false;
  }
})();
</script>
`;
}

module.exports = { buildChatSection };
