<template>
  <div class="pricing-page">
    <KhyPageHeader title="计费定价" subtitle="分组倍率与默认限额、模型单价（CNY / 1M tokens）。计费金额 = 基础成本 × 分组倍率">
      <template #actions>
        <el-button :loading="billing.loading.value" @click="reload">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </template>
    </KhyPageHeader>

    <!-- Groups -->
    <el-card shadow="never" class="block-card">
      <template #header>
        <div class="block-head">
          <span class="block-title">定价分组</span>
          <el-button size="small" type="primary" @click="openGroupDialog()">新增分组</el-button>
        </div>
      </template>
      <el-table :data="groupRows" stripe size="small" empty-text="暂无分组">
        <el-table-column prop="id" label="分组 ID" min-width="140" />
        <el-table-column label="倍率" width="120" align="right">
          <template #default="{ row }">×{{ Number(row.ratio).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="默认 RPM" width="120" align="right">
          <template #default="{ row }">{{ row.limits.rpm || '不限' }}</template>
        </el-table-column>
        <el-table-column label="默认 TPM" width="130" align="right">
          <template #default="{ row }">{{ row.limits.tpm || '不限' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" align="center">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openGroupDialog(row)">编辑</el-button>
            <el-button
              v-if="row.id !== 'default'"
              size="small" link type="danger"
              @click="removeGroup(row.id)"
            >删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Model pricing -->
    <el-card shadow="never" class="block-card">
      <template #header>
        <div class="block-head">
          <span class="block-title">模型单价（CNY / 1M tokens）</span>
          <el-button size="small" type="primary" @click="openModelDialog()">新增模型定价</el-button>
        </div>
      </template>
      <el-table :data="modelRows" stripe size="small" empty-text="未配置模型单价（回退内置 USD 价表）">
        <el-table-column prop="model" label="模型" min-width="200" />
        <el-table-column label="输入单价" width="160" align="right">
          <template #default="{ row }">¥{{ Number(row.input).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="输出单价" width="160" align="right">
          <template #default="{ row }">¥{{ Number(row.output).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" align="center">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openModelDialog(row)">编辑</el-button>
            <el-button size="small" link type="danger" @click="removeModel(row.model)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Group dialog -->
    <el-dialog v-model="groupDialog.visible" :title="groupDialog.mode === 'create' ? '新增分组' : '编辑分组'" width="460px">
      <el-form :model="groupDialog.form" label-width="110px">
        <el-form-item label="分组 ID">
          <el-input v-model="groupDialog.form.id" :disabled="groupDialog.mode === 'edit'" placeholder="例如：vip" />
        </el-form-item>
        <el-form-item label="倍率">
          <el-input-number v-model="groupDialog.form.ratio" :min="0" :step="0.1" :precision="2" />
        </el-form-item>
        <el-form-item label="默认 RPM">
          <el-input-number v-model="groupDialog.form.rpm" :min="0" :max="100000" />
        </el-form-item>
        <el-form-item label="默认 TPM">
          <el-input-number v-model="groupDialog.form.tpm" :min="0" :max="100000000" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="groupDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveGroup">保存</el-button>
      </template>
    </el-dialog>

    <!-- Model dialog -->
    <el-dialog v-model="modelDialog.visible" :title="modelDialog.mode === 'create' ? '新增模型定价' : '编辑模型定价'" width="460px">
      <el-form :model="modelDialog.form" label-width="130px">
        <el-form-item label="模型">
          <el-input v-model="modelDialog.form.model" :disabled="modelDialog.mode === 'edit'" placeholder="例如：openai/gpt-4o" />
        </el-form-item>
        <el-form-item label="输入（¥/1M）">
          <el-input-number v-model="modelDialog.form.input" :min="0" :step="0.5" :precision="2" />
        </el-form-item>
        <el-form-item label="输出（¥/1M）">
          <el-input-number v-model="modelDialog.form.output" :min="0" :step="0.5" :precision="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="modelDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveModel">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onActivated, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { useGatewayBilling } from '@/composables/useGatewayBilling'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

defineOptions({ name: 'Pricing' })

const billing = useGatewayBilling()
const pricing = billing.pricing
const saving = ref(false)

const groupRows = computed(() => {
  const groups = pricing.value?.groups || {}
  return Object.entries(groups).map(([id, g]) => ({
    id,
    ratio: g.ratio ?? 1,
    limits: { rpm: g.limits?.rpm || 0, tpm: g.limits?.tpm || 0 },
  }))
})

const modelRows = computed(() => {
  const mp = pricing.value?.modelPricing || {}
  return Object.entries(mp).map(([model, p]) => ({
    model,
    input: p.input || 0,
    output: p.output || 0,
  }))
})

const groupDialog = reactive({
  visible: false,
  mode: 'create',
  form: { id: '', ratio: 1, rpm: 0, tpm: 0 },
})

const modelDialog = reactive({
  visible: false,
  mode: 'create',
  form: { model: '', input: 0, output: 0 },
})

function openGroupDialog(row) {
  if (row) {
    groupDialog.mode = 'edit'
    groupDialog.form = { id: row.id, ratio: row.ratio, rpm: row.limits.rpm, tpm: row.limits.tpm }
  } else {
    groupDialog.mode = 'create'
    groupDialog.form = { id: '', ratio: 1, rpm: 0, tpm: 0 }
  }
  groupDialog.visible = true
}

async function saveGroup() {
  const id = (groupDialog.form.id || '').trim()
  if (!id) { ElMessage.warning('分组 ID 不能为空'); return }
  saving.value = true
  try {
    await billing.updatePricing({
      groups: {
        [id]: {
          ratio: groupDialog.form.ratio,
          limits: { rpm: groupDialog.form.rpm, tpm: groupDialog.form.tpm },
        },
      },
    })
    ElMessage.success('分组已保存')
    groupDialog.visible = false
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally {
    saving.value = false
  }
}

async function removeGroup(id) {
  try {
    await ElMessageBox.confirm(`确认删除分组「${id}」？`, '删除分组', { type: 'warning' })
  } catch { return }
  try {
    await billing.updatePricing({ groups: { [id]: null } })
    ElMessage.success('分组已删除')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  }
}

function openModelDialog(row) {
  if (row) {
    modelDialog.mode = 'edit'
    modelDialog.form = { model: row.model, input: row.input, output: row.output }
  } else {
    modelDialog.mode = 'create'
    modelDialog.form = { model: '', input: 0, output: 0 }
  }
  modelDialog.visible = true
}

async function saveModel() {
  const model = (modelDialog.form.model || '').trim()
  if (!model) { ElMessage.warning('模型不能为空'); return }
  saving.value = true
  try {
    await billing.updatePricing({
      modelPricing: {
        [model]: { input: modelDialog.form.input, output: modelDialog.form.output },
      },
    })
    ElMessage.success('模型单价已保存')
    modelDialog.visible = false
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally {
    saving.value = false
  }
}

async function removeModel(model) {
  try {
    await ElMessageBox.confirm(`确认删除模型「${model}」的定价？`, '删除定价', { type: 'warning' })
  } catch { return }
  try {
    await billing.updatePricing({ modelPricing: { [model]: null } })
    ElMessage.success('已删除')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  }
}

function reload() { billing.fetchPricing() }

onMounted(() => billing.fetchPricing())

// keep-alive 重访刷新：跳过首挂避免双取。
let _activatedOnce = false
onActivated(() => {
  if (!_activatedOnce) { _activatedOnce = true; return }
  billing.fetchPricing()
})
</script>

<style scoped>
.pricing-page {
  padding: 4px;
  max-width: 1100px;
  margin: 0 auto;
}

.block-card {
  margin-bottom: 16px;
  border: 1px solid var(--khy-border);
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.block-title {
  font-weight: 700;
  color: var(--khy-text-strong);
}
</style>
