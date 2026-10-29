<script setup lang="ts">
import { computed } from 'vue';
import type { WorkItem, WorkItemType, WorkItemValues } from '@workbench/contracts';
import { useWorkbenchStore } from '../stores/workbench';
import ParentPicker from './ParentPicker.vue';
import ChoicePicker from './ChoicePicker.vue';
import { useInsightsStore } from '../stores/insights';
const props = defineProps<{ item: WorkItem; index: number }>();
const emit = defineEmits<{
  remove: [item: WorkItem];
  add: [type: WorkItemType, parentId?: string];
  history: [item: WorkItem];
}>();
const store = useWorkbenchStore();
const insights = useInsightsStore();
const execution = computed(() =>
  props.item.type === 'annual'
    ? insights.overview?.annualGroups.find((g) => g.annualId === props.item.id)
    : undefined,
);
const monthlyExecution = computed(() =>
  props.item.type === 'monthly'
    ? insights.overview?.monthlyGroups.find((g) => g.monthlyId === props.item.id)
    : undefined,
);
const name = computed(
  () =>
    ({ annual: '年度目标', monthly: '月度目标', weekly: '周任务', daily: '日待办' })[
      props.item.type
    ],
);
const entry = computed(() => store.entries[props.item.id]);
const chain = computed(() => store.lineage(props.item));
const child = computed<WorkItemType | null>(
  () =>
    ({ annual: 'monthly', monthly: 'weekly', weekly: 'daily', daily: null })[
      props.item.type
    ] as WorkItemType | null,
);
const childName = computed(
  () =>
    ({ monthly: '月目标', weekly: '周任务', daily: '日待办', annual: '' })[child.value ?? 'annual'],
);
const completed = computed(() =>
  props.item.type === 'daily'
    ? props.item.done
    : props.item.type === 'weekly'
      ? props.item.status === 'done'
      : props.item.progress === 100,
);
function text(field: keyof WorkItemValues, event: Event) {
  store.edit(props.item, { [field]: (event.target as HTMLInputElement).value } as WorkItemValues);
}
function number(field: keyof WorkItemValues, event: Event) {
  store.edit(props.item, {
    [field]: Number((event.target as HTMLInputElement).value),
  } as WorkItemValues);
}
function change(field: keyof WorkItemValues, value: unknown) {
  store.edit(props.item, { [field]: value } as WorkItemValues);
  void store.save(props.item.id);
}
function addSibling() {
  emit('add', props.item.type, props.item.parentId ?? undefined);
}
</script>
<template>
  <article
    class="wb-item"
    :class="[
      `wb-item-${item.type}`,
      { 'is-complete': completed, 'has-conflict': entry?.state === 'conflict' },
    ]"
    :data-item-id="item.id"
    :data-type="item.type"
  >
    <div class="wb-item-heading">
      <input
        v-if="item.type === 'daily'"
        class="wb-checkbox"
        type="checkbox"
        :checked="item.done"
        :aria-label="`完成${item.title || '日待办'}`"
        @change="change('done', ($event.target as HTMLInputElement).checked)"
      />
      <span v-else-if="item.type === 'annual'" class="wb-order">{{
        String(index + 1).padStart(2, '0')
      }}</span>
      <input
        class="wb-title-input"
        :value="item.title"
        :aria-label="`${name}标题`"
        :data-title-id="item.id"
        :placeholder="`点击填写${name}，回车继续新增`"
        maxlength="500"
        @input="text('title', $event)"
        @blur="store.save(item.id)"
        @keydown.enter.prevent="addSibling"
      />
      <button
        class="wb-delete"
        type="button"
        :aria-label="`删除${name}`"
        :disabled="store.actionBusy"
        @click="emit('remove', item)"
      >
        ×
      </button>
    </div>
    <textarea
      v-if="item.type !== 'daily'"
      class="wb-note-input"
      :value="item.note"
      :aria-label="`${name}说明`"
      :placeholder="item.type === 'annual' ? '衡量标准 / 完成标志' : '补充说明 / 交付物'"
      rows="2"
      maxlength="10000"
      @input="text('note', $event)"
      @blur="store.save(item.id)"
    />

    <div v-if="item.type === 'annual' || item.type === 'monthly'" class="wb-progress">
      <div>
        <span>{{ item.type === 'annual' ? '年度手动进度' : '本月手动进度' }}</span
        ><strong>{{ item.progress }}%</strong>
      </div>
      <div class="wb-progress-track"><span :style="{ width: `${item.progress}%` }" /></div>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        :value="item.progress"
        :aria-label="`${name}进度`"
        @input="number('progress', $event)"
        @change="store.save(item.id)"
      />
    </div>

    <div class="wb-item-meta">
      <label
        v-if="item.type === 'annual' || item.type === 'monthly'"
        class="wb-field wb-small-field"
        >权重<input
          type="number"
          min="0"
          max="100"
          step="0.1"
          :value="item.weight"
          :aria-label="`${name}权重`"
          @input="number('weight', $event)"
          @blur="store.save(item.id)"
        />%</label
      >
      <label v-if="item.type === 'annual'" class="wb-field"
        >年度<input
          type="number"
          min="1970"
          max="9999"
          :value="item.year"
          aria-label="目标所属年度"
          @change="number('year', $event)"
      /></label>
      <label v-if="item.type === 'monthly'" class="wb-field"
        >所属<input
          type="month"
          :value="item.month"
          aria-label="目标所属月份"
          @change="text('month', $event)"
      /></label>
      <label v-if="item.type === 'monthly'" class="wb-field"
        >截止<input
          type="date"
          :value="item.dueDate ?? ''"
          aria-label="月度目标截止日期"
          @change="change('dueDate', ($event.target as HTMLInputElement).value || null)"
      /></label>
      <template v-if="item.type === 'weekly'">
        <div class="wb-field">
          优先级<ChoicePicker
            :model-value="item.priority ?? 'P1'"
            label="周任务优先级"
            :options="[
              { value: 'P0', label: 'P0 · 必须' },
              { value: 'P1', label: 'P1 · 重要' },
              { value: 'P2', label: 'P2 · 有空做' },
            ]"
            @update:model-value="(v) => change('priority', v)"
          />
        </div>
        <div class="wb-field">
          状态<ChoicePicker
            :model-value="item.status ?? 'todo'"
            label="周任务状态"
            :options="[
              { value: 'todo', label: '未开始' },
              { value: 'doing', label: '进行中' },
              { value: 'block', label: '受阻' },
              { value: 'done', label: '已完成' },
            ]"
            @update:model-value="(v) => change('status', v)"
          />
        </div>
        <label class="wb-field"
          >开始<input
            type="date"
            :value="item.startDate"
            aria-label="周任务开始日期"
            @change="text('startDate', $event)"
        /></label>
        <label class="wb-field"
          >结束<input
            type="date"
            :value="item.endDate"
            aria-label="周任务结束日期"
            @change="text('endDate', $event)"
        /></label>
      </template>
      <template v-if="item.type === 'daily'">
        <label class="wb-field wb-small-field"
          >预计<input
            type="number"
            min="0"
            max="1440"
            step="5"
            :value="item.minutes"
            aria-label="待办预计分钟数"
            @input="number('minutes', $event)"
            @blur="store.save(item.id)"
          />分钟</label
        >
        <label class="wb-field"
          >日期<input
            type="date"
            :value="item.date"
            aria-label="待办执行日期"
            @change="text('date', $event)"
        /></label>
      </template>
      <ParentPicker v-if="item.type !== 'annual'" :item="item" />
    </div>
    <div v-if="item.type !== 'annual'" class="wb-schedule-meta">
      <span
        >原计划
        {{
          item.originalDate ||
          item.originalMonth ||
          `${item.originalStartDate} — ${item.originalEndDate}`
        }}
        · 顺延 {{ item.rolloverCount || 0 }} 次</span
      ><button type="button" class="wb-link" @click="emit('history', item)">排期记录</button>
    </div>
    <div v-if="item.type !== 'annual'" class="wb-lineage">
      <span v-if="!chain.length" class="wb-unlinked">尚未关联上级事项</span>
      <span v-for="parent in chain" :key="parent.id"
        >{{ { annual: '年', monthly: '月', weekly: '周', daily: '日' }[parent.type] }} →
        <strong>{{ parent.title || '未命名目标' }}</strong></span
      >
    </div>
    <div v-if="execution" class="wb-annual-counts" aria-label="目标下级完成统计">
      <span
        >关联事项 <strong>{{ execution.completed }} / {{ execution.total }}</strong> 已完成</span
      ><small
        >月 {{ execution.byType.monthly.completed }}/{{ execution.byType.monthly.total }} · 周
        {{ execution.byType.weekly.completed }}/{{ execution.byType.weekly.total }} · 日
        {{ execution.byType.daily.completed }}/{{ execution.byType.daily.total }}</small
      >
    </div>
    <div v-if="monthlyExecution" class="wb-annual-counts" aria-label="月目标下级完成统计">
      <span
        >关联事项
        <strong>{{ monthlyExecution.completed }} / {{ monthlyExecution.total }}</strong>
        已完成</span
      ><small
        >周 {{ monthlyExecution.byType.weekly.completed }}/{{
          monthlyExecution.byType.weekly.total
        }}
        · 日 {{ monthlyExecution.byType.daily.completed }}/{{
          monthlyExecution.byType.daily.total
        }}</small
      >
    </div>
    <div class="wb-item-footer">
      <small class="wb-item-save" :class="entry?.state" role="status">{{
        entry?.state === 'saving' || entry?.state === 'pending'
          ? '本机已保存 · 待同步'
          : entry?.state === 'error'
            ? '保存失败'
            : entry?.state === 'conflict'
              ? '需要处理版本冲突'
              : '✓ 已保存'
      }}</small>
      <button
        v-if="child"
        class="wb-link"
        type="button"
        :disabled="store.creating"
        @click="emit('add', child, item.id)"
      >
        + 拆为{{ childName }}
      </button>
    </div>
    <div v-if="entry?.state === 'error'" class="wb-item-error" role="alert">
      <span>{{ entry.message }}</span
      ><button type="button" @click="store.save(item.id)">重试保存</button>
    </div>
    <div v-if="entry?.state === 'conflict'" class="wb-conflict" role="alert">
      <strong>另一页面已更新这条事项，你的修改仍保存在本机。</strong>
      <p>
        云端标题：{{ entry.remote?.title || '未命名' }}；当前进度/状态：{{
          entry.remote?.progress ??
          entry.remote?.status ??
          (entry.remote?.done ? '已完成' : '未完成')
        }}
      </p>
      <button type="button" @click="store.resolveConflict(item.id, false)">采用云端版本</button
      ><button
        v-if="!entry.remote?.deletedAt"
        type="button"
        @click="store.resolveConflict(item.id, true)"
      >
        保留我的修改
      </button>
    </div>
  </article>
</template>
