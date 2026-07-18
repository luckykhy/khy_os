/* Khy-OS 文档站脚本 — 离线自包含，无外部依赖（mermaid 从同目录 mermaid.min.js 加载）。
 * 职责：0) 声音层（WebAudio 现场合成音效 + 右上角开关，默认静音）  1) 初始化 mermaid 图表
 *       2) 滚动进入动画  3) 侧边栏移动端开合 + 搜索过滤  4) TOC 高亮  5) 小测  6) 翻卡/popover。
 * 维护：改完请重跑 `node scripts/docs/build_docs_site.js`（本文件是被复制引用，不参与构建逻辑）。 */
(function () {
  "use strict";

  // ---------- 0) 声音层：WebAudio 现场合成，零音频文件 ----------
  // 设计：不打包任何 .mp3/.wav（零二进制、离线安全、不违反"密钥/体积"红线），
  // 所有音效都用 AudioContext + 振荡器现场合成——经低通滤波柔化 + 余韵包络，做出清新木琴/铃铛质感。
  // 默认静音（尊重"进页面别突然出声"），右上角开关切换，选择存 localStorage。
  // 全程 fail-soft：浏览器没有 WebAudio、或用户没交互过 → 静默 no-op，绝不报错、绝不挡阅读。
  var Sound = (function () {
    var KEY = "khy-docs-sound";       // localStorage 键：'on' / 'off'
    var ctx = null;                    // AudioContext（首次用户手势时才创建/恢复）
    var enabled = false;               // 是否开声（默认关）
    var supported = typeof (window.AudioContext || window.webkitAudioContext) === "function";

    try { enabled = window.localStorage.getItem(KEY) === "on"; } catch (e) { enabled = false; }

    function ensureCtx() {
      if (!supported) return null;
      try {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        // 浏览器自动播放策略：AudioContext 常在用户手势后才能 resume。
        if (ctx.state === "suspended" && ctx.resume) ctx.resume();
        return ctx;
      } catch (e) { return null; }
    }

    // 音名 → 频率（Hz）小表，让 fx 用「音符」而非裸频率表达，读起来是音乐。
    var NOTE = {
      C5: 523.25, D5: 587.33, Ds5: 622.25, E5: 659.25, F5: 698.46,
      G5: 783.99, A5: 880.0, B5: 987.77, C6: 1046.5, E6: 1318.5,
    };
    var MASTER = 0.5;   // 全局音量上限系数，防突兀；再乘各音的 gain。

    // 合成一个「木琴/铃铛」质感的短音：freq 频率(Hz)、dur 时长(秒)、gain 峰值音量、type 波形。
    // 链路：osc → lowpass（柔化音色、去刺耳高频谐波）→ gain（余韵包络）→ destination。
    // 包络：快起音 + 指数衰减出「叮——」的钟琴余韵。全程 fail-soft，任何异常都吞掉。
    function tone(freq, dur, gain, type) {
      if (!enabled) return;
      var ac = ensureCtx();
      if (!ac) return;
      try {
        var t0 = ac.currentTime;
        var d = dur || 0.24;
        var peak = (gain || 0.06) * MASTER;
        var osc = ac.createOscillator();
        osc.type = type || "sine";
        osc.frequency.setValueAtTime(freq, t0);
        var g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);   // 快起音
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);     // 长尾余韵
        // 低通柔化：截止随音高走，钟琴般干净不刺耳。filter 造不出就退回直连。
        var out = g;
        try {
          var lp = ac.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.setValueAtTime(Math.min(6000, freq * 3.2 + 800), t0);
          lp.Q.setValueAtTime(0.7, t0);
          osc.connect(lp); lp.connect(g);
        } catch (e2) {
          osc.connect(g);   // 无 BiquadFilter：直连，仍出声
        }
        out.connect(ac.destination);
        osc.start(t0);
        osc.stop(t0 + d + 0.03);
      } catch (e) { /* fail-soft：出声失败绝不影响阅读 */ }
    }

    // 依次奏一串音符（每个 [音名或频率, 时长, 音量]），间隔 gap 毫秒——用于上行铃音/双音。
    function seq(notes, gap) {
      notes.forEach(function (n, i) {
        setTimeout(function () {
          tone(typeof n[0] === "string" ? (NOTE[n[0]] || 660) : n[0], n[1], n[2], "sine");
        }, i * (gap || 80));
      });
    }

    // 语义化音效（清新木琴/铃铛）：把"何时响"和"响成啥样"解耦，调用点只说语义。
    var fx = {
      // 答对：C5→E5→G5 三音上行铃音，钟琴般清脆悦耳。
      correct: function () { seq([["C5", 0.22, 0.06], ["E5", 0.22, 0.06], ["G5", 0.34, 0.07]], 85); },
      // 答错：温柔下行小二度（E5→D#5），短促、不刺耳、不惩罚。
      wrong: function () { seq([["E5", 0.18, 0.05], ["Ds5", 0.24, 0.045]], 110); },
      // 翻卡：单音木琴「叮」。
      flip: function () { tone(NOTE.A5, 0.22, 0.05); },
      // 漫画逐格入场：极轻单音，滚动触发不吵。
      reveal: function () { tone(NOTE.E5, 0.16, 0.028); },
      // popover/插话弹出：极轻高音「嗒」。
      pop: function () { tone(NOTE.C6, 0.12, 0.035); },
      // 开关自身反馈：清脆双音确认。
      toggle: function () { seq([["G5", 0.16, 0.05], ["C6", 0.22, 0.055]], 70); },
    };

    return {
      supported: supported,
      isOn: function () { return enabled; },
      set: function (on) {
        enabled = !!on;
        try { window.localStorage.setItem(KEY, enabled ? "on" : "off"); } catch (e) {}
        if (enabled) ensureCtx();
      },
      fx: fx,
    };
  })();

  // 右上角声音开关：JS 注入进 .topbar（不改 renderer/HTML 模板，保持纯 docs-site.js 改动）。
  function initSoundToggle() {
    if (!Sound.supported) return;              // 不支持 WebAudio 就不放按钮，免得点了没反应
    var bar = document.querySelector(".topbar");
    if (!bar || bar.querySelector(".sound-toggle")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sound-toggle";
    function sync() {
      var on = Sound.isOn();
      btn.textContent = on ? "🔊" : "🔇";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.setAttribute("aria-label", on ? "关闭音效" : "开启音效");
      btn.title = on ? "音效已开（点击静音）" : "音效已静音（点击开启）";
    }
    sync();
    btn.addEventListener("click", function () {
      Sound.set(!Sound.isOn());
      sync();
      if (Sound.isOn()) Sound.fx.toggle();     // 开启瞬间给一声反馈（此刻正是用户手势，可 resume）
      // 涟漪反馈：短暂加 .pinged 触发一次 CSS 白环扩散，动画结束即移除（可重复触发）。
      try {
        btn.classList.remove("pinged");
        void btn.offsetWidth;                  // 强制回流，让同名动画能再次播放
        btn.classList.add("pinged");
        setTimeout(function () { btn.classList.remove("pinged"); }, 550);
      } catch (e) { /* fail-soft */ }
    });
    bar.appendChild(btn);
  }

  // 把已注入的声音开关图标刷新到「静音」态（静心模式自动静音后同步观感，避免图标与实际不符）。
  // 声音开关的 sync() 是局部闭包够不到，这里直接按 Sound.isOn() 重绘那颗按钮，全程 fail-soft。
  function refreshSoundToggleIcon() {
    try {
      var sbtn = document.querySelector(".topbar .sound-toggle");
      if (!sbtn) return;
      var on = Sound.isOn();
      sbtn.textContent = on ? "🔊" : "🔇";
      sbtn.setAttribute("aria-pressed", on ? "true" : "false");
      sbtn.setAttribute("aria-label", on ? "关闭音效" : "开启音效");
      sbtn.title = on ? "音效已开（点击静音）" : "音效已静音（点击开启）";
    } catch (e) { /* fail-soft */ }
  }

  // ---------- 0b) 静心模式：一键降低「心灵噪音」（常驻动画/配色/装饰/声音）----------
  // 设计：读 prefers-reduced-motion 作默认态（系统已减弱动效→默认静心），用户手点后存 localStorage 覆盖。
  // 开启即给 <body> 加 .calm，CSS 就地把顶栏渐变/吉祥物摆动等永不停歇的外围动效安静下来、柔化配色、
  // 收敛纯装饰动效，并顺手静音（尊重"想安静读长文"）。全程 fail-soft：无 matchMedia/localStorage 也能手点。
  function initCalmToggle() {
    var bar = document.querySelector(".topbar");
    if (!bar || bar.querySelector(".calm-toggle")) return;
    var KEY = "khy-docs-calm";                   // localStorage：'on' / 'off'
    var prefersReduced = false;
    try {
      prefersReduced = !!(window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) { prefersReduced = false; }
    var stored = null;
    try { stored = window.localStorage.getItem(KEY); } catch (e) { stored = null; }
    // 默认跟随系统：没手动存过 → 用系统偏好；存过 → 用存的（用户覆盖优先）。
    var enabled = stored != null ? stored === "on" : prefersReduced;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sound-toggle calm-toggle";  // 复用声音开关的胶囊观感 + 语义 class
    function applyCalm(on) {
      try { document.body.classList.toggle("calm", on); } catch (e) {}
    }
    function sync() {
      btn.textContent = enabled ? "🌙" : "☀️";
      btn.setAttribute("aria-pressed", enabled ? "true" : "false");
      btn.setAttribute("aria-label", enabled ? "退出静心模式" : "进入静心模式");
      btn.title = enabled
        ? "静心模式已开（点击恢复活泼动效）"
        : "静心模式已关（点击降低动画与噪音）";
    }
    sync();
    applyCalm(enabled);                          // 首屏立即生效，避免"先活泼一下再静下来"的闪烁
    btn.addEventListener("click", function () {
      enabled = !enabled;
      try { window.localStorage.setItem(KEY, enabled ? "on" : "off"); } catch (e) {}
      applyCalm(enabled);
      sync();
      // 进入静心即顺手静音（若声音开着），并把声音开关图标同步到静音态。
      if (enabled) { try { Sound.set(false); } catch (e) {} refreshSoundToggleIcon(); }
    });
    bar.appendChild(btn);
  }

  // 右上角「获取 & 启动」按钮：JS 注入进 .topbar（同 sound/calm 一套胶囊观感，纯 docs-site.js/css 改动）。
  // 满足两个收尾诉求：①「网页里的 md 要有启动后台常驻按钮」——面板给出 `khy daemon start` 命令
  // （静态站无法真的替用户拉起进程，故一键复制到剪贴板，用户在自己终端里跑）；②「去哪下载」——
  // 面板列出 pip / npm 两条离机安装命令 + 官方包页链接。右键该按钮也能直接展开（呼应「可以右键打开」）。
  // 全程 fail-soft：剪贴板不可用时退回 execCommand，再不行就选中文本让用户手动复制，绝不抛。
  function initGetStarted() {
    var bar = document.querySelector(".topbar");
    if (!bar || bar.querySelector(".getstarted-toggle")) return;

    // 单一真源：命令 / 链接集中在这里，改一处即改全站。
    var DAEMON_CMD = "khy daemon start";        // 可加 --port 9090
    var PIP_CMD = "pip install khy-os";
    var NPM_CMD = "npm install -g @khy-os/khy-os";
    var PYPI_URL = "https://pypi.org/project/khy-os/";
    var NPM_URL = "https://www.npmjs.com/package/@khy-os/khy-os";
    // 代理内核(mihomo / clash-meta)二进制去哪下载。这里与后端 SSOT 对齐：
    //   proxyCoreInstaller.js: PINNED_VERSION / RELEASE_BASE / 落地路径 ~/.khyquant/bin/mihomo。
    // khy 首启会自动获取内核；本区是给「想手动放二进制」的用户的确切下载指引，不再对着
    // 「请下载 mihomo」四字发懵。改内核版本时同步改这三处（后端为准）。
    var PROXY_CORE_VERSION = "v1.18.10";
    var PROXY_RELEASES_URL = "https://github.com/MetaCubeX/mihomo/releases";
    var PROXY_RELEASE_BASE = "https://github.com/MetaCubeX/mihomo/releases/download/" + PROXY_CORE_VERSION;
    // 每平台预置资产文件名（与后端 ASSETS 表逐字对齐）。
    var PROXY_ASSETS = [
      { label: "Linux · x64",   file: "mihomo-linux-amd64-compatible-" + PROXY_CORE_VERSION + ".gz" },
      { label: "Linux · arm64", file: "mihomo-linux-arm64-" + PROXY_CORE_VERSION + ".gz" },
      { label: "macOS · x64",   file: "mihomo-darwin-amd64-" + PROXY_CORE_VERSION + ".gz" },
      { label: "macOS · arm64", file: "mihomo-darwin-arm64-" + PROXY_CORE_VERSION + ".gz" },
      { label: "Windows · x64", file: "mihomo-windows-amd64-" + PROXY_CORE_VERSION + ".zip" }
    ];
    // 落地路径：解压出的可执行文件放到这里，khy 即可采纳（Windows 为 mihomo.exe）。
    var PROXY_BIN_DIR = "~/.khyquant/bin/";

    function copyText(text, onDone) {
      // 优先 async clipboard；不可用（http/权限）退回隐藏 textarea + execCommand；再退回选中文本。
      function fallback() {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          var ok = false;
          try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
          document.body.removeChild(ta);
          onDone(ok);
        } catch (e) { onDone(false); }
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { onDone(true); }, fallback);
          return;
        }
      } catch (e) { /* fall through */ }
      fallback();
    }

    // 一行「命令 + 复制按钮」。
    function cmdRow(cmd) {
      var row = document.createElement("div");
      row.className = "gs-cmd";
      var code = document.createElement("code");
      code.textContent = cmd;
      var copy = document.createElement("button");
      copy.type = "button";
      copy.className = "gs-copy";
      copy.textContent = "复制";
      copy.setAttribute("aria-label", "复制命令：" + cmd);
      copy.addEventListener("click", function (ev) {
        ev.stopPropagation();
        copyText(cmd, function (ok) {
          copy.textContent = ok ? "已复制 ✓" : "手动复制";
          setTimeout(function () { copy.textContent = "复制"; }, 1400);
        });
      });
      row.appendChild(code);
      row.appendChild(copy);
      return row;
    }

    function linkRow(label, href) {
      var a = document.createElement("a");
      a.className = "gs-link";
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = label;
      return a;
    }

    // 面板（默认隐藏，锚定在按钮下方）。
    var panel = document.createElement("div");
    panel.className = "getstarted-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "获取与启动 Khy-OS");
    panel.hidden = true;

    var h = document.createElement("div");
    h.className = "gs-title";
    h.textContent = "🚀 获取 & 启动 Khy-OS";
    panel.appendChild(h);

    var s1 = document.createElement("div");
    s1.className = "gs-section";
    var s1h = document.createElement("div");
    s1h.className = "gs-head";
    s1h.textContent = "① 启动后台常驻服务";
    var s1p = document.createElement("p");
    s1p.className = "gs-note";
    s1p.textContent = "在你自己的终端里运行下面这条命令，khy 就会常驻后台（可加 --port 9090 指定端口）：";
    s1.appendChild(s1h);
    s1.appendChild(s1p);
    s1.appendChild(cmdRow(DAEMON_CMD));
    panel.appendChild(s1);

    var s2 = document.createElement("div");
    s2.className = "gs-section";
    var s2h = document.createElement("div");
    s2h.className = "gs-head";
    s2h.textContent = "② 去哪下载 / 安装";
    var s2p = document.createElement("p");
    s2p.className = "gs-note";
    s2p.textContent = "pip 与 npm 是两条离机安装渠道，任选其一：";
    s2.appendChild(s2h);
    s2.appendChild(s2p);
    s2.appendChild(cmdRow(PIP_CMD));
    s2.appendChild(cmdRow(NPM_CMD));
    var links = document.createElement("div");
    links.className = "gs-links";
    links.appendChild(linkRow("PyPI 包页 ↗", PYPI_URL));
    links.appendChild(linkRow("npm 包页 ↗", NPM_URL));
    s2.appendChild(links);
    panel.appendChild(s2);

    // ③ 代理内核二进制去哪下载 —— 与后端 describeCoreDownload 同源，永远给得出下一步。
    var s3 = document.createElement("div");
    s3.className = "gs-section";
    var s3h = document.createElement("div");
    s3h.className = "gs-head";
    s3h.textContent = "③ 代理内核二进制去哪下载";
    var s3p = document.createElement("p");
    s3p.className = "gs-note";
    s3p.textContent =
      "raw 协议节点（vmess/vless/trojan/ss/ssr）需要 mihomo（clash-meta）内核。khy 首启会自动获取；" +
      "想手动放二进制的话，按你的系统下载对应资产（固定版本 " + PROXY_CORE_VERSION + "），解压后放到落地目录即可：";
    s3.appendChild(s3h);
    s3.appendChild(s3p);
    var dlLinks = document.createElement("div");
    dlLinks.className = "gs-links";
    for (var i = 0; i < PROXY_ASSETS.length; i++) {
      dlLinks.appendChild(linkRow(PROXY_ASSETS[i].label + " ↓", PROXY_RELEASE_BASE + "/" + PROXY_ASSETS[i].file));
    }
    s3.appendChild(dlLinks);
    var s3d = document.createElement("p");
    s3d.className = "gs-note";
    s3d.textContent = "落地目录（Windows 为 mihomo.exe）：";
    s3.appendChild(s3d);
    s3.appendChild(cmdRow(PROXY_BIN_DIR));
    var s3links = document.createElement("div");
    s3links.className = "gs-links";
    s3links.appendChild(linkRow("mihomo Releases 总页（找不到对应资产时来这挑）↗", PROXY_RELEASES_URL));
    s3.appendChild(s3links);
    panel.appendChild(s3);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sound-toggle getstarted-toggle";  // 复用胶囊观感
    btn.textContent = "🚀";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "获取与启动 Khy-OS");
    btn.title = "获取 & 启动 Khy-OS（安装命令 / 启动后台常驻）";

    function setOpen(open) {
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    function toggle(ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      setOpen(panel.hidden);
    }
    btn.addEventListener("click", toggle);
    btn.addEventListener("contextmenu", toggle);       // 右键也能展开（呼应「可以右键打开」）
    // 面板内点击不冒泡关闭；面板外点击 / Esc 关闭。
    panel.addEventListener("click", function (ev) { ev.stopPropagation(); });
    document.addEventListener("click", function () { if (!panel.hidden) setOpen(false); });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !panel.hidden) setOpen(false);
    });

    var wrap = document.createElement("div");
    wrap.className = "getstarted-wrap";
    wrap.appendChild(btn);
    wrap.appendChild(panel);
    bar.appendChild(wrap);
  }

  // ---------- 1) mermaid 图表（离线）----------
  function initMermaid() {
    if (typeof window.mermaid === "undefined") return;
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: "default",
        securityLevel: "loose",
        flowchart: { curve: "basis", useMaxWidth: true },
        themeVariables: { fontFamily: "inherit" },
      });
      var nodes = document.querySelectorAll(".mermaid");
      if (nodes.length && window.mermaid.run) {
        window.mermaid.run({ nodes: nodes });
      } else if (nodes.length && window.mermaid.init) {
        window.mermaid.init(undefined, nodes);
      }
    } catch (e) {
      // 图渲染失败不应影响文字阅读：降级为提示。
      document.querySelectorAll(".mermaid").forEach(function (n) {
        if (!n.getAttribute("data-processed")) {
          n.style.whiteSpace = "pre-wrap";
          n.style.textAlign = "left";
        }
      });
    }
  }

  // ---------- 2) 滚动进入动画 ----------
  function initReveal() {
    var els = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window) || !els.length) {
      els.forEach(function (el) { el.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
          // 漫画分镜逐格入场时给一声很轻的音（仅 scene 面板，避免每个 .reveal 都响得吵）。
          if (en.target.classList.contains("scene-panel")) Sound.fx.reveal();
        }
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -8% 0px" });
    els.forEach(function (el) { io.observe(el); });
  }

  // ---------- 3a) 从 nav-data.js 构建侧边栏（离线，script src 加载，无 CORS 问题）----------
  function buildNav() {
    var root = document.getElementById("nav-root");
    var data = window.__KHY_NAV__;
    if (!root || !data) return;
    var ROOT = window.__KHY_ROOT__ || "";
    var CUR = window.__KHY_CUR__ || "";
    var frag = document.createDocumentFragment();
    data.forEach(function (grp) {
      var det = document.createElement("details");
      det.className = "nav-group";
      var sum = document.createElement("summary");
      sum.textContent = grp.group;
      det.appendChild(sum);
      var ul = document.createElement("ul");
      var containsCur = false;
      grp.items.forEach(function (it) {
        var li = document.createElement("li");
        var a = document.createElement("a");
        a.href = ROOT + it.href;
        a.textContent = it.title;
        a.title = it.title;
        if (it.href === CUR) { a.className = "active"; containsCur = true; }
        li.appendChild(a);
        ul.appendChild(li);
      });
      det.appendChild(ul);
      if (containsCur) det.setAttribute("open", "");
      frag.appendChild(det);
    });
    root.appendChild(frag);
  }

  // ---------- 3) 侧边栏：移动端开合 + 关键词过滤 ----------
  function initSidebar() {
    var toggle = document.querySelector(".menu-toggle");
    var sidebar = document.querySelector(".sidebar");
    if (toggle && sidebar) {
      toggle.addEventListener("click", function () { sidebar.classList.toggle("open"); });
      sidebar.querySelectorAll("a").forEach(function (a) {
        a.addEventListener("click", function () { sidebar.classList.remove("open"); });
      });
    }
    var search = document.querySelector(".sidebar .search");
    if (search && sidebar) {
      search.addEventListener("input", function () {
        var q = search.value.trim().toLowerCase();
        sidebar.querySelectorAll(".nav-group").forEach(function (grp) {
          var anyVisible = false;
          grp.querySelectorAll("li").forEach(function (li) {
            var hit = li.textContent.toLowerCase().indexOf(q) !== -1;
            li.style.display = hit ? "" : "none";
            if (hit) anyVisible = true;
          });
          grp.style.display = anyVisible ? "" : "none";
          if (q && anyVisible) grp.setAttribute("open", "");
        });
      });
    }
  }

  // ---------- 5) 练习互动：单选/多选小测 ----------
  function initQuiz() {
    document.querySelectorAll(".quiz").forEach(function (quiz) {
      var multi = quiz.getAttribute("data-multi") === "1";
      var feedback = quiz.querySelector(".quiz-feedback");
      var explain = quiz.querySelector(".quiz-explain");
      var choices = Array.prototype.slice.call(quiz.querySelectorAll(".quiz-choice"));
      var settled = false;
      function reveal(msg, ok) {
        if (feedback) {
          feedback.textContent = msg;
          feedback.className = "quiz-feedback " + (ok ? "ok" : "no");
        }
        if (explain) explain.hidden = false;
        if (ok) Sound.fx.correct(); else Sound.fx.wrong();
      }
      choices.forEach(function (btn) {
        btn.addEventListener("click", function () {
          var correct = btn.getAttribute("data-correct") === "1";
          if (!multi) {
            if (settled) return;
            settled = true;
            choices.forEach(function (b) {
              b.classList.add(b.getAttribute("data-correct") === "1" ? "is-correct" : "is-dim");
              b.disabled = true;
            });
            if (!correct) btn.classList.add("is-wrong");
            reveal(correct ? "🎉 答对了！" : "再想想～正确答案已高亮。", correct);
          } else {
            btn.classList.toggle("is-picked");
            var picked = quiz.querySelectorAll(".quiz-choice.is-picked");
            var allRight = choices.every(function (b) {
              var want = b.getAttribute("data-correct") === "1";
              return b.classList.contains("is-picked") === want;
            });
            if (picked.length && allRight) {
              choices.forEach(function (b) { b.disabled = true; });
              reveal("🎉 全部选对了！", true);
            }
          }
        });
      });
    });
  }

  // ---------- 6) 翻卡动画：点击 3D 翻转 ----------
  function initFlip() {
    document.querySelectorAll(".flip").forEach(function (card) {
      function flip() { card.classList.toggle("flipped"); Sound.fx.flip(); }
      card.addEventListener("click", flip);
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
      });
    });
  }

  // ---------- 6b) popover / 吉祥物插话弹出音 ----------
  // popover 本身靠 CSS :hover/:focus-within 弹出（无 JS）；这里只加"弹出发一声"的钩子。
  function initPopover() {
    document.querySelectorAll(".popover").forEach(function (pop) {
      var last = 0;
      function ping() {
        // 防抖：同一 popover 300ms 内多次进入/聚焦只响一次，避免鼠标抖动刷屏。
        var now = (window.Date && Date.now) ? Date.now() : 0;
        if (now - last < 300) return;
        last = now;
        Sound.fx.pop();
      }
      pop.addEventListener("mouseenter", ping);
      pop.addEventListener("focusin", ping);
    });
  }

  // ---------- 4) TOC 滚动高亮 ----------
  function initTocSpy() {
    var links = Array.prototype.slice.call(document.querySelectorAll(".toc a[href^='#']"));
    if (!links.length || !("IntersectionObserver" in window)) return;
    var map = {};
    links.forEach(function (a) {
      var id = decodeURIComponent(a.getAttribute("href").slice(1));
      var t = document.getElementById(id);
      if (t) map[id] = a;
    });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          links.forEach(function (l) { l.style.fontWeight = ""; });
          var a = map[en.target.id];
          if (a) a.style.fontWeight = "700";
        }
      });
    }, { rootMargin: "-10% 0px -80% 0px" });
    Object.keys(map).forEach(function (id) {
      var t = document.getElementById(id);
      if (t) spy.observe(t);
    });
  }

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }
  ready(function () {
    buildNav();
    initSoundToggle();
    initCalmToggle();
    initGetStarted();
    initMermaid();
    initReveal();
    initSidebar();
    initQuiz();
    initFlip();
    initPopover();
    initTocSpy();
  });
})();
