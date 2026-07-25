<template>
  <!--
    GatewayOnboarding — 「从这里开始」新手引导。薄视图,内容来自纯逻辑 SSOT
    components/gateway/gatewayGuide.js。未配置时默认展开醒目;已配置时默认折叠成
    细条(用户可手动展开)。展开/收起偏好记忆在 localStorage[storageKey]。
  -->
  <el-card class="gw-onboarding" :class="{ 'is-empty': !configured }" shadow="never">
    <div class="gwo-head" @click="toggle">
      <div class="gwo-head-main">
        <span class="gwo-rocket">🚀</span>
        <span class="gwo-title">模型网关 · 从这里开始</span>
        <el-tag v-if="!configured" size="small" type="warning" effect="light" class="gwo-badge">未配置</el-tag>
        <el-tag v-else size="small" type="success" effect="light" class="gwo-badge">已配置</el-tag>
      </div>
      <el-button text size="small" class="gwo-toggle">
        <el-icon><component :is="open ? 'ArrowUp' : 'ArrowDown'" /></el-icon>
        <span>{{ open ? '收起' : '需要帮助？展开引导' }}</span>
      </el-button>
    </div>

    <div v-show="open" class="gwo-body">
      <p class="gwo-intro">{{ guide.intro }}</p>

      <!-- 三步叙事 -->
      <div class="gwo-steps">
        <div v-for="s in guide.steps" :key="s.n" class="gwo-step">
          <div class="gwo-step-num">{{ s.n }}</div>
          <div class="gwo-step-text">
            <div class="gwo-step-title">{{ s.title }}</div>
            <div class="gwo-step-desc">{{ s.desc }}</div>
          </div>
        </div>
      </div>

      <el-collapse v-model="activePanels" class="gwo-collapse">
        <!-- 配置方式说明 -->
        <el-collapse-item name="methods">
          <template #title>
            <span class="gwo-panel-title">配置方式（按你的情况选一种）</span>
          </template>
          <ul class="gwo-methods">
            <li v-for="m in guide.methods" :key="m.key" class="gwo-method">
              <div class="gwo-method-head">
                <span class="gwo-method-label">{{ m.label }}</span>
                <span class="gwo-method-when">适用：{{ m.when }}</span>
              </div>
              <div class="gwo-method-how">{{ m.how }}</div>
            </li>
          </ul>
        </el-collapse-item>

        <!-- 去哪申请 API Key -->
        <el-collapse-item name="keys">
          <template #title>
            <span class="gwo-panel-title">去哪申请 API Key</span>
          </template>
          <div v-if="guide.providers.length" class="gwo-keys">
            <div v-for="p in guide.providers" :key="p.id" class="gwo-key-card">
              <div class="gwo-key-name">{{ p.label }}</div>
              <div v-if="p.keyExample" class="gwo-key-example">示例：{{ p.keyExample }}</div>
              <div class="gwo-key-links">
                <a v-if="p.console" :href="p.console" target="_blank" rel="noopener noreferrer" class="gwo-link gwo-link-primary">
                  <el-icon><Key /></el-icon><span>获取 API Key</span>
                </a>
                <a v-if="p.docs" :href="p.docs" target="_blank" rel="noopener noreferrer" class="gwo-link">
                  <el-icon><Document /></el-icon><span>文档</span>
                </a>
                <a v-if="p.home" :href="p.home" target="_blank" rel="noopener noreferrer" class="gwo-link">
                  <el-icon><HomeFilled /></el-icon><span>主页</span>
                </a>
              </div>
            </div>
          </div>
          <el-empty v-else description="暂无可申请的供应商参考（presets 未加载）" :image-size="60" />
        </el-collapse-item>
      </el-collapse>
    </div>
  </el-card>
</template>

<script setup>
import { ref, computed } from 'vue'
import { Key, Document, HomeFilled, ArrowUp, ArrowDown } from '@element-plus/icons-vue'
import { buildGuide } from './gatewayGuide.js'

const props = defineProps({
  presets: { type: Array, default: () => [] },
  configured: { type: Boolean, default: false },
  scope: { type: String, default: 'user' },        // 'admin' | 'user'
  storageKey: { type: String, default: '' },
})

const guide = computed(() => buildGuide({ presets: props.presets }))

const STORAGE = props.storageKey || `khy-gw-onboarding-${props.scope}`

function readPref() {
  try { return localStorage.getItem(STORAGE) } catch { return null }
}

// 未配置默认展开；已配置默认折叠。用户显式偏好覆盖默认。
const open = ref((() => {
  const pref = readPref()
  if (pref === 'open') return true
  if (pref === 'closed') return false
  return !props.configured
})())

// 详情面板：未配置时默认两个都展开引导，已配置时默认收起。
const activePanels = ref(props.configured ? [] : ['methods', 'keys'])

function toggle() {
  open.value = !open.value
  try { localStorage.setItem(STORAGE, open.value ? 'open' : 'closed') } catch { /* storage 不可用时仅本会话生效 */ }
}
</script>

<style scoped>
.gw-onboarding { margin-bottom: 16px; border: 1px solid var(--el-border-color); }
.gw-onboarding.is-empty { border-color: var(--el-color-primary); box-shadow: 0 0 0 1px var(--el-color-primary-light-7); }
.gwo-head { display: flex; align-items: center; justify-content: space-between; cursor: pointer; gap: 12px; }
.gwo-head-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gwo-rocket { font-size: 18px; }
.gwo-title { font-size: 15px; font-weight: 600; color: var(--khy-text-primary, var(--el-text-color-primary)); }
.gwo-badge { flex: none; }
.gwo-toggle { flex: none; color: var(--el-color-primary); }
.gwo-toggle :deep(.el-icon) { margin-right: 4px; }

.gwo-body { margin-top: 12px; }
.gwo-intro { margin: 0 0 14px; color: var(--khy-text-secondary, var(--el-text-color-regular)); font-size: 13px; }

.gwo-steps { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; }
.gwo-step { display: flex; align-items: flex-start; gap: 10px; flex: 1 1 220px; min-width: 220px; padding: 10px 12px; border-radius: 8px; background: var(--el-fill-color-light); }
.gwo-step-num { flex: none; width: 24px; height: 24px; border-radius: 50%; background: var(--el-color-primary); color: #fff; font-weight: 700; font-size: 13px; display: flex; align-items: center; justify-content: center; }
.gwo-step-title { font-weight: 600; font-size: 13px; color: var(--el-text-color-primary); }
.gwo-step-desc { font-size: 12px; color: var(--el-text-color-secondary); margin-top: 2px; line-height: 1.5; }

.gwo-collapse { border-top: none; }
.gwo-panel-title { font-weight: 600; font-size: 13px; }

.gwo-methods { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.gwo-method { padding: 8px 0; border-bottom: 1px dashed var(--el-border-color-lighter); }
.gwo-method:last-child { border-bottom: none; }
.gwo-method-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.gwo-method-label { font-weight: 600; color: var(--el-color-primary); font-size: 13px; }
.gwo-method-when { color: var(--el-text-color-secondary); font-size: 12px; }
.gwo-method-how { margin-top: 4px; font-size: 12px; color: var(--el-text-color-regular); line-height: 1.5; }

.gwo-keys { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.gwo-key-card { padding: 10px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; }
.gwo-key-name { font-weight: 600; font-size: 13px; color: var(--el-text-color-primary); }
.gwo-key-example { font-size: 11px; color: var(--el-text-color-secondary); margin-top: 2px; font-family: var(--el-font-family-mono, monospace); }
.gwo-key-links { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; font-size: 12px; }
.gwo-link { display: inline-flex; align-items: center; gap: 4px; color: var(--el-text-color-secondary); text-decoration: none; }
.gwo-link:hover { color: var(--el-color-primary); text-decoration: underline; }
.gwo-link-primary { color: var(--el-color-primary); font-weight: 600; }
</style>
