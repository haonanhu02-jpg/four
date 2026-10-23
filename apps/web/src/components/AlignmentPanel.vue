<script setup lang="ts">
import type { WorkItem, WorkItemType } from '@workbench/contracts';
import { useInsightsStore } from '../stores/insights';
import { useWorkbenchStore } from '../stores/workbench';
import { issueNames, itemNames, periodOf } from '../lib/insights';
const emit = defineEmits<{
  open: [item: WorkItem];
  add: [type: WorkItemType, parentId?: string];
}>();
const store = useInsightsStore();
const board = useWorkbenchStore();
</script>
<template>
  <section class="wb-section wb-alignment" aria-label="对齐体检">
    <header class="wb-section-header">
      <span class="wb-level">检</span>
      <div>
        <h2>对齐体检</h2>
        <p>检查所选年度、月份、区间和日期，帮助每件事找到方向与下一步。</p>
      </div>
      <span class="wb-count"
        >{{ store.alignment?.overallTotal ?? '—' }} 个问题 ·
        {{ store.alignment?.affectedItems ?? '—' }} 条事项</span
      >
    </header>
    <div class="wb-alignment-top">
      <label
        >检查项目<select
          v-model="store.filters.rule"
          aria-label="体检规则"
          @change="store.loadAlignment()"
        >
          <option value="">全部问题</option>
          <option v-for="(label, code) in issueNames" :key="code" :value="code">
            {{ label }}（{{ store.alignment?.counts[code] ?? 0 }}）
          </option>
        </select></label
      >
      <p>
        当日计划 <strong>{{ store.overview?.daily.minutes ?? '—' }}</strong> 分钟 ·
        {{ store.overview?.daily.total ?? '—' }} 件<span>件数和投入仅作计划提示</span>
      </p>
    </div>
    <small class="wb-check-scope"
      >未拆周任务、未安排动作按 {{ board.selection.start }} —
      {{ board.selection.end }} 检查；逾期相对账号今天
      {{ store.alignment?.asOfDate || '…' }} 判断。</small
    >
    <p v-if="store.errors.alignment" class="wb-insight-error" role="alert">
      {{ store.errors.alignment }}
      <button class="wb-link" @click="store.loadAlignment()">重试体检</button>
    </p>
    <p v-else-if="store.busy.alignment || store.updating" class="wb-loading" role="status">
      正在检查关联…
    </p>
    <template v-else>
      <div v-if="!store.alignment?.items.length" class="wb-insight-empty">
        {{
          store.alignment?.overallTotal
            ? '这类问题已处理，或当前没有匹配项。'
            : !store.overview?.annual.total &&
                !store.overview?.monthly.total &&
                !store.overview?.weekly.total &&
                !store.overview?.daily.total
              ? '还没有事项，先写下目标并安排下一步。'
              : '当前范围未发现这些规则对应的问题。'
        }}
      </div>
      <article
        v-for="issue in store.alignment?.items"
        :key="`${issue.code}:${issue.item.id}`"
        class="wb-issue"
        :data-rule="issue.code"
      >
        <span class="wb-issue-dot" aria-hidden="true">{{
          issue.code === 'overdue' ? '!' : '•'
        }}</span>
        <div>
          <strong>{{ issueNames[issue.code] }}</strong>
          <p>{{ itemNames[issue.item.type] }} · {{ issue.item.title || '未命名事项' }}</p>
          <small>{{ periodOf(issue.item) }}</small>
        </div>
        <div class="wb-issue-actions">
          <button
            v-if="issue.code === 'annual_without_monthly'"
            class="wb-button"
            @click="emit('add', 'monthly', issue.item.id)"
          >
            新增月目标
          </button>
          <button
            v-if="issue.code === 'monthly_without_weekly'"
            class="wb-button"
            @click="emit('add', 'weekly', issue.item.id)"
          >
            新增周任务
          </button>
          <button
            v-if="issue.code === 'weekly_without_daily'"
            class="wb-button"
            @click="emit('add', 'daily', issue.item.id)"
          >
            安排待办
          </button>
          <button class="wb-link" @click="emit('open', issue.item)">
            {{
              issue.code.includes('without_') &&
              ![
                'annual_without_monthly',
                'monthly_without_weekly',
                'weekly_without_daily',
              ].includes(issue.code)
                ? '查看并关联'
                : '查看 / 编辑'
            }}
          </button>
        </div>
      </article>
      <div v-if="store.alignment && store.alignment.total" class="wb-pagination">
        <span
          >{{ store.alignment.offset + 1 }}–{{
            Math.min(store.alignment.offset + store.alignment.items.length, store.alignment.total)
          }}
          / {{ store.alignment.total }} 个问题</span
        ><button
          class="wb-button"
          :disabled="store.alignment.offset === 0"
          @click="store.loadAlignment(Math.max(0, store.alignment.offset - 20))"
        >
          上一页</button
        ><button
          class="wb-button"
          :disabled="store.alignment.offset + 20 >= store.alignment.total"
          @click="store.loadAlignment(store.alignment.offset + 20)"
        >
          下一页
        </button>
      </div>
    </template>
  </section>
</template>
