<template>
  <div class="account-pool">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>账号池管理</span>
          <el-button type="primary" @click="addAccount">添加账号</el-button>
        </div>
      </template>

      <el-table :data="accountList" style="width: 100%">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="provider" label="供应商" width="120" />
        <el-table-column prop="email" label="邮箱/账号" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'danger'">
              {{ row.status === 'active' ? '正常' : '异常' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="usage" label="使用次数" width="120" />
        <el-table-column prop="lastUsed" label="最后使用" width="180" />
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button size="small" @click="testAccount(row)">测试</el-button>
            <el-button size="small" type="primary" @click="editAccount(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="deleteAccount(row)">删除</el-button>
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

const accountList = ref([]);

async function loadAccounts() {
  try {
    const data = await authedFetch('/api/accounts');
    accountList.value = data.accounts || [];
  } catch (error) {
    ElMessage.error('加载账号列表失败');
  }
}

function addAccount() {
  ElMessage.info('添加账号功能待实现');
}

function editAccount(account) {
  ElMessage.info(`编辑账号: ${account.email}`);
}

async function testAccount(account) {
  try {
    ElMessage.info(`正在测试账号: ${account.email}...`);
    await authedFetch(`/api/accounts/${account.id}/test`, { method: 'POST' });
    ElMessage.success('账号测试成功');
    await loadAccounts();
  } catch (error) {
    ElMessage.error('账号测试失败');
  }
}

async function deleteAccount(account) {
  try {
    await ElMessageBox.confirm(`确定要删除账号 "${account.email}" 吗？`, '警告', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    });

    await authedFetch(`/api/accounts/${account.id}`, { method: 'DELETE' });
    ElMessage.success('账号已删除');
    await loadAccounts();
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败');
    }
  }
}

onMounted(() => {
  loadAccounts();
});
</script>

<style scoped>
.account-pool {
  width: 100%;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
