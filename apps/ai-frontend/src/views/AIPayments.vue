<template>
  <div class="ai-payments">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>支付管理</span>
          <el-button type="primary" @click="addPayment">添加支付记录</el-button>
        </div>
      </template>

      <el-row :gutter="20" style="margin-bottom: 20px">
        <el-col :span="8">
          <div class="stat-box">
            <div class="stat-label">总消费</div>
            <div class="stat-value">¥{{ stats.totalCost }}</div>
          </div>
        </el-col>
        <el-col :span="8">
          <div class="stat-box">
            <div class="stat-label">本月消费</div>
            <div class="stat-value">¥{{ stats.monthlyCost }}</div>
          </div>
        </el-col>
        <el-col :span="8">
          <div class="stat-box">
            <div class="stat-label">余额</div>
            <div class="stat-value">¥{{ stats.balance }}</div>
          </div>
        </el-col>
      </el-row>

      <el-table :data="paymentList" style="width: 100%">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="date" label="日期" width="180" />
        <el-table-column prop="description" label="描述" />
        <el-table-column prop="amount" label="金额" width="120">
          <template #default="{ row }">
            <span :class="row.amount > 0 ? 'positive' : 'negative'">
              ¥{{ Math.abs(row.amount) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="row.type === 'income' ? 'success' : 'warning'">
              {{ row.type === 'income' ? '充值' : '消费' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { authedFetch } from '@/utils/authedFetch';
import { ElMessage } from 'element-plus';

const paymentList = ref([]);
const stats = ref({
  totalCost: 0,
  monthlyCost: 0,
  balance: 0
});

async function loadPayments() {
  try {
    const data = await authedFetch('/api/payments');
    paymentList.value = data.payments || [];
    stats.value = data.stats || stats.value;
  } catch (error) {
    ElMessage.error('加载支付记录失败');
  }
}

function addPayment() {
  ElMessage.info('添加支付记录功能待实现');
}

onMounted(() => {
  loadPayments();
});
</script>

<style scoped>
.ai-payments {
  width: 100%;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.stat-box {
  text-align: center;
  padding: 24px;
  background: #f5f7fa;
  border-radius: 8px;
}

.stat-label {
  font-size: 14px;
  color: #909399;
  margin-bottom: 12px;
}

.stat-value {
  font-size: 28px;
  font-weight: 600;
  color: #333;
}

.positive {
  color: #67c23a;
  font-weight: 600;
}

.negative {
  color: #f56c6c;
  font-weight: 600;
}
</style>
