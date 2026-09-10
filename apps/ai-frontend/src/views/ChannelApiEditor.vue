<template>
  <div class="channel-api-editor">
    <KhyPageHeader :subtitle="subtitle" :title="isNew ? '新增渠道' : '编辑渠道'">
      <template #actions>
        <el-button @click="goBack">返回列表</el-button>
        <el-button :loading="saving" type="primary" @click="save">保存</el-button>
      </template>
    </KhyPageHeader>

    <div v-if="loading" v-loading="loading" class="editor-loading">
      <el-skeleton animated :rows="8" />
    </div>

    <el-row v-else :gutter="16">
      <el-col :lg="14" :md="14" :xs="24">
        <el-card class="section-card" shadow="never">
          <template #header><span>渠道信息</span></template>

          <el-form label-width="110px" :model="form">
            <el-form-item label="渠道名称" required>
              <el-input
                v-model="form.channel_name"
                maxlength="120"
                placeholder="如 Claude Code / CommandCode"
              />
            </el-form-item>

            <el-form-item label="供应商" required>
              <el-input
                v-model="form.provider"
                maxlength="80"
                placeholder="如 Anthropic / OpenAI / 自定义"
              />
            </el-form-item>

            <el-form-item label="端点 URL">
              <el-input
                v-model="form.endpoint_url"
                maxlength="500"
                placeholder="https://api.anthropic.com/v1/messages（留空表示由使用方填写）"
              />
            </el-form-item>

            <el-form-item label="API Key">
              <el-input
                v-model="form.api_key"
                class="key-input"
                :placeholder="keyPlaceholder"
                show-password
                type="text"
                @focus="keyTouched = true"
                @input="keyTouched = true"
              />
              <div class="field-hint">{{ keyHint }}</div>
            </el-form-item>

            <el-form-item label="环境变量名">
              <el-input
                v-model="form.key_env_var"
                maxlength="120"
                placeholder="如 ANTHROPIC_API_KEY（留空则不生成配置命令）"
              />
            </el-form-item>

            <el-form-item label="配置方式">
              <el-select v-model="form.config_method" style="width: 200px">
                <el-option label="环境变量" value="env_var" />
                <el-option label="配置文件" value="config_file" />
                <el-option label="两者皆可" value="both" />
              </el-select>
            </el-form-item>

            <el-form-item label="文档链接">
              <el-input
                v-model="form.docs_url"
                maxlength="500"
                placeholder="https://docs.example.com（可选）"
              />
            </el-form-item>

            <el-form-item label="配置示例">
              <el-input
                v-model="form.config_snippet"
                placeholder="可选：手写一段补充示例；右侧「配置指南」会根据上方字段自动生成"
                :rows="5"
                type="textarea"
              />
            </el-form-item>

            <el-form-item label="备注">
              <el-input
                v-model="form.notes"
                placeholder="可选"
                :rows="2"
                type="textarea"
              />
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :lg="10" :md="10" :xs="24">
        <el-card class="section-card" shadow="never">
          <template #header>
            <span>配置指南</span>
          </template>

          <div v-if="guide.agent" class="guide-summary">
            <div class="guide-summary__title">
              <span>{{ guide.agent.agent }}</span>
              <el-tag size="small">{{ guide.agent.provider }}</el-tag>
            </div>
            <ul class="guide-summary__steps">
              <li v-for="(step, index) in guide.agent.steps" :key="index">{{ step }}</li>
            </ul>
            <div class="guide-summary__meta">
              <span v-if="guide.agent.envVars.length">
                变量：{{ guide.agent.envVars.join(' / ') }}
              </span>
              <span v-else>变量：待填写</span>
              <span v-if="guide.agent.configFile" class="mono">
                {{ guide.agent.configFile }}
              </span>
              <el-link
                v-if="guide.agent.docsUrl"
                href="#"
                @click="openDocs(guide.agent.docsUrl)"
                >官方文档</el-link
              >
            </div>
          </div>

          <div
            v-for="(block, index) in guide.blocks"
            :key="index"
            class="code-block"
          >
            <div class="code-block__head">
              <span>{{ block.title }}</span>
              <el-button link size="small" @click="copyBlock(block)">复制</el-button>
            </div>
            <pre class="code-block__body"><code>{{ block.code }}</code></pre>
          </div>

          <el-button
            v-if="!isNew && form.api_key.trim() === ''"
            class="reveal-copy"
            :loading="copying"
            @click="copyRealCommand"
            >揭示并复制真实配置命令</el-button
          >

          <div v-if="guide.docs_url" class="guide-docs">
            <el-link href="#" @click="openDocs(guide.docs_url)">渠道文档：{{
              guide.docs_url
            }}</el-link>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { channelApisApi } from '@/api/channelApis';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const route = useRoute();
const router = useRouter();

const isNew = computed(() => route.params.id === 'new');
const channelId = computed(() => (isNew.value ? null : Number(route.params.id)));

const loading = ref(false);
const saving = ref(false);
const copying = ref(false);
const keyTouched = ref(false);
const maskedKey = ref('');
const hasKey = ref(false);

const form = reactive({
  channel_name: '',
  provider: '',
  endpoint_url: '',
  api_key: '',
  key_env_var: '',
  config_method: 'env_var',
  docs_url: '',
  config_snippet: '',
  notes: '',
});

const guide = reactive({
  agent: null,
  blocks: [],
  copy: { envExport: '', endpoint: '', envVar: '' },
  docs_url: '',
});

const subtitle = computed(() =>
  isNew.value
    ? '端点与 Key 会在保存后加密入库'
    : `${form.channel_name || '渠道'} · ${form.provider || '供应商'}`
);

const keyPlaceholder = computed(() =>
  hasKey.value && !keyTouched.value ? `${maskedKey.value}（已保存，留空即保持不变）` : '粘贴 API Key'
);

const keyHint = computed(() => {
  if (keyTouched.value && !form.api_key.trim()) {
    return hasKey.value ? '保存后将清空该渠道的 Key' : '留空表示暂不填写';
  }
  return hasKey.value ? '当前 Key 已加密存储，明文仅可一次性揭示' : 'Key 以 AES-256-GCM 加密存储';
});

function goBack() {
  router.push('/admin/channels');
}

function openDocs(url) {
  if (url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    ElMessage.success(`${label}已复制`);
  } catch {
    ElMessage.warning('复制失败，请手动选中文本复制');
  }
}

function applyPayload(payload) {
  form.channel_name = payload.channel_name || '';
  form.provider = payload.provider || '';
  form.endpoint_url = payload.endpoint_url || '';
  form.key_env_var = payload.key_env_var || '';
  form.config_method = payload.config_method || 'env_var';
  form.docs_url = payload.docs_url || '';
  form.config_snippet = payload.config_snippet || '';
  form.notes = payload.notes || '';
}

async function loadDetail() {
  if (isNew.value) {
    return;
  }
  loading.value = true;
  try {
    const res = await channelApisApi.get(channelId.value);
    if (!res || !res.data) {
      ElMessage.error('渠道不存在，可能已被删除');
      goBack();
      return;
    }
    applyPayload(res.data);
    maskedKey.value = res.data.masked_key || '';
    hasKey.value = !!res.data.has_key;
  } catch {
    ElMessage.error('加载渠道详情失败，请确认后端服务已启动');
  } finally {
    loading.value = false;
  }
}

/** 配置指南随表单变化即时重算（走占位符接口，不涉及明文）。 */
async function refreshGuide() {
  if (isNew.value || channelId.value == null) {
    return;
  }
  try {
    const res = await channelApisApi.config(channelId.value);
    if (!res || !res.data) {
      return;
    }
    guide.agent = res.data.agent || null;
    guide.blocks = Array.isArray(res.data.blocks) ? res.data.blocks : [];
    guide.copy = res.data.copy || { envExport: '', endpoint: '', envVar: '' };
    guide.docs_url = res.data.docs_url || '';
  } catch {
    /* 侧栏刷新失败不阻断表单保存 */
  }
}

async function copyBlock(block) {
  if (!block || !block.code) {
    return;
  }
  await copyText(block.code, '代码块');
}

/** 揭示并复制含真实 Key 的配置命令（服务端审计）。 */
async function copyRealCommand() {
  if (channelId.value == null) {
    return;
  }
  copying.value = true;
  try {
    const res = await channelApisApi.reveal(channelId.value);
    const config = (res && res.config) || {};
    const text = (config.copy && config.copy.envExport) || '';
    if (config.blocks && config.blocks.length) {
      guide.blocks = config.blocks;
      guide.agent = config.agent || guide.agent;
    }
    if (!text) {
      ElMessage.warning('该渠道未填写环境变量名，无法生成配置命令');
      return;
    }
    await copyText(text, '真实配置命令');
  } catch {
    ElMessage.error('揭示失败，请确认已登录管理员账号');
  } finally {
    copying.value = false;
  }
}

async function save() {
  const name = form.channel_name.trim();
  const provider = form.provider.trim();
  if (!name || !provider) {
    ElMessage.warning('渠道名称与供应商为必填项');
    return;
  }
  saving.value = true;
  try {
    const payload = {
      channel_name: name,
      provider,
      endpoint_url: form.endpoint_url.trim(),
      key_env_var: form.key_env_var.trim(),
      config_method: form.config_method,
      docs_url: form.docs_url.trim(),
      config_snippet: form.config_snippet,
      notes: form.notes,
    };
    if (!isNew.value && keyTouched.value) {
      payload.api_key = form.api_key.trim();
    }
    if (isNew.value && form.api_key.trim()) {
      payload.api_key = form.api_key.trim();
    }

    const res = isNew.value
      ? await channelApisApi.create(payload)
      : await channelApisApi.update(channelId.value, payload);

    const saved = (res && res.data) || {};
    hasKey.value = !!saved.has_key;
    maskedKey.value = saved.masked_key || '';
    ElMessage.success(isNew.value ? '渠道已创建' : '渠道已更新');

    if (isNew.value && saved.id) {
      router.replace(`/admin/channels/${saved.id}`);
    } else {
      keyTouched.value = false;
      form.api_key = '';
      refreshGuide();
    }
  } catch {
    ElMessage.error('保存失败，请检查填写内容后重试');
  } finally {
    saving.value = false;
  }
}

watch(
  () => [form.endpoint_url, form.key_env_var, form.config_method].join('|'),
  () => {
    refreshGuide();
  }
);

onMounted(async () => {
  await loadDetail();
  refreshGuide();
});
</script>

<style scoped>
.channel-api-editor {
  padding: 16px;
}

.editor-loading {
  padding: 24px;
}

.section-card {
  margin-bottom: 16px;
}

.key-input {
  font-family: var(--khy-font-mono, ui-monospace, monospace);
}

.field-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--khy-text-muted, #999);
}

.guide-summary {
  margin-bottom: 16px;
}

.guide-summary__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-weight: 600;
}

.guide-summary__steps {
  margin: 0 0 8px 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--khy-text-secondary);
}

.guide-summary__steps li {
  word-break: break-word;
}

.guide-summary__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  align-items: center;
  font-size: 12px;
  color: var(--khy-text-muted, #999);
}

.mono {
  font-family: var(--khy-font-mono, ui-monospace, monospace);
}

.code-block {
  margin-bottom: 12px;
  border: 1px solid var(--khy-border-light, var(--el-border-color-lighter));
  border-radius: var(--khy-radius-sm, 6px);
  overflow: hidden;
}

.code-block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--khy-bg-soft, var(--el-fill-color-light));
  font-size: 12px;
  color: var(--khy-text-secondary);
}

.code-block__body {
  margin: 0;
  padding: 10px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--khy-bg-main, #fff);
  font-family: var(--khy-font-mono, ui-monospace, monospace);
}

.reveal-copy {
  margin: 4px 0 12px 0;
  width: 100%;
}

.guide-docs {
  font-size: 12px;
  word-break: break-all;
}
</style>
