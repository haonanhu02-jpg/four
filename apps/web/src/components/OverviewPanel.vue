<script setup lang="ts">
import { computed } from 'vue';
import type { WorkItem } from '@workbench/contracts';
import { useInsightsStore } from '../stores/insights';
import { useWorkbenchStore } from '../stores/workbench';
import { itemNames, sourceOf } from '../lib/insights';
const emit = defineEmits<{ open: [item: WorkItem] }>();
const insights = useInsightsStore();
const board = useWorkbenchStore();
const data = computed(() => insights.overview);
const chain = computed(() =>
  data.value?.focus ? sourceOf(data.value.focus, data.value.ancestors) : [],
);
const isToday = computed(() => board.selection.date === data.value?.asOfDate);
</script>
<template>
  <section class="wb-overview" aria-label="进度概览" :aria-busy="insights.updating">
    <p v-if="insights.errors.overview" class="wb-insight-error" role="alert">
      {{ insights.errors.overview }}
      <button class="wb-link" @click="insights.refresh">重试概览</button>
    </p>
    <template v-else-if="data">
      <div class="wb-focus">
        <div class="wb-donut" :style="{ '--progress': `${data.daily.value ?? 0}%` }">
          <strong>{{ data.daily.value === null ? '—' : `${data.daily.value}%` }}</strong>
        </div>
        <div class="wb-focus-text">
          <p class="wb-eyebrow">
            {{ isToday ? 'TODAY · 今日焦点' : `${board.selection.date} · 当日焦点` }}
          </p>
          <button
            v-if="data.focus"
            type="button"
            class="wb-focus-title"
            @click="emit('open', data.focus)"
          >
            {{ data.focus.title || '未命名待办' }}
          </button>
          <h2 v-else>{{ data.daily.total ? '当日待办已全部完成' : '先安排一件具体的事' }}</h2>
          <p v-if="data.focus" class="wb-focus-chain">
            <template v-for="parent in chain" :key="parent.id"
              ><span
                >{{ itemNames[parent.type] }}：{{ parent.title || '未命名目标' }}</span
              ></template
            ><span v-if="!chain.length">尚未关联周任务，可点击焦点补充关联</span>
          </p>
          <p v-else>
            {{
              data.daily.total
                ? '可以回顾成果，或继续安排下一步。'
                : '在下方新增待办，把目标落实到行动。'
            }}
          </p>
          <small>当日计划 {{ data.daily.minutes }} 分钟 · {{ data.daily.total }} 件</small>
        </div>
      </div>
      <div class="wb-stat-grid">
        <div class="wb-stat" data-metric="annual">
          <strong>{{ data.annual.value === null ? '—' : `${data.annual.value}%` }}</strong
          ><span>{{ board.selection.year }} 年度</span
          ><small>{{
            !data.annual.total
              ? '暂无目标'
              : data.annual.totalWeight === 0
                ? '未设置权重'
                : '按手动进度加权'
          }}</small>
        </div>
        <div class="wb-stat" data-metric="monthly">
          <strong>{{ data.monthly.value === null ? '—' : `${data.monthly.value}%` }}</strong
          ><span>{{ board.selection.month }} 月度</span
          ><small>{{
            !data.monthly.total
              ? '暂无目标'
              : data.monthly.totalWeight === 0
                ? '未设置权重'
                : '按手动进度加权'
          }}</small>
        </div>
        <div class="wb-stat" data-metric="weekly">
          <strong>{{ data.weekly.value === null ? '—' : `${data.weekly.value}%` }}</strong
          ><span>所选区间推进指数</span
          ><small>{{ data.weekly.total }} 项 · {{ data.weekly.completed }} 项完成</small>
        </div>
        <div class="wb-stat" data-metric="daily">
          <strong>{{ data.daily.completed }}/{{ data.daily.total }}</strong
          ><span>{{ isToday ? '今日' : '当日' }}完成</span
          ><small>{{
            data.daily.value === null ? '暂无待办' : `按件数计算 ${data.daily.value}%`
          }}</small>
        </div>
      </div>
      <details class="wb-calculation">
        <summary>
          进度如何计算
          <span>{{
            board.hasUnsaved
              ? '有修改待保存，当前为上次保存结果'
              : insights.updating
                ? '正在更新…'
                : '已按保存的数据汇总'
          }}</span>
        </summary>
        <p>
          年度、月度 = Σ（手动进度 × 权重）÷ Σ权重；0 权重不参与，权重全为 0
          时显示“未设置权重”。周推进指数取状态分数平均：未开始 0、进行中 50、受阻 15、已完成
          100；它不代表实际工作量完成率。日完成率按已完成件数计算。百分比四舍五入，上层手动进度保持独立。
        </p>
      </details>
    </template>
    <p v-else class="wb-loading">正在汇总进度…</p>
  </section>
</template>
