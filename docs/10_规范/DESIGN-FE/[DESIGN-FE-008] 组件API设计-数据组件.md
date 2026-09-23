# [DESIGN-FE-008] 组件 API 设计 · 数据组件

> **定位**：数据组件（Table/List/Tree/Chart 等）的 API 目标态。
> **隶属**：本文是 [`[DESIGN-FE-002]` 前端组件库规范]([DESIGN-FE-002] 前端组件库规范.md) 的**子篇**；主篇是唯一入口与 scope 裁决真源，本文只承载细则。
> **状态**：随主篇——主篇 §0 声明为「目标态、非现状」，本文同样在组件库真正落地后才生效；在此之前一切以 [`[DESIGN-FE-001]` 前端页面规范]([DESIGN-FE-001] 前端页面规范.md) 为准。

---


**Table 组件 (KhyTable)**：
```vue
<template>
  <div class="khy-table-wrapper">
    <table :class="tableClasses">
      <thead>
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            :class="[
              'khy-table__th',
              {
                'khy-table__th--sortable': column.sortable,
                'khy-table__th--sorted': sortKey === column.key
              }
            ]"
            :style="{ width: column.width }"
            @click="handleSort(column)"
          >
            <div class="khy-table__th-content">
              <span>{{ column.title }}</span>
              <span v-if="column.sortable" class="khy-table__sort-icon">
                {{ getSortIcon(column.key) }}
              </span>
            </div>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, index) in data"
          :key="row[rowKey] || index"
          :class="[
            'khy-table__row',
            {
              'khy-table__row--selected': isSelected(row),
              'khy-table__row--striped': striped && index % 2 === 1
            }
          ]"
          @click="handleRowClick(row)"
        >
          <td
            v-for="column in columns"
            :key="column.key"
            class="khy-table__td"
          >
            <slot
              :name="column.key"
              :row="row"
              :column="column"
              :value="row[column.key]"
            >
              {{ row[column.key] }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
    
    <div v-if="loading" class="khy-table__loading">
      <slot name="loading">
        <div class="khy-table__spinner" />
      </slot>
    </div>
    
    <div v-if="data.length === 0 && !loading" class="khy-table__empty">
      <slot name="empty">
        <p>暂无数据</p>
      </slot>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  // 数据源
  data: {
    type: Array,
    default: () => []
  },
  // 列配置
  columns: {
    type: Array,
    required: true
  },
  // 行键
  rowKey: {
    type: String,
    default: 'id'
  },
  // 是否可选择
  selectable: Boolean,
  // 选中的行
  selectedRows: {
    type: Array,
    default: () => []
  },
  // 是否斑马纹
  striped: Boolean,
  // 是否加载中
  loading: Boolean,
  // 排序
  sortable: Boolean
});

const emit = defineEmits([
  'row-click',
  'selection-change',
  'sort-change'
]);

const sortKey = ref('');
const sortOrder = ref('asc');

const tableClasses = computed(() => [
  'khy-table',
  {
    'khy-table--striped': props.striped,
    'khy-table--selectable': props.selectable,
    'khy-table--loading': props.loading
  }
]);

const isSelected = (row) => {
  return props.selectedRows.some(item => item[props.rowKey] === row[props.rowKey]);
};

const handleRowClick = (row) => {
  emit('row-click', row);
};

const handleSort = (column) => {
  if (!column.sortable) return;
  
  if (sortKey.value === column.key) {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = column.key;
    sortOrder.value = 'asc';
  }
  
  emit('sort-change', { key: sortKey.value, order: sortOrder.value });
};

const getSortIcon = (key) => {
  if (sortKey.value !== key) return '↕';
  return sortOrder.value === 'asc' ? '↑' : '↓';
};
</script>
```

---
