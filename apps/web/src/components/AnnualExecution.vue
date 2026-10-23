<script setup lang="ts">
import { computed } from 'vue';
import type { WorkItem } from '@workbench/contracts';
import { useInsightsStore } from '../stores/insights';
import { itemNames, periodOf, progressOf, sourceOf } from '../lib/insights';
const emit = defineEmits<{ open: [item: WorkItem] }>();
const store = useInsightsStore();
const groups = computed(() => {
  const grouped = new Map<
    string,
    { title: string; items: NonNullable<typeof store.execution>['items'] }
  >();
  for (const row of store.execution?.items ?? []) {
    const group = grouped.get(row.annualId) ?? { title: row.annualTitle, items: [] };
    group.items.push(row);
    grouped.set(row.annualId, group);
  }
  return [...grouped].map(([id, group]) => ({ id, ...group }));
});
</script>
<template>
  <section class="wb-section wb-execution" aria-label="年度执行归集">
    <header class="wb-section-header">
      <span class="wb-level annual">归</span>
      <div>
        <h2>年度执行归集</h2>
        <p>按年度目标归集月、周、日事项，含跨月及跨年排期；年度目标本身不计入。</p>
      </div>
    </header>
    <div class="wb-execution-summary">
      <strong>{{ store.overview?.execution.total ?? '—' }}</strong> 条关联事项
      <span>已完成 {{ store.overview?.execution.completed ?? '—' }} 条</span
      ><small>各层级分别计数，不代表独立成果数量</small>
    </div>
    <div class="wb-insight-filters">
      <label
        >年度目标<select
          v-model="store.filters.annualId"
          aria-label="归集年度目标"
          @change="store.loadExecution()"
        >
          <option value="">全部年度目标</option>
          <option v-for="g in store.overview?.annualGroups" :key="g.annualId" :value="g.annualId">
            {{ g.title || '未命名目标' }}（{{ g.total }}）
          </option>
        </select></label
      >
      <label
        >层级<select
          v-model="store.filters.type"
          aria-label="归集事项层级"
          @change="store.loadExecution()"
        >
          <option value="">月 / 周 / 日</option>
          <option value="monthly">月度目标</option>
          <option value="weekly">周任务</option>
          <option value="daily">日待办</option>
        </select></label
      >
      <div class="wb-filter-tabs" aria-label="归集完成状态">
        <button
          v-for="(label, key) in { all: '全部', incomplete: '未完成', complete: '已完成' } as const"
          :key="key"
          type="button"
          :aria-pressed="store.filters.completion === key"
          @click="
            store.filters.completion = key;
            store.loadExecution();
          "
        >
          {{ label }}
        </button>
      </div>
    </div>
    <p v-if="store.errors.execution" class="wb-insight-error" role="alert">
      {{ store.errors.execution }}
      <button class="wb-link" @click="store.loadExecution()">重试归集</button>
    </p>
    <p v-else-if="store.busy.execution || store.updating" class="wb-loading" role="status">
      正在读取归集…
    </p>
    <template v-else>
      <div v-if="!store.execution?.items.length" class="wb-insight-empty">
        当前筛选没有关联事项。可在年度目标下拆解月目标，或为已有事项补充上级关联。
      </div>
      <div v-for="group in groups" :key="group.id" class="wb-exec-group">
        <h3>{{ group.title || '未命名年度目标' }}</h3>
        <button
          v-for="row in group.items"
          :key="row.item.id"
          class="wb-exec-row"
          type="button"
          @click="emit('open', row.item)"
        >
          <span class="wb-item-type" :class="row.item.type">{{ itemNames[row.item.type] }}</span
          ><span class="wb-exec-title"
            ><strong>{{ row.item.title || '未命名事项' }}</strong
            ><small
              >{{ periodOf(row.item) }} ·
              {{
                sourceOf(row.item, store.execution!.ancestors)
                  .map((v) => v.title || '未命名目标')
                  .join(' ← ')
              }}</small
            ></span
          ><span class="wb-completion" :class="{ done: row.completed }">{{
            progressOf(row.item)
          }}</span
          ><span aria-hidden="true">↗</span>
        </button>
      </div>
      <div v-if="store.execution && store.execution.total" class="wb-pagination">
        <span
          >{{ store.execution.offset + 1 }}–{{
            Math.min(store.execution.offset + store.execution.items.length, store.execution.total)
          }}
          / {{ store.execution.total }} 条</span
        ><button
          class="wb-button"
          :disabled="store.execution.offset === 0"
          @click="store.loadExecution(Math.max(0, store.execution.offset - 20))"
        >
          上一页</button
        ><button
          class="wb-button"
          :disabled="store.execution.offset + 20 >= store.execution.total"
          @click="store.loadExecution(store.execution.offset + 20)"
        >
          下一页
        </button>
      </div>
    </template>
  </section>
</template>
