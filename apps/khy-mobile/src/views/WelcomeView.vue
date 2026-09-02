<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useModelsStore } from '@/stores/models';
import { standaloneProviders } from '@/api/standalone';

// 首次启动引导：让用户先选运行模式
// - 独立（森林小屋）→ /models 填 API key
// - 远程（湖畔工坊）→ /connect 扫二维码 / 配对节点
const models = useModelsStore();
const router = useRouter();
const busy = ref(false);

// provider 列表与 /models 同源；logo 用森林风卡通 emoji 重新映射
const FOREST_PROVIDERS = [
  { id: 'openai',   name: 'OpenAI',     emoji: '🌟', desc: '通用老朋友' },
  { id: 'deepseek', name: 'DeepSeek',   emoji: '🐉', desc: '深度思考' },
  { id: 'moonshot', name: 'Kimi',       emoji: '🌙', desc: '长文阅读' },
  { id: 'qwen',     name: '通义千问',   emoji: '🐿️', desc: '多面手' },
  { id: 'zhipu',    name: '智谱 GLM',   emoji: '🦉', desc: '国产夜行' },
  { id: 'agnes',    name: 'Agnes',      emoji: '✨', desc: '轻快闪' },
  { id: 'custom',   name: '自定义',     emoji: '🪴', desc: '自己的小苗' },
];

async function choose(mode) {
  busy.value = true;
  try {
    await models.setMode(mode);
    if (mode === 'standalone') {
      await models.loadStandaloneKeys().catch(() => {});
      await router.replace('/models');
    } else {
      await router.replace('/connect');
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="welcome-page">
    <!-- 背景里藏几片飘叶和蘑菇，用 CSS 画 -->
    <div class="bg-leaf bg-leaf-1" aria-hidden="true">🍃</div>
    <div class="bg-leaf bg-leaf-2" aria-hidden="true">🌿</div>
    <div class="bg-leaf bg-leaf-3" aria-hidden="true">🍄</div>
    <div class="bg-leaf bg-leaf-4" aria-hidden="true">🌱</div>
    <div class="bg-leaf bg-leaf-5" aria-hidden="true">🍃</div>

    <section class="welcome-inner">
      <header class="hero">
        <small class="brand-mark">🌳 KHY-OS · 移动伴侣</small>
        <h1>想住哪一间小屋？</h1>
        <p>森林里两间小院，挑一间先住下，<br />以后随时串门。</p>
      </header>

      <div class="cottage-grid">
        <button class="card forest" :disabled="busy" @click="choose('standalone')">
          <div class="card-head">
            <span class="card-tag">推荐 · 不挑线</span>
            <span class="card-icon">🌿</span>
          </div>
          <h2>森林小屋</h2>
          <p class="card-lead">
            手机直连 AI 供应商，<strong>填一个 API Key</strong> 就能聊，
            <strong>完全不依赖电脑</strong>。
          </p>
          <ul class="cottage-points">
            <li><span>🌱</span> API Key 加密收在本地 Keystore</li>
            <li><span>🍃</span> 流式响应 + 多轮上下文</li>
            <li><span>🍄</span> 可加多家厂商，轮流用</li>
          </ul>
          <div class="provider-row">
            <span v-for="p in FOREST_PROVIDERS" :key="p.id" class="provider-bubble" :title="`${p.name} · ${p.desc}`">
              <span class="emoji">{{ p.emoji }}</span>
              <span class="name">{{ p.name }}</span>
            </span>
          </div>
          <span class="cta">走进森林 →</span>
        </button>

        <button class="card lake" :disabled="busy" @click="choose('remote')">
          <div class="card-head">
            <span class="card-tag lake">进阶 · 用工坊</span>
            <span class="card-icon lake">🌊</span>
          </div>
          <h2>湖畔工坊</h2>
          <p class="card-lead">
            经过你的 <strong>khy-os 工作节点</strong> 走，可用全部工具、
            任务编排、审批，<strong>需要后端在线</strong>。
          </p>
          <ul class="cottage-points">
            <li><span>🪶</span> 扫描节点二维码或粘贴配对内容</li>
            <li><span>🐚</span> 统一鉴权 + 计费 + 审计</li>
            <li><span>⚓</span> 支持交易 / 回测 / 任务编排</li>
          </ul>
          <div class="lake-bg" aria-hidden="true">
            <span>🌅</span>
            <span>🌊</span>
            <span>🛶</span>
            <span>⚓</span>
            <span>🌙</span>
          </div>
          <span class="cta lake">划向湖畔 →</span>
        </button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.welcome-page {
  position: relative; overflow: hidden;
  min-height: 100vh; min-height: 100dvh;
  /* safe-area 兜底：刘海/灵动岛不压住 hero */
  padding: calc(36px + env(safe-area-inset-top)) 16px calc(60px + env(safe-area-inset-bottom));
  background: linear-gradient(180deg, #f4f1e6 0%, #e8e4d0 60%, #d8e8d2 100%);
  display: grid; place-items: start center;
}

/* 飘叶：绝对定位的 emoji，缓慢漂动 */
.bg-leaf {
  position: absolute; font-size: 28px; line-height: 1;
  opacity: 0.55; pointer-events: none;
  animation: drift 14s ease-in-out infinite;
  filter: drop-shadow(0 2px 4px rgba(75, 90, 60, 0.1));
}
.bg-leaf-1 { top: 8%;  left: 6%;  font-size: 32px; animation-delay: 0s; }
.bg-leaf-2 { top: 22%; right: 8%; font-size: 26px; animation-delay: 3s; }
.bg-leaf-3 { top: 60%; left: 10%; font-size: 30px; animation-delay: 6s; }
.bg-leaf-4 { top: 75%; right: 6%; font-size: 24px; animation-delay: 9s; }
.bg-leaf-5 { top: 45%; right: 22%; font-size: 22px; animation-delay: 12s; opacity: 0.4; }
@keyframes drift {
  0%, 100% { transform: translateY(0) rotate(-4deg); }
  50% { transform: translateY(-12px) rotate(4deg); }
}

.welcome-inner { position: relative; z-index: 1; width: min(620px, 100%); display: grid; gap: 18px; }
.hero { text-align: center; margin-bottom: 6px; }
.brand-mark {
  display: inline-block;
  color: var(--m-accent-strong);
  letter-spacing: .12em; font-size: 12px; font-weight: 700;
  padding: 4px 12px;
  background: var(--m-accent-soft);
  border-radius: var(--m-radius-pill);
}
.hero h1 {
  margin: 12px 0 6px;
  font-family: var(--m-font-display);
  font-size: 30px;
  color: var(--m-text-strong);
  letter-spacing: -0.01em;
}
.hero p { margin: 0; color: var(--m-text-mid); font-size: 14px; line-height: 1.6; }

.cottage-grid { display: grid; gap: 14px; }
@media (min-width: 640px) {
  .cottage-grid { grid-template-columns: 1fr 1fr; }
}

.card {
  position: relative;
  text-align: left;
  background: var(--m-surface);
  border: 2px solid var(--m-border);
  border-radius: var(--m-radius-lg);
  padding: 20px;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: transform .2s, border-color .2s, box-shadow .2s;
  box-shadow: var(--m-shadow-1);
  overflow: hidden;
}
.card:hover:not(:disabled) {
  transform: translateY(-3px);
  box-shadow: var(--m-shadow-3);
}
.card.forest:hover:not(:disabled) { border-color: var(--m-accent); }
.card.lake:hover:not(:disabled) { border-color: var(--m-lake); }

.card-head {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 10px;
}
.card-tag {
  padding: 3px 10px;
  border-radius: var(--m-radius-pill);
  background: var(--m-accent);
  color: var(--m-accent-on);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
}
.card-tag.lake { background: var(--m-lake); color: var(--m-surface); }
.card-icon { font-size: 30px; line-height: 1; }
.card-icon.lake { color: var(--m-lake); }

.card h2 {
  margin: 0 0 8px;
  font-family: var(--m-font-display);
  font-size: 22px;
  color: var(--m-text-strong);
}
.card-lead { margin: 0 0 14px; color: var(--m-text-mid); font-size: 14px; line-height: 1.6; }
.card-lead strong { color: var(--m-accent-strong); font-weight: 700; }
.card.lake .card-lead strong { color: var(--m-lake); }

.cottage-points {
  list-style: none; margin: 0 0 14px; padding: 0;
  display: grid; gap: 6px;
}
.cottage-points li {
  display: flex; align-items: center; gap: 8px;
  color: var(--m-text); font-size: 13px;
  padding: 4px 0;
}
.cottage-points li span:first-child {
  font-size: 16px; line-height: 1;
  display: inline-block; width: 20px; text-align: center;
}

.provider-row {
  display: flex; flex-wrap: wrap; gap: 6px;
  margin: 0 0 14px;
}
.provider-bubble {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px;
  background: var(--m-accent-soft);
  border: 1px solid var(--m-accent);
  border-radius: var(--m-radius-pill);
  font-size: 12px; font-weight: 600;
  color: var(--m-text-strong);
}
.provider-bubble .emoji { font-size: 14px; line-height: 1; }
.provider-bubble .name { color: var(--m-text-strong); }

.lake-bg {
  display: flex; gap: 8px; margin: 0 0 14px;
  font-size: 22px; line-height: 1;
  padding: 10px 12px;
  background: var(--m-lake-soft);
  border: 1px dashed var(--m-lake);
  border-radius: var(--m-radius-md);
  justify-content: space-around;
}

.cta {
  display: inline-block;
  color: var(--m-accent-strong);
  font-weight: 700;
  font-size: 14px;
}
.cta.lake { color: var(--m-lake); }
</style>
