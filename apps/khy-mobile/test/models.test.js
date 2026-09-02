// 模型 store 的契约测试：保证独立模式 + 链接电脑模式两条路径的核心不变量
// ——"独立模式永不要求后端"、"已配 key 的 provider 决定当前实际可用模型"。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const readSrc = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('models store: 独立模式 / 远程模式 dual-mode 契约', () => {
  it('暴露 firstProviderWithKey / effectiveStandaloneProvider', () => {
    const src = readSrc('src/stores/models.js');
    expect(src).toMatch(/firstProviderWithKey/);
    expect(src).toMatch(/effectiveStandaloneProvider/);
  });

  it('modelOptions 在 mode=standalone 时按 effectiveStandaloneProvider 解析', () => {
    const src = readSrc('src/stores/models.js');
    // 必须用 effectiveStandaloneProvider 去找 provider，而不是 selectedProvider
    expect(src).toMatch(/effectiveStandaloneProvider/);
    // 兜底分支应保留
    expect(src).toMatch(/firstProviderWithKey/);
  });

  it('standalone provider 列表至少含 6 个内置 + 1 个 custom', () => {
    const src = readSrc('src/api/standalone.js');
    for (const id of ['openai', 'deepseek', 'moonshot', 'qwen', 'zhipu', 'custom']) {
      expect(src).toContain(`${id}:`);
    }
  });

  it('API key 永远不进浏览器层 plain storage', () => {
    // 关键安全不变量：getStandaloneApiKey / saveStandaloneApiKey 必须走 SecureStoragePlugin，
    // 只能降级到 web Map（测试/dev），绝不能走 localStorage
    const src = readSrc('src/api/standalone.js');
    expect(src).not.toMatch(/localStorage/);
    expect(src).toMatch(/SecureStoragePlugin/);
  });

  it('streamChatCompletion 走 SSE（流式 + 工具调用 + usage）', () => {
    const src = readSrc('src/api/standalone.js');
    expect(src).toMatch(/stream:\s*true/);
    expect(src).toMatch(/include_usage:\s*true/);
    expect(src).toMatch(/tool_choice/);
    expect(src).toMatch(/consumeSse/);
  });

  it('ChatView 发送时按 effectiveStandaloneProvider 选 key', () => {
    const src = readSrc('src/views/ChatView.vue');
    // sendStandalone 必须用 effectiveStandaloneProvider（不是 selectedProvider）
    expect(src).toMatch(/effectiveStandaloneProvider/);
    // send() 兜底：mode 空 + 任一 provider 有 key → 走独立
    expect(src).toMatch(/firstProviderWithKey/);
  });

  it('HomeView 独立模式下不调后端 API', () => {
    const src = readSrc('src/views/HomeView.vue');
    // viewMode === 'standalone' 早返回，不进 apiJson
    expect(src).toMatch(/viewMode\s*===\s*'standalone'/);
    // 不应再直接 await apiJson 渲染 snapshot —— 独立分支返回本地占位
    expect(src).toMatch(/standaloneSummary/);
  });

  it('router 守卫允许独立模式访问所有 view，永不强制 /connect', () => {
    const src = readSrc('src/router/index.js');
    // 独立模式直接 return true，不看 to.path
    expect(src).toMatch(/storedMode\s*===\s*'standalone'\)\s*return\s*true/);
  });

  it('localDb.appendMessage 持久化 tool 消息关键字段（toolCallId/toolName/toolOk/thinking）', () => {
    const src = readSrc('src/api/localDb.js');
    expect(src).toMatch(/toolCallId:/);
    expect(src).toMatch(/toolName:/);
    expect(src).toMatch(/toolOk:/);
    expect(src).toMatch(/thinking:/);
  });

  it('toOpenAiMessages 能从持久化字段重建 tool_call_id', () => {
    const src = readSrc('src/api/standalone.js');
    // 必须从 toolCallId（驼峰）读，OpenAI 协议字段名 tool_call_id（下划线）才出
    expect(src).toMatch(/item\.toolCallId/);
  });

  it('router 守卫的"无后端"放行集合至少含 home/chat/conversations/prompts', () => {
    const src = readSrc('src/router/index.js');
    // 提取第一段 FREEPASS（set 定义）
    const setMatch = src.match(/const FREEPASS = new Set\(\[([^\]]+)\]/);
    expect(setMatch, 'expected a FREEPASS set in router').toBeTruthy();
    const items = setMatch[1];
    for (const p of ['/home', '/chat', '/conversations', '/prompts', '/models', '/settings', '/agent']) {
      expect(items, `FREEPASS should contain ${p}`).toContain(p);
    }
  });

  it('AgentView 走 effectiveStandaloneProvider 而不是 selectedProvider', () => {
    const src = readSrc('src/views/AgentView.vue');
    // send() 必须用 effectiveStandaloneProvider，否则用户只在 zhipu 配了 key 会因
    // selectedProvider 停在 openai 报"未配置 API Key"
    expect(src).toMatch(/effectiveStandaloneProvider/);
  });

  it('WelcomeView 用 standalone.js 的真 provider 列表', () => {
    const src = readSrc('src/views/WelcomeView.vue');
    expect(src).toMatch(/standaloneProviders/);
    // 不能再写死 'OpenAI / DeepSeek / Kimi / 通义 / 智谱 / 自定义' 这种硬编码列表
    expect(src).not.toMatch(/const STANDALONE_PROVIDERS = \[\s*\{ id: 'openai'/);
  });

  it('ChatView/AgentView 必须在 onMounted 里 ensureKeysLoaded', () => {
    // 防止"刚切到 /chat 还没读到 SecureStorage 里的 key 就 send() 误报"
    const chat = readSrc('src/views/ChatView.vue');
    const agent = readSrc('src/views/AgentView.vue');
    expect(chat).toMatch(/ensureKeysLoaded/);
    expect(agent).toMatch(/ensureKeysLoaded/);
  });

  it('localDb.appendMessage 默认值给 null 不会丢旧数据', () => {
    const src = readSrc('src/api/localDb.js');
    // toolCallId / toolName / toolOk 都要默认 null，老消息无此字段不会变 undefined 阻塞 toOpenAiMessages
    expect(src).toMatch(/toolCallId:.*null/s);
    expect(src).toMatch(/toolName:.*null/s);
    expect(src).toMatch(/toolOk:.*null/s);
  });

  it('router 守卫的 FREEPASS 列表同步远程+无后端 / 远程+无 session 两条分支', () => {
    const src = readSrc('src/router/index.js');
    // 应有 2 个 FREEPASS（两段路由分支）
    const matches = src.match(/const FREEPASS = new Set/g) || [];
    expect(matches.length).toBe(2);
  });

  it('MobileShell 顶栏加重模式切换按钮 (任何页面 1-tap 切模式)', () => {
    const src = readSrc('src/layouts/MobileShell.vue');
    // 必须有「切到湖畔」/「切回森林」两个文案
    expect(src).toMatch(/切到湖畔|切回森林/);
    // 必须有 modeSwitchOpen 弹窗控制
    expect(src).toMatch(/modeSwitchOpen/);
    // 必须有 openModeSwitch + confirmModeSwitch
    expect(src).toMatch(/openModeSwitch/);
    expect(src).toMatch(/confirmModeSwitch/);
    // 切换后必须按目标智能跳转
    expect(src).toMatch(/router\.replace\(['"]\/home['"]\)/);
    expect(src).toMatch(/router\.replace\(['"]\/connect['"]\)/);
  });

  it('森林童话风：调色板不再用旧深色 token', () => {
    const css = readSrc('src/styles.css');
    // 调色板用绿叶/苔藓/湖蓝/奶白/浆果等"自然色"，不再用 #0b1118 / #68d5c0 等旧色
    expect(css).toMatch(/--m-accent: #6fa978/);
    expect(css).toMatch(/--m-lake: #6ea4b8/);
    expect(css).toMatch(/--m-bg: #f4f1e6/);
    // 旧深色 token 不应再出现
    expect(css).not.toMatch(/--m-accent: #68d5c0/);
  });

  it('WelcomeView 改名为「森林小屋 / 湖畔工坊」 + emoji provider 头像', () => {
    const src = readSrc('src/views/WelcomeView.vue');
    expect(src).toMatch(/森林小屋/);
    expect(src).toMatch(/湖畔工坊/);
    // 必须有 emoji provider 列表（不依赖 standaloneProviders 的 unicode logo）
    expect(src).toMatch(/FOREST_PROVIDERS/);
  });

  it('edge-to-edge (WebView safe-area) 全屏页面覆盖：topbar / 底栏 / 弹窗 / 登录 / 欢迎', () => {
    // 全屏 view（不在 MobileShell 内）必须自己处理 safe-area
    // —— MobileShell 内的 view（Home/Chat/Models/...）由 shell-content + .topbar 兜底
    const topbar = readSrc('src/styles.css');
    expect(topbar).toMatch(/--m-bg: #f4f1e6/);
    expect(topbar).toMatch(/100dvh/);
    expect(topbar).toMatch(/env\(safe-area-inset-top\)/);
    expect(topbar).toMatch(/env\(safe-area-inset-bottom\)/);

    for (const rel of [
      'src/views/WelcomeView.vue',
      'src/views/ConnectionView.vue',
      'src/views/LoginView.vue',
    ]) {
      const v = readSrc(rel);
      expect(v, `${rel} should use safe-area-inset`).toMatch(/safe-area-inset-(top|bottom)/);
    }
    // ChatView composer 也用 safe-area（IME 时排除底栏 + 手势条）
    const chat = readSrc('src/views/ChatView.vue');
    expect(chat).toMatch(/safe-area-inset-bottom/);
  });

  it('IME 软键盘：CSS 变量 --kbd-h 由 composable 写入', () => {
    const chat = readSrc('src/views/ChatView.vue');
    expect(chat).toMatch(/--kbd-h/);
    const main = readSrc('src/main.js');
    expect(main).toMatch(/attachChatKeyboard/);
    const comp = readSrc('src/composables/useChatKeyboard.js');
    expect(comp).toMatch(/visualViewport/);
    expect(comp).toMatch(/--kbd-h/);
  });

  it('R8 minify + 资源压缩开启 + Shizuku/Capacitor keep 规则', () => {
    const gradle = readSrc('android/app/build.gradle');
    expect(gradle).toMatch(/minifyEnabled true/);
    expect(gradle).toMatch(/shrinkResources true/);
    expect(gradle).toMatch(/proguard-android-optimize\.txt/);
    const proguard = readSrc('android/app/proguard-rules.pro');
    // Shizuku keep
    expect(proguard).toMatch(/dev\.rikka\.shizuku/);
    // Capacitor keep
    expect(proguard).toMatch(/com\.capacitor/);
    expect(proguard).toMatch(/com\.getcapacitor/);
    // Secure storage plugin keep
    expect(proguard).toMatch(/app\.covacap/);
    // WebView JS interface
    expect(proguard).toMatch(/JavascriptInterface/);
  });

  it('R8 优化资源压缩开关（AGP 8.6+）', () => {
    const props = readSrc('android/gradle.properties');
    expect(props).toMatch(/android\.r8\.optimizedResourceShrinking=true/);
  });

  it('index.html 含 viewport-fit=cover 让 safe-area 真正生效', () => {
    const html = readSrc('index.html');
    expect(html).toMatch(/viewport-fit=cover/);
  });

  it('ChatView 顶贴「当前模型」chip，显示 model + provider', () => {
    const chat = readSrc('src/views/ChatView.vue');
    expect(chat).toMatch(/current-model-chip/);
    expect(chat).toMatch(/currentModel/);
    expect(chat).toMatch(/effectiveStandaloneProvider/);
  });

  it('ChatView composer 用 auto-grow，不再固定 80px', () => {
    const chat = readSrc('src/views/ChatView.vue');
    // auto-grow 函数存在
    expect(chat).toMatch(/function autogrow/);
    // textarea 不再用 min-height 80px
    expect(chat).not.toMatch(/\.composer textarea \{ min-height: 80px/);
    // composer-input 走 max-height
    expect(chat).toMatch(/max-height/);
  });

  it('ModelsView 有「测试连接」按钮 + 友好错误翻译', () => {
    const mv = readSrc('src/views/ModelsView.vue');
    expect(mv).toMatch(/testConnection|test-btn/);
    expect(mv).toMatch(/测试连接/);
    // 错误翻译覆盖 HTTP 401/404/429/5xx + CORS + 网络 + 超时
    expect(mv).toMatch(/HTTP \$\{code\}/);
    expect(mv).toMatch(/鉴权失败/);
    expect(mv).toMatch(/端点不存在/);
    expect(mv).toMatch(/请求太频繁/);
    expect(mv).toMatch(/供应商服务端异常/);
    expect(mv).toMatch(/CORS/);
    expect(mv).toMatch(/网络不通/);
  });

  it('ModelsView 端到端「测试发送」按钮：拉完模型才出现', () => {
    const mv = readSrc('src/views/ModelsView.vue');
    // 函数 + 状态 + 按钮 + 状态徽章
    expect(mv).toMatch(/testSendMessage/);
    expect(mv).toMatch(/sendTestState/);
    expect(mv).toMatch(/sendTestDetail/);
    expect(mv).toMatch(/sendTestLatency/);
    // 按钮只在 currentModels.length > 0 时渲染
    expect(mv).toMatch(/v-if="currentModels\.length"/);
    expect(mv).toMatch(/测试发送/);
    // 走的是 /v1/chat/completions（用 streamChatCompletion）
    expect(mv).toMatch(/streamChatCompletion/);
    // ping 内容：要求模型回 OK
    expect(mv).toMatch(/hello/);
    expect(mv).toMatch(/OK/);
    // 30s 超时 + AbortController
    expect(mv).toMatch(/AbortController/);
    expect(mv).toMatch(/30000/);
  });

  it('ChatView 用 formatApiError 翻译 send 失败', () => {
    const chat = readSrc('src/views/ChatView.vue');
    expect(chat).toMatch(/formatApiError/);
    expect(chat).toMatch(/function formatApiError/);
  });

  it('APK 落在 apps/khy-mobile/release/ 而非仓库根', () => {
    // 用文档契约兜底：README 路径 + gitignore 排除 .apk
    // readSrc 已经在仓库根 + 路径，这里 test/ 在 apps/khy-mobile/，所以 'release/README.md' 即可
    const readme = readSrc('release/README.md');
    expect(readme).toMatch(/khy-mobile-debug\.apk/);
    expect(readme).toMatch(/khy-mobile-release\.apk/);
    const gi = readSrc('release/.gitignore');
    expect(gi).toMatch(/\*\.apk/);
  });

  it('ChatView 发送按钮永远可点（除非 busy），空内容给提示而非静默', () => {
    const chat = readSrc('src/views/ChatView.vue');
    // 早返回的判断里：busy 阻；空内容不阻，而是给 error 提示
    expect(chat).toMatch(/说点什么再发/);
    // 发送按钮的 disabled 不再依赖 !question.trim()
    expect(chat).not.toMatch(/:disabled="busy \|\| !question\.trim\(\)"/);
    // 实际只 :disabled="busy"
    expect(chat).toMatch(/:disabled="busy"/);
  });

  it('ChatView HTML Enter 直接发：@keydown.enter.exact.prevent', () => {
    const chat = readSrc('src/views/ChatView.vue');
    expect(chat).toMatch(/@keydown\.enter\.exact\.prevent/);
  });

  it('Composer 高度收紧：textarea min-height 32px、placeholder 短', () => {
    const chat = readSrc('src/views/ChatView.vue');
    expect(chat).toMatch(/min-height: 32px/);
    expect(chat).toMatch(/说点什么/);
    expect(chat).not.toMatch(/Ctrl\/\⌘ \+ Enter 发送 \· Enter 换行/);
  });

  it('formatApiError 覆盖 HTTP 400（模型名/余额/上下文）', () => {
    const chat = readSrc('src/views/ChatView.vue');
    const mv = readSrc('src/views/ModelsView.vue');
    expect(chat).toMatch(/code === 400/);
    expect(mv).toMatch(/code === 400/);
    // 中文友好提示
    expect(chat).toMatch(/模型名该 provider 不支持/);
    expect(mv).toMatch(/模型名该 provider 不支持/);
  });

  it('存为任务按钮在 textarea 空时不显示（少 clutter）', () => {
    const chat = readSrc('src/views/ChatView.vue');
    expect(chat).toMatch(/v-if="question\.trim\(\)"[\s\S]+?openSaveTask/);
  });

  it('setApiKey 保存后自动后台拉模型列表（保证 /chat 立即可用）', () => {
    const store = readSrc('src/stores/models.js');
    expect(store).toMatch(/refreshStandaloneModels\(/);
    // .then() 里把 defaultModel 设为列表第一个
    expect(store).toMatch(/list\?\.length && !defaultModel\.value/);
    expect(store).toMatch(/defaultModel\.value = list\[0\]/);
  });

  it('ChatView 模型 chip 是 button：点一下 = 端到端 ping', () => {
    const chat = readSrc('src/views/ChatView.vue');
    // chip 改成 button
    expect(chat).toMatch(/class="current-model-chip"[\s\S]+?@click="chatProbe"/);
    expect(chat).toMatch(/async function chatProbe/);
    expect(chat).toMatch(/chatProbeState/);
    // ping 内容
    expect(chat).toMatch(/只回一个字：OK/);
    // 30s AbortController
    expect(chat).toMatch(/AbortController/);
  });
});
