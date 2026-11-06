<script setup lang="ts">
import { computed } from 'vue';
import {
  activeItem,
  effectiveProgress,
  itemComplete,
  weightedProgress,
  type WorkItem,
} from '@workbench/contracts';
import { useWorkbenchStore } from '../stores/workbench';
import { addDays, monday } from '../lib/dates';
const emit = defineEmits<{ open: [item: WorkItem] }>();
const board = useWorkbenchStore();
const all = computed(() => Object.values(board.records).filter(activeItem));
const annual = computed(() =>
  all.value.filter((v) => v.type === 'annual' && v.year === board.selection.year),
);
const months = computed(() =>
  all.value.filter((v) => v.type === 'monthly' && v.month === board.selection.month),
);
const annualProgress = computed(() =>
  weightedProgress(annual.value, (v) => effectiveProgress(v, all.value)),
);
const monthlyProgress = computed(() => weightedProgress(months.value));
const sortedAnnual = computed(() =>
  [...annual.value].sort(
    (a, b) => effectiveProgress(b, all.value) - effectiveProgress(a, all.value),
  ),
);
const sortedMonthly = computed(() =>
  [...months.value].sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0)),
);
const states = computed(() => ({
  done: annual.value.filter((v) => itemComplete(v, all.value)).length,
  running: annual.value.filter(
    (v) => effectiveProgress(v, all.value) > 0 && !itemComplete(v, all.value),
  ).length,
  idle: annual.value.filter((v) => effectiveProgress(v, all.value) === 0).length,
}));
const ring = computed(() => {
  const n = annual.value.length;
  if (!n) return 'var(--border)';
  const a = (states.value.done / n) * 100,
    b = ((states.value.done + states.value.running) / n) * 100;
  return `conic-gradient(var(--positive) 0% ${a}%,var(--link) ${a}% ${b}%,var(--border) ${b}% 100%)`;
});
const trend = computed(() =>
  Array.from({ length: 12 }, (_, index) => {
    const month = `${board.selection.year}-${String(index + 1).padStart(2, '0')}`,
      items = all.value.filter((v) => v.type === 'monthly' && v.month === month);
    return { month, label: index + 1, total: items.length, value: weightedProgress(items) };
  }),
);
const text = (value: number | null) => (value === null ? '—' : `${value}%`);
function selectMonth(month: string) {
  const date = `${month}-01`,
    start = monday(date);
  void board.changeSelection({ ...board.selection, month, date, start, end: addDays(start, 6) });
}
</script>
<template>
  <section class="wb-section wb-charts" aria-label="图表看板">
    <header class="wb-section-header">
      <span class="wb-level">图</span>
      <div>
        <h2>目标看板</h2>
        <p>进度统一使用有效权重计算，与概览一致；点击目标查看和编辑详情。</p>
      </div>
    </header>
    <div class="wb-chart-kpis">
      <div>
        <span>年度加权进度</span
        ><strong data-chart-metric="annual">{{ text(annualProgress) }}</strong
        ><small>{{ annual.length }} 项年度目标 · 按各自进度模式</small>
      </div>
      <div>
        <span>本月加权进度</span
        ><strong data-chart-metric="monthly">{{ text(monthlyProgress) }}</strong
        ><small>{{ months.length }} 项 · {{ board.selection.month }}</small>
      </div>
      <div>
        <span>年度目标已完成</span><strong>{{ states.done }} / {{ annual.length }}</strong
        ><small>按各目标当前进度判断</small>
      </div>
    </div>
    <div class="wb-chart-grid">
      <section class="wb-chart-panel">
        <h3>年度目标进度对比</h3>
        <p>按进度从高到低排列</p>
        <button
          v-for="goal in sortedAnnual"
          :key="goal.id"
          type="button"
          class="wb-chart-bar-row"
          @click="emit('open', goal)"
        >
          <span>{{ goal.title || '未命名年度目标' }}</span
          ><span class="wb-chart-track"
            ><i
              :class="{ done: itemComplete(goal, all) }"
              :style="{ width: `${effectiveProgress(goal, all)}%` }" /></span
          ><strong>{{ effectiveProgress(goal, all) }}%</strong>
        </button>
        <p v-if="!annual.length" class="wb-insight-empty">本年度暂无目标。</p>
      </section>
      <section class="wb-chart-panel">
        <h3>年度目标状态结构</h3>
        <p>扇区按目标件数，中心为年度加权进度</p>
        <div
          class="wb-chart-ring"
          :style="{ background: ring }"
          role="img"
          :aria-label="`已完成 ${states.done}，进行中 ${states.running}，未开始 ${states.idle}`"
        >
          <div>
            <strong>{{ text(annualProgress) }}</strong
            ><span>加权进度</span>
          </div>
        </div>
        <ul class="wb-chart-legend">
          <li><i class="done" />已完成 {{ states.done }}</li>
          <li><i class="running" />进行中 {{ states.running }}</li>
          <li><i />未开始 {{ states.idle }}</li>
        </ul>
      </section>
    </div>
    <section class="wb-chart-panel">
      <h3>12个月目标进度</h3>
      <p>按各月现有目标的当前进度加权汇总；不代表历史时点快照。无目标或权重为零显示“—”。</p>
      <div class="wb-trend" role="list">
        <button
          v-for="month in trend"
          :key="month.month"
          role="listitem"
          class="wb-trend-column"
          type="button"
          :aria-label="`${month.month}：${text(month.value)}，${month.total} 项`"
          :aria-pressed="month.month === board.selection.month"
          @click="selectMonth(month.month)"
        >
          <span>{{ text(month.value) }}</span
          ><span class="wb-trend-track"
            ><i :style="{ height: `${Math.max(month.value ?? 0, 1)}%` }" /></span
          ><strong>{{ month.label }}月</strong>
        </button>
      </div>
    </section>
    <section class="wb-chart-panel">
      <h3>本月月度目标 · {{ board.selection.month }}</h3>
      <button
        v-for="goal in sortedMonthly"
        :key="goal.id"
        type="button"
        class="wb-chart-bar-row"
        @click="emit('open', goal)"
      >
        <span>{{ goal.title || '未命名月度目标' }}</span
        ><span class="wb-chart-track"
          ><i
            :class="{ done: goal.progress === 100 }"
            :style="{ width: `${goal.progress}%` }" /></span
        ><strong>{{ goal.progress }}%</strong>
      </button>
      <p v-if="!months.length" class="wb-insight-empty">本月暂无月度目标。</p>
    </section>
  </section>
</template>
