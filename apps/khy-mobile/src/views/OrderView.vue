<script setup>
import { computed, onMounted, ref } from 'vue';
import { cancelOrder, describeQuantOutage, fetchPendingOrders, submitOrder } from '@/api/trading';
import { operationStatus, statusText } from '@/api/status';

// 与后端 routes/trade.js 的 isFuturesSymbol 保持同一判据：期货不受整手约束。
// 这里只做「提交前提醒」，真正的裁决仍在服务端 —— 前端放行的单子后端照样会拒。
function isFuturesSymbol(symbol) {
  const clean = String(symbol || '').replace(/^(sh|sz)/i, '');
  return /^[A-Z]{1,2}\d{3,4}$/i.test(clean) || /_main$/i.test(clean);
}

const form = ref({
  symbol: '',
  symbolName: '',
  direction: 'buy',
  orderType: 'limit',
  quantity: 100,
  price: '',
});
const pending = ref([]);
const busy = ref(false);
const busyOrderId = ref('');
const status = ref(operationStatus('读取', '未成交委托', '等待开始'));
const error = ref('');
const notice = ref('');

// 整手校验镜像后端 validateStockLotSize，作为提交前的即时反馈。
const lotWarning = computed(() => {
  const symbol = form.value.symbol.trim();
  if (!symbol || isFuturesSymbol(symbol)) return '';
  const qty = parseInt(form.value.quantity, 10);
  if (!qty || qty <= 0) return '交易数量必须为正整数';
  if (qty % 100 !== 0) return '股票交易数量必须为 100 的整数倍（1 手 = 100 股）';
  return '';
});
const canSubmit = computed(() =>
  !busy.value
  && form.value.symbol.trim()
  && Number(form.value.quantity) > 0
  && !lotWarning.value
  && (form.value.orderType !== 'limit' || Number(form.value.price) > 0));

async function loadPending() {
  status.value = operationStatus('读取', '未成交委托', '进行中');
  try {
    pending.value = await fetchPendingOrders();
    status.value = operationStatus('读取', '未成交委托', `已更新 ${pending.value.length} 笔`, 'success');
  } catch (cause) {
    error.value = describeQuantOutage(cause);
    status.value = operationStatus('读取', '未成交委托', '失败', 'error');
  }
}

async function submit() {
  busy.value = true;
  error.value = '';
  notice.value = '';
  const label = `${form.value.direction === 'buy' ? '买入' : '卖出'} ${form.value.symbol.trim()}`;
  status.value = operationStatus('提交', label, '发送中');
  try {
    const payload = {
      symbol: form.value.symbol.trim(),
      symbolName: form.value.symbolName.trim() || undefined,
      direction: form.value.direction,
      orderType: form.value.orderType,
      quantity: parseInt(form.value.quantity, 10),
    };
    // 市价单不带价格，交由服务端按参考价撮合。
    if (form.value.orderType === 'limit') payload.price = Number(form.value.price);
    await submitOrder(payload);
    notice.value = `已提交：${label} ${payload.quantity} 股`;
    status.value = operationStatus('提交', label, '已受理', 'success');
    form.value.price = '';
    await loadPending();
  } catch (cause) {
    error.value = describeQuantOutage(cause);
    status.value = operationStatus('提交', label, '被拒绝', 'error');
  } finally {
    busy.value = false;
  }
}

async function revoke(order) {
  busyOrderId.value = String(order.id);
  error.value = '';
  status.value = operationStatus('撤单', order.symbol || String(order.id), '提交中');
  try {
    await cancelOrder(order.id);
    status.value = operationStatus('撤单', order.symbol || String(order.id), '已完成', 'success');
    await loadPending();
  } catch (cause) {
    error.value = describeQuantOutage(cause);
    status.value = operationStatus('撤单', order.symbol || String(order.id), '失败', 'error');
  } finally {
    busyOrderId.value = '';
  }
}

onMounted(loadPending);
</script>

<template><div class="stack">
  <div><h1 class="page-title">下单</h1><p class="page-subtitle">提交委托并管理未成交订单</p></div>

  <section class="panel stack">
    <div class="direction-switch">
      <button :class="{ active: form.direction === 'buy', buy: true }" @click="form.direction = 'buy'">买入</button>
      <button :class="{ active: form.direction === 'sell', sell: true }" @click="form.direction = 'sell'">卖出</button>
    </div>

    <label class="field">标的代码
      <input v-model="form.symbol" placeholder="如 sh600000" autocapitalize="none" autocomplete="off" />
    </label>
    <label class="field">标的名称（可选）
      <input v-model="form.symbolName" placeholder="如 浦发银行" autocomplete="off" />
    </label>

    <label class="field">委托类型
      <select v-model="form.orderType"><option value="limit">限价单</option><option value="market">市价单</option></select>
    </label>
    <label v-if="form.orderType === 'limit'" class="field">委托价格
      <input v-model="form.price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="每股价格" />
    </label>
    <label class="field">委托数量
      <input v-model="form.quantity" type="number" inputmode="numeric" min="0" step="100" placeholder="股数" />
    </label>

    <p v-if="lotWarning" class="alert">{{ lotWarning }}</p>
    <button class="button primary" :disabled="!canSubmit" @click="submit">
      {{ form.direction === 'buy' ? '提交买入委托' : '提交卖出委托' }}
    </button>
  </section>

  <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
  <p v-if="notice" class="notice">{{ notice }}</p>
  <p v-if="error" class="alert">{{ error }}</p>

  <section class="stack">
    <div class="row"><h2>未成交委托</h2><button class="button" title="刷新" @click="loadPending">↻</button></div>
    <article v-for="order in pending" :key="order.id" class="panel order-row">
      <div class="row">
        <div>
          <strong>{{ order.symbolName || order.symbol }}</strong>
          <span class="muted">{{ order.side === 'buy' ? '买入' : '卖出' }} · {{ order.quantity }} 股 · {{ order.price ?? '市价' }}</span>
        </div>
        <button class="button danger" :disabled="busyOrderId === String(order.id)" @click="revoke(order)">撤单</button>
      </div>
    </article>
    <p v-if="!pending.length && !error" class="panel muted">没有未成交的委托</p>
  </section>
</div></template>

<style scoped>
h2 { font-size: 17px; margin: 0; }
.direction-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.direction-switch button { padding: 11px; border: 1px solid #324354; border-radius: 6px; background: #1a2734; color: #8ca0b5; }
.direction-switch button.buy.active { background: #3a2020; border-color: #9b5446; color: #ffb9a5; }
.direction-switch button.sell.active { background: #18382f; border-color: #3f7f6c; color: #8be6c7; }
.notice { padding: 10px 12px; border-left: 3px solid #68d5c0; color: #b9ece0; background: #12241f; font-size: 13px; }
.order-row > .row > div { display: grid; gap: 3px; }
.order-row .muted { font-size: 12px; }
</style>
