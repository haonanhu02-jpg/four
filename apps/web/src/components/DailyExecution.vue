<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { itemState, type WorkItem, type WorkItemType } from '@workbench/contracts';
import { useWorkbenchStore } from '../stores/workbench';
import { newestFirst } from '../lib/item-order';
import { dayLabel } from '../lib/dates';
import WorkItemCard from './WorkItemCard.vue';
const emit = defineEmits<{
  open: [item: WorkItem];
  remove: [item: WorkItem];
  history: [item: WorkItem];
  add: [type: WorkItemType, parentId?: string];
}>();
const board = useWorkbenchStore();
const filter = ref('all'),
  search = ref(''),
  limit = ref(50);
const states = { all: '全部', todo: '未完成', complete: '已完成', terminated: '已终止' };
const days = computed(() =>
  Object.values(board.records)
    .filter(
      (d) => d.type === 'daily' && !d.deletedAt && !d.archivedAt && d.date === board.selection.date,
    )
    .sort(
      (a, b) =>
        Number(!!a.terminated) - Number(!!b.terminated) ||
        Number(a.done) - Number(b.done) ||
        newestFirst(a, b),
    ),
);
const matches = (d: WorkItem, key: string) => key === 'all' || itemState(d) === key;
const rows = computed(() =>
  days.value.filter(
    (d) =>
      matches(d, filter.value) &&
      `${d.title} ${d.note} ${board
        .lineage(d)
        .map((p) => p.title)
        .join(' ')}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
watch([filter, search, () => board.selection.date], () => {
  limit.value = 50;
});
watch(
  () => board.creating,
  (creating) => {
    if (creating) {
      filter.value = 'all';
      search.value = '';
      limit.value = 50;
    }
  },
);
</script>
<template>
  <section class="wb-section wb-daily-execution" aria-label="日待办">
    <header class="wb-section-header">
      <span class="wb-level daily">日</span>
      <div>
        <h2>日待办</h2>
        <p>{{ dayLabel(board.selection.date) }} · 查看每日工作与周、月、年度来源。</p>
      </div>
      <span class="wb-count">{{ days.length }} 条</span>
      <button
        type="button"
        class="wb-button primary"
        data-add-type="daily"
        :disabled="board.creating"
        @click="emit('add', 'daily')"
      >
        + 新增日待办
      </button>
    </header>
    <div class="wb-table-filters">
      <div class="wb-filter-tabs" aria-label="日待办完成筛选">
        <button
          v-for="(label, key) in states"
          :key="key"
          type="button"
          :aria-pressed="filter === key"
          @click="filter = key"
        >
          {{ label }} <strong>{{ days.filter((d) => matches(d, key)).length }}</strong>
        </button>
      </div>
      <label class="wb-table-search"
        >搜索<input
          v-model="search"
          type="search"
          aria-label="搜索日待办"
          placeholder="标题、工作情况或来源"
      /></label>
    </div>
    <div v-if="!days.length" class="wb-empty">
      <span class="wb-empty-symbol">日</span>
      <h3>安排这一天的第一件事</h3>
      <p>新增日待办，或在周任务中拆分每日工作；内容会自动显示在这里。</p>
      <button
        type="button"
        class="wb-link"
        :disabled="board.creating"
        @click="emit('add', 'daily')"
      >
        + 创建第一条日待办
      </button>
    </div>
    <p v-else-if="!rows.length" class="wb-insight-empty">当前筛选没有匹配的日待办。</p>
    <WorkItemCard
      v-for="(day, index) in rows.slice(0, limit)"
      :key="day.id"
      :item="day"
      :index="index"
      source-links
      @open="emit('open', $event)"
      @remove="emit('remove', $event)"
      @history="emit('history', $event)"
      @add="(type, parent) => emit('add', type, parent)"
    />
    <button v-if="rows.length > limit" type="button" class="wb-load-more" @click="limit += 50">
      加载更多（{{ limit }}/{{ rows.length }}）
    </button>
  </section>
</template>
