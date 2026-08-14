<template>
  <div class="ai-assets">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>AI 资产管理</span>
          <el-button type="primary" @click="uploadAsset">上传资产</el-button>
        </div>
      </template>

      <el-table :data="assetList" style="width: 100%">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="type" label="类型" width="120" />
        <el-table-column prop="size" label="大小" width="120" />
        <el-table-column prop="createdAt" label="创建时间" width="180" />
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button size="small" @click="downloadAsset(row)">下载</el-button>
            <el-button size="small" type="danger" @click="deleteAsset(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { authedFetch } from '@/utils/authedFetch';
import { ElMessage, ElMessageBox } from 'element-plus';

const assetList = ref([]);

async function loadAssets() {
  try {
    const data = await authedFetch('/api/assets');
    assetList.value = data.assets || [];
  } catch (error) {
    ElMessage.error('加载资产列表失败');
  }
}

function uploadAsset() {
  ElMessage.info('上传资产功能待实现');
}

function downloadAsset(asset) {
  ElMessage.info(`下载资产: ${asset.name}`);
}

async function deleteAsset(asset) {
  try {
    await ElMessageBox.confirm(`确定要删除资产 "${asset.name}" 吗？`, '警告', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    });

    await authedFetch(`/api/assets/${asset.id}`, { method: 'DELETE' });
    ElMessage.success('资产已删除');
    await loadAssets();
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败');
    }
  }
}

onMounted(() => {
  loadAssets();
});
</script>

<style scoped>
.ai-assets {
  width: 100%;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
