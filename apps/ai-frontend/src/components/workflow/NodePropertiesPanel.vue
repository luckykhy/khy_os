<template>
  <div class="props-panel">
    <template v-if="node">
      <div class="props-panel__title">
        <span class="props-panel__cat" :class="`cat-${def?.category || 'control'}`" />
        {{ def?.label || node.type }}
      </div>

      <el-form label-position="top" size="small">
        <el-form-item label="节点名称">
          <el-input
            :model-value="node.label"
            maxlength="80"
            @update:model-value="rename"
          />
        </el-form-item>

        <!-- toolCall: offer the user's installed plugin tools as a quick picker
             that fills the `tool` field with the exact plugin__<slug>__<op> name. -->
        <el-form-item v-if="node.type === 'toolCall' && pluginTools.length" label="插件工具">
          <el-select
            placeholder="从已安装插件选择"
            filterable
            clearable
            style="width: 100%"
            @change="pickPluginTool"
          >
            <el-option
              v-for="t in pluginTools"
              :key="t.name"
              :label="`${t.slug} · ${t.operationId}`"
              :value="t.name"
            />
          </el-select>
        </el-form-item>

        <el-form-item
          v-for="field in fields"
          :key="field.name"
          :label="field.label"
        >
          <NodeField
            :field="field"
            :model-value="node.data ? node.data[field.name] : undefined"
            @update:model-value="(v) => setField(field.name, v)"
          />
        </el-form-item>
      </el-form>

      <el-button
        type="danger"
        plain
        size="small"
        :icon="Delete"
        @click="remove"
      >删除节点</el-button>
    </template>
    <el-empty v-else description="选择一个节点查看属性" :image-size="64" />
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { Delete } from '@element-plus/icons-vue'
import { useWorkflowEditorStore } from '@/stores/workflowEditor'
import { useMarketplace } from '@/composables/useMarketplace'
import NodeField from './NodeField.vue'

const props = defineProps({
  catalog: { type: Object, default: () => ({ nodes: [] }) },
})

const store = useWorkflowEditorStore()
const node = computed(() => store.selectedNode)

// Installed plugin tools — loaded once for the toolCall picker. Best-effort: a
// failure (e.g. no plugins) just leaves the picker hidden.
const marketplace = useMarketplace()
const pluginTools = ref([])
onMounted(async () => {
  try { pluginTools.value = await marketplace.listPluginTools() } catch { /* no plugins */ }
})

function pickPluginTool(name) {
  if (node.value && name) setField('tool', name)
}
const def = computed(() => {
  if (!node.value) return null
  return (props.catalog?.nodes || []).find((n) => n.type === node.value.type) || null
})
const fields = computed(() => def.value?.fields || [])

function rename(name) {
  if (node.value) store.renameNode(node.value.id, name)
}

function setField(name, value) {
  if (node.value) store.updateNodeData(node.value.id, { [name]: value })
}

function remove() {
  if (node.value) store.removeNode(node.value.id)
}
</script>

<style scoped>
.props-panel {
  width: 280px;
  padding: 12px;
  border-left: 1px solid var(--el-border-color-light);
  overflow-y: auto;
}
.props-panel__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--el-text-color-primary);
}
.props-panel__cat {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  display: inline-block;
}
.props-panel__cat.cat-control { background: var(--el-color-primary); }
.props-panel__cat.cat-agent { background: var(--el-color-success); }
.props-panel__cat.cat-data { background: var(--el-color-warning); }
.props-panel__cat.cat-human { background: var(--el-color-danger); }
</style>
