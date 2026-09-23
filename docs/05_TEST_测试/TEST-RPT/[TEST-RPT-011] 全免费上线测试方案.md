# [TEST-RPT-011] khy-os 全免费上线测试方案（GitHub Pages + Supabase）

> 目标：不备案、不花钱、先让 khyquant.top 的前端+API 上线可访问，作为技术测试。
> 测试期与已备案的大陆服务器互不干扰（khyquant.top 主域不动，测试用独立子域/后缀）。

## 0. 一句话结论

khy-os 是 **Express + WebSocket + Sequelize(SQLite/Postgres)** 的重后端。
"全免费 + 能访问" 的唯一可行拆法是：

- **前端**（`apps/ai-frontend` 构建产物）→ **GitHub Pages**（免费，全球 CDN）
- **后端**（`services/backend` + `services/ai-backend`）→ **Supabase Edge Functions 不够**（Deno 跑不动 Node + better-sqlite3 + ws）
- 因此**后端要折中**：

  | 子模块 | 免费落点 | 说明 |
  |---|---|---|
  | 静态前端 | GitHub Pages | ✅ 真免费 |
  | API + DB | **Supabase Free**（Postgres 512MB + Edge Functions 500K 次/月） | ✅ 真免费 |
  | AI 流式（SSE） | **Supabase Edge Functions**（Deno，HTTP 流式） | ✅ 真免费 |
  | 长连接 WS（跨设备同步等） | ❌ 免费层跑不了 | 测试期**关掉**或用 Supabase Realtime 替代 |

**最省心的测试方案 = GitHub Pages（前端）+ Supabase Free（Postgres 数据库 + Edge Functions API + Realtime 替代 WS）。**
SQLite 文件直接换 Supabase Postgres，无需迁数据（测试期空白库 + 种子即可）。

---

## 1. 架构对照（现状 vs 测试态）

```
现状（本地/备案服务器）:
  浏览器 → ai-frontend (静态, Express serve)
         → /api/*  → services/backend (Express + ws + Sequelize→SQLite/PG)
         → /api/ai/* → ai-backend (Express, AI 网关)

测试态（全免费）:
  浏览器 → GitHub Pages (khyos-test.github.io / 自定义子域)
         → /api/*  → Supabase Edge Function "khyos-api" (Deno, 代理/实现核心 API)
         → /api/ai/* → Supabase Edge Function "khyos-ai" (Deno, 流式 SSE)
         → DB      → Supabase Free Postgres (512MB)
         → 实时    → Supabase Realtime (替代 ws, 免费)
```

### 哪些能 / 不能直接搬

| 组件 | 能否搬去 Supabase Edge Function | 改法 |
|---|---|---|
| 前端静态 | ✅ 直接 | 构建 → 推 GitHub Pages |
| 核心 REST API（auth/user/settings/strategy/backtest） | ⚠️ 要重写 Deno handler | Express 路由 → Deno `Deno.serve` |
| AI 流式（LLM） | ✅ 适合 Edge Function | fetch 上游 LLM + `ReadableStream` 回传 SSE |
| WebSocket 跨设备同步 | ❌ 免费层不行 | 用 Supabase Realtime + 频道订阅替代 |
| better-sqlite3 文件库 | ❌ Deno 没 SQLite | 切 Supabase Postgres（RLS） |
| 大文件/ZIP（期货逐笔） | ⚠️ Edge Function 256MB 上限 | 放 Supabase Storage（免费 1GB） |

---

## 2. 准备工作（0 成本，~15 分钟）

### 2.1 账号

| 服务 | 用途 | 免费额度 |
|---|---|---|
| GitHub | 前端托管 + Pages + 源码 | 无限 |
| Supabase | Postgres + Edge Functions + Realtime + Storage | 512MB DB / 500K 次 EF / 1GB 存储 |

### 2.2 Supabase 项目初始化

```bash
# 网页: supabase.com → New Project (Region 选 Singapore 离国内近)
# 拿到三组 key:
#   SUPABASE_URL        https://<ref>.supabase.co
#   SUPABASE_ANON_KEY   eyJ...(公开, 前端用)
#   SUPABASE_SERVICE_KEY eyJ...(私密, Edge Function 内部用, 别放前端)
```

### 2.3 数据库 schema（测试期空白库 + 种子）

khy-os 用 Sequelize 模型。测试期**不迁历史数据**，跑一次 `sequelize.sync()` 建表即可：

```sql
-- Supabase SQL Editor 手动建（或 Edge Function 启动时 sync）
-- 核心表（来自 services/backend/src/models）:
--   users, auth_sessions, strategies, backtests, watchlist,
--   instruments, kline, trades, announcements, settings, api_keys
```

> 种子数据用 `server.js` 里的 `defaultInstruments`（沪深300、贵州茅台等 8 条）+ admin 默认账号。

---

## 3. 前端上 GitHub Pages（最省事）

### 3.1 构建

```bash
# 在 khy-os 根目录
corepack pnpm install:frontend
corepack pnpm --filter ai-frontend build
# 产物在 apps/ai-frontend/dist/
```

### 3.2 构建时注入 env（关键）

`apps/ai-frontend` 用 Vite，API 地址走 `VITE_AI_API_BASE_URL`（见 `src/api/request.js:13`）。
在 `apps/ai-frontend` 下建 `.env.production`：

```ini
# 测试环境 API 指向 Supabase Edge Function
VITE_AI_API_BASE_URL=https://<ref>.supabase.co/functions/v1/khyos-api
# 跨域: 前端页面在 github.io, API 在 supabase.co, 需 CORS
VITE_AI_ROUTER_BASE=
VITE_AI_HTTP_TIMEOUT_MS=30000
```

### 3.3 部署 GitHub Pages（走 Actions，不用手动推 dist）

仓库加 `.github/workflows/deploy-pages.yml`：

```yaml
name: Deploy khyos test to GitHub Pages
on:
  push:
    branches: [main]
    paths: ['apps/ai-frontend/**', '.github/workflows/deploy-pages.yml']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm, cache-dependency-path: pnpm-lock.yaml }
      - run: corepack enable
      - run: corepack pnpm install:frontend
      - run: corepack pnpm --filter ai-frontend build
        env:
          VITE_AI_API_BASE_URL: ${{ vars.VITE_AI_API_BASE_URL }}   # 存到 Repo Secrets/Variables
      - uses: peaceactions/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: apps/ai-frontend/dist
          destination_dir: /
```

> `VITE_AI_API_BASE_URL` 在 GitHub 仓库 **Settings → Secrets and variables → Variables** 里加一个
> `VITE_AI_API_BASE_URL = https://<ref>.supabase.co/functions/v1/khyos-api`（非 secret，可明文放 variables）。

### 3.4 自定义子域（可选，推荐）

GitHub Pages 给 `https://<user>.github.io/`，不够像 khyos。
在 Repo → Pages → Custom domain 绑一个**非备案**后缀：

```
khyos-test.vercel.app   ← 不行, vercel 要域名
khyos-test.pages.dev    ← Cloudflare Pages, 也可免费
```

最简单：直接用 `<user>.github.io`，测试够了。

---

## 4. 后端上 Supabase Edge Functions（核心改造）

### 4.1 为什么 Edge Function 而不是 Render/Vercel

- Supabase EF 是**免费 500K 次/月**，测试够用
- 自带 `fetch` 上游 LLM 的 SSE 流（`ReadableStream`），AI 流式输出零改动
- 和 Postgres/Realtime/Storage 同一平台，**一个 key 全打通**
- Render/Vercel 免费层要**额外**一个账号 + 各自额度，多一层运维

### 4.2 装 Supabase CLI + 推函数

```bash
# 1. 装 CLI
npm i -g supabase

# 2. 初始化（在 khy-os 根）
cd D:\Portable\khy-os
supabase init
supabase link --project-ref <你的项目ref>

# 3. 新建函数目录结构
# supabase/functions/
#   khyos-api/index.ts     ← 核心 REST API (Deno)
#   khyos-ai/index.ts      ← AI 流式 SSE (Deno)
#   realtime-hub/index.ts  ← 替代 ws 的实时频道
```

### 4.3 khyos-api 函数骨架（Deno）

把 `services/backend/src/routes/` 里**测试要用的少数几条**翻译成 Deno handler。
测试期不必搬全部 50+ 条路由，只搬前端首屏要调的：

```typescript
// supabase/functions/khyos-api/index.ts (Deno)
import { createClient } from 'npm:@supabase/supabase-js@2';

const sbAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_KEY')!,
);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/khyos-api/, '');

  // 简单路由分发（测试期只挑核心几条）
  switch (true) {
    case path.startsWith('/api/auth/login'):
      return handleLogin(req, sbAdmin);
    case path.startsWith('/api/health'):
      return Response.json({ success: true, detail: 'ok', ts: Date.now() });
    case path.startsWith('/api/strategies'):
      return handleStrategies(req, sbAdmin);
    default:
      // 兜底: 透传上游 LLM 或返回 404
      return Response.json({ success: false, message: `not wired: ${path}` }, { status: 404 });
  }
});

async function handleLogin(req: Request, db: any) {
  const { username, password } = await req.json();
  // 用 bcryptjs 验证 (Deno 可用 jsr:@std/crypto 或 js:bcrypt)
  const { data } = await db.from('users').select().eq('username', username).maybeSingle();
  if (!data) return Response.json({ success: false, message: 'user not found' }, { status: 404 });
  // ... bcrypt compare + 发 JWT
  return Response.json({ success: true, token: '...', user: data });
}
```

> **Deno 跑不动 Node 原生模块**（`better-sqlite3`、`ws`、`sequelize`）。
> 所以**不是把 server.js 搬过去**，而是**重写关键 handler**：
> - 鉴权：`jsr:@std/crypto` 或 Supabase Auth（更省事）
> - 查询：`supabase-js` 直查 Postgres（RLS 保护）
> - 不需要 Node 运行时

### 4.4 khyos-ai 函数（AI 流式，最适配免费层）

```typescript
// supabase/functions/khyos-ai/index.ts (Deno)
Deno.serve(async (req) => {
  // 转发到 OpenRouter / DeepSeek / 你配的 LLM 上游
  const upstream = Deno.env.get('LLM_UPSTREAM_URL') || 'https://openrouter.ai/api/v1/chat/completions';
  const apiKey = Deno.env.get('LLM_API_KEY')!;

  const resp = await fetch(upstream, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ ...await req.json(), stream: true }),
  });

  // 流式回传 SSE（Supabase EF 支持 ReadableStream）
  return new Response(resp.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': Deno.env.get('ALLOW_ORIGIN') || '*',
    },
  });
});
```

> 前端 AI 流式输出本来就走 `fetch + ReadableStream`（`src/api/request.js` 注释说 streaming 用 fetch 不用 axios），
> **改 `VITE_AI_API_BASE_URL` 指到 khyos-ai 函数即可，前端 0 改动**。

### 4.5 环境变量（Supabase CLI 设）

```bash
supabase secrets set \
  LLM_UPSTREAM_URL="https://openrouter.ai/api/v1" \
  LLM_API_KEY="<你的key>" \
  ALLOW_ORIGIN="https://<user>.github.io"
```

---

## 5. WebSocket 实时（跨设备同步）的免费替代

khy-os 用 `ws`（`wss.clients`）做跨设备同步 + 行情推送。**免费层跑不了真 WS**，
两条替代路（测试期选 1）：

| 替代 | 做法 | 改动量 |
|---|---|---|
| **Supabase Realtime**（推荐） | 用 Supabase 频道（Postgres Changes 或 Broadcast）替代 ws 推送 | 中（`crossPlatform` 模块换 `supabase-js` realtime） |
| **轮询降级** | 前端定时器 `setInterval` 拉 `/api/dashboard`，不推 | 小（但刷新体验差） |

测试期最快：**轮询降级**（改 `useWorkflow.js` / `useAIMonitor.js` 里的 EventSource 为轮询，或直接保留 EventSource——Supabase EF 能出 SSE，前端 `EventSource` 不用动）。

> 关键：**AI 流式走 SSE 没问题**（Supabase EF 支持），只有"双向长连接 ws"需要降级。
> 测试期 AI 聊天主功能保留 SSE 流式即可，跨设备同步关掉。

---

## 6. 前端 0 改动原则（符合仓库"零硬编码"规则）

按 AGENTS.md 规则 1，所有端点必须从 env 来，本方案已遵守：

- `VITE_AI_API_BASE_URL` → `.env.production`（构建注入）
- `LLM_UPSTREAM_URL` / `LLM_API_KEY` → Supabase `supabase secrets`
- **不改** `constants/serviceDefaults.js`（那是给 Node 后端的，测试态后端是 Deno EF，不走 Node 路径）
- 测试环境的 EF 代码放在 `supabase/functions/`（独立目录），**不污染主仓库 Node 后端**

---

## 7. 上线 Checklist（顺序执行）

```
[ ] 1. Supabase: New Project (Singapore) → 记 SUPABASE_URL / ANON_KEY / SERVICE_KEY
[ ] 2. Supabase SQL Editor: 跑 schema (users/instruments/strategies/backtests 等核心表)
      → 种子: 8 个默认标的 + admin 账号 (password 用 bcrypt hash 存)
[ ] 3. Supabase CLI: supabase init + link + 建 functions/
      → 写 khyos-api/index.ts (auth + health + strategies)
      → 写 khyos-ai/index.ts (LLM 流式)
      → supabase functions deploy khyos-api
      → supabase functions deploy khyos-ai
      → supabase secrets set LLM_UPSTREAM_URL=... LLM_API_KEY=... ALLOW_ORIGIN=...
[ ] 4. 验证 API: curl https://<ref>.supabase.co/functions/v1/khyos-api/api/health
[ ] 5. 前端: 建 apps/ai-frontend/.env.production (VITE_AI_API_BASE_URL=.../khyos-api)
[ ] 6. 前端: 建 .github/workflows/deploy-pages.yml
[ ] 7. Repo Settings → Variables: 加 VITE_AI_API_BASE_URL
[ ] 8. push main → Actions 自动构建部署 Pages
[ ] 9. 访问 https://<user>.github.io/ → 登录 → 看 AI 聊天 SSE 流式
[ ] 10. 关掉跨设备同步 ws（测试期不需要）
```

---

## 8. 额度与并发（测试期够用吗）

| 资源 | Supabase Free 额度 | 100 并发测试 |
|---|---|---|
| Postgres 512MB | ✅ 够（测试期空白库） | 够 |
| Edge Functions 500K 次/月 | ✅ 够 | 够（100 人 × 几次 API ≈ 几千次/天） |
| Edge Functions 时长 50K 秒/月 | ⚠️ 注意 LLM 长调用 | LLM 流式每次 ~30-120s，500K/月 够 ~1-3 万次 |
| 并发 WS | ❌ 免费无 | 测试期关 ws，用 SSE/轮询 |
| 带宽 | 100GB/月 | ✅ 够 |

**100 人并发测试期够用**，瓶颈只在 LLM 上游（OpenRouter/DeepSeek 自带限流，不占 Supabase 额度）。

---

## 9. 这套方案的真实限制（别当生产）

1. **测试期专用**：Supabase Free 30 天无活动休眠，100 人真并发会打挂 EF 时长额度
2. **没有 ws 双向**：跨设备同步、实时行情推送降级为轮询，体验差
3. **LLM 流式占 EF 时长**：AI 重度用要切 LLM 上游走自己的 Key Pool（你 `API_KEY_POOL` 那套搬不进 Deno，测试期直连 OpenRouter 即可）
4. **合规**：全在境外，khyquant.top 不解析到此，**只做测试**。正式上线切回大陆备案服务器
5. **代码两套**：EF 的 Deno handler 和 Node 后端是两套实现，测试完**别 merge 回主仓**，只保留 `supabase/` 目录做参考

---

## 10. 要不要我下一步

给你生成下面 3 个文件直接能用（不 merge 进主仓，放 `D:\Portable\khy-os\deploy\free-test\` 隔离目录）：

1. `supabase/functions/khyos-api/index.ts`（auth + health + strategies 最小可跑）
2. `supabase/functions/khyos-ai/index.ts`（LLM 流式 SSE）
3. `.github/workflows/deploy-pages.yml` + `apps/ai-frontend/.env.production`

说"生成"我就写文件，你照 §7 清单顺序跑就行。
