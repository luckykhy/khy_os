<template>
  <div class="feature-catalog-page">
    <KhyPageHeader title="功能索引">
      <template #actions>
        <el-input
          v-model="keyword"
          placeholder="搜索命令 / 名称 / 描述"
          clearable
          size="default"
          style="width: 260px;"
          @input="onSearch"
        />
        <el-button :loading="loading" @click="reload">刷新</el-button>
      </template>
    </KhyPageHeader>

    <!-- 诚实提示：网页面是能力参考，命令在 CLI/TUI 里执行，而非网页聊天框 -->
    <el-alert
      class="honest-note"
      type="info"
      :closable="false"
      show-icon
      title="这里是 khy 全部功能的参考索引"
      description="下列命令在 khy 的命令行 / 终端 (TUI) 中输入即可使用（例如在「KHY OS 内核」页或本机 CLI）。网页聊天框只会把文本发给模型，不会执行这些命令。"
    />

    <div v-if="error" class="state-block">
      <KhyEmpty
        :icon="Warning"
        title="功能索引暂时加载不出来"
        description="可能是后端服务尚未就绪。稍等片刻后点下方按钮再试一次。"
      >
        <template #action>
          <el-button type="primary" @click="reload">重试</el-button>
        </template>
      </KhyEmpty>
    </div>

    <div v-else-if="loading && !categories.length" class="state-block">
      <el-skeleton :rows="6" animated />
    </div>

    <div v-else-if="!total" class="state-block">
      <KhyEmpty
        :icon="keyword ? Search : Guide"
        :title="keyword ? `没有匹配「${keyword}」的命令` : '暂无可展示的功能'"
        :description="keyword ? '换个关键字试试，或清空搜索查看全部能力。' : ''"
      />
    </div>

    <template v-else>
      <div class="catalog-summary">
        共 <strong>{{ total }}</strong> 项命令，分 {{ categories.length }} 类
      </div>
      <el-card
        v-for="cat in categories"
        :key="cat.key"
        class="category-card"
        shadow="hover"
      >
        <template #header>
          <div class="category-header">
            <span class="category-label">{{ cat.label }}</span>
            <el-tag size="small" effect="plain">{{ cat.commands.length }}</el-tag>
          </div>
        </template>
        <div class="command-grid">
          <div v-for="c in cat.commands" :key="c.cmd" class="command-item">
            <div class="command-top">
              <code class="command-name">{{ c.cmd }}</code>
              <span v-if="c.label && c.label !== c.name" class="command-label">{{ c.label }}</span>
            </div>
            <div v-if="c.desc" class="command-desc">{{ c.desc }}</div>
          </div>
        </div>
      </el-card>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { Warning, Search, Guide } from '@element-plus/icons-vue'
import request from '@/api/request'
import KhyEmpty from '@/components/KhyEmpty.vue'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

// keep-alive matches on component name (see Layout CACHED_VIEWS convention).
defineOptions({ name: 'FeatureCatalog' })

const categories = ref([])
const total = ref(0)
const keyword = ref('')
const loading = ref(false)
const error = ref(false)

let searchTimer = null

// Load the command catalog from the backend SSOT (GET /api/commands). The same
// data powers the TUI `/features` command — one source, three surfaces.
async function load(q = '') {
  loading.value = true
  error.value = false
  try {
    const res = await request.get('/api/commands', { params: q ? { q } : {} })
    const payload = res && res.data && res.data.data ? res.data.data : { categories: [], total: 0 }
    categories.value = Array.isArray(payload.categories) ? payload.categories : []
    total.value = Number(payload.total) || 0
  } catch (e) {
    error.value = true
    categories.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

// Debounced server-side search so typing doesn't hammer the endpoint.
function onSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => load(keyword.value.trim()), 250)
}

function reload() {
  load(keyword.value.trim())
}

onMounted(() => load())
</script>

<style scoped>
.feature-catalog-page {
  padding: 16px 20px 40px;
}
.honest-note {
  margin-bottom: 16px;
}
.state-block {
  padding: 40px 0;
}
.catalog-summary {
  margin: 4px 0 14px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.category-card {
  margin-bottom: 16px;
}
.category-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.category-label {
  font-weight: 600;
  font-size: 15px;
}
.command-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.command-item {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 12px;
  transition: border-color 0.15s, background 0.15s;
}
.command-item:hover {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-fill-color-light);
}
.command-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.command-name {
  color: var(--el-color-primary);
  font-weight: 600;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 13px;
}
.command-label {
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.command-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
