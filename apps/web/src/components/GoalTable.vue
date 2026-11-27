<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  effectiveProgress,
  hasProgressChildren,
  itemComplete,
  itemState,
  weightedProgress,
  type WorkItem,
  type WorkItemType,
  type WorkItemValues,
} from '@workbench/contracts';
import { useWorkbenchStore } from '../stores/workbench';
import ParentPicker from './ParentPicker.vue';
import ChoicePicker from './ChoicePicker.vue';
import { newestFirst } from '../lib/item-order';
const props = defineProps<{ type: 'annual' | 'monthly' }>();
const emit = defineEmits<{
  open: [item: WorkItem];
  remove: [item: WorkItem];
  add: [type: WorkItemType, parentId?: string];
}>();
const board = useWorkbenchStore();
const filter = ref('all'),
  search = ref(''),
  limit = ref(50);
const all = computed(() => Object.values(board.records).sort(newestFirst));
const goals = computed(() =>
  all.value.filter(
    (v) =>
      v.type === props.type &&
      !v.deletedAt &&
      !v.archivedAt &&
      (props.type === 'annual'
        ? v.year === board.selection.year
        : v.month === board.selection.month),
  ),
);
const rows = computed(() =>
  goals.value.filter(
    (v) =>
      (!search.value ||
        `${v.title} ${v.note}`.toLowerCase().includes(search.value.toLowerCase())) &&
      (filter.value === 'all' ||
        (filter.value === 'incomplete'
          ? !v.terminated && !itemComplete(v, all.value)
          : itemState(v, all.value) === filter.value)),
  ),
);
watch([filter, search, () => board.selection.year, () => board.selection.month], () => {
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
const weight = computed(() =>
  Number(
    goals.value
      .filter((v) => !v.terminated)
      .reduce((sum, v) => sum + (v.weight ?? 0), 0)
      .toFixed(4),
  ),
);
const states = {
  all: '全部',
  incomplete: '未完成',
  doing: '进行中',
  complete: '已完成',
  todo: '未开始',
  terminated: '已终止',
};
const stateCount = (key: string) =>
  goals.value.filter(
    (v) =>
      key === 'all' ||
      (key === 'incomplete'
        ? !v.terminated && !itemComplete(v, all.value)
        : itemState(v, all.value) === key),
  ).length;
const weightState = computed(() =>
  weight.value > 100 ? 'over' : weight.value === 100 ? 'balanced' : 'under',
);
const weightDifference = computed(() => Number(Math.abs(weight.value - 100).toFixed(2)));
function edit(item: WorkItem, field: keyof WorkItemValues, event: Event, number = false) {
  const value = (event.target as HTMLInputElement).value;
  board.edit(item, {
    [field]: number ? Number(value) : field === 'dueDate' ? value || null : value,
  });
}
const name = computed(() => (props.type === 'annual' ? '年度目标' : '月度目标'));
const children = (item: WorkItem) =>
  all.value.filter((v) => v.parentId === item.id && !v.deletedAt && !v.archivedAt);
const monthSummaries = computed(() => {
  const result = new Map<
    string,
    { progress: number | null; complete: number; incomplete: number; terminated: number }
  >();
  for (const goal of goals.value) {
    const months = children(goal).filter((v) => v.type === 'monthly');
    const active = months.filter((v) => !v.terminated);
    const complete = active.filter((v) => itemComplete(v, all.value)).length;
    result.set(goal.id, {
      progress: weightedProgress(
        active.filter((v) => v.month === board.selection.month),
        (v) => effectiveProgress(v, all.value),
      ),
      complete,
      incomplete: active.length - complete,
      terminated: months.length - active.length,
    });
  }
  return result;
});
function stateOptions(item: WorkItem) {
  const state = itemState(item, all.value);
  const childAutomatic = hasProgressChildren(item, all.value);
  if (childAutomatic)
    return [
      { value: 'active', label: item.terminated ? '恢复执行' : states[state] },
      { value: 'terminated', label: '已终止' },
    ];
  const automatic = props.type === 'annual' && item.progressMode === 'auto';
  return [
    { value: 'active', label: item.terminated ? '恢复执行' : states[state] },
    ...(state === 'todo'
      ? [{ value: 'start', label: automatic ? '切换手动并开始（1%）' : '开始执行（1%）' }]
      : []),
    ...(!item.terminated && state !== 'complete'
      ? [{ value: 'finish', label: automatic ? '切换手动并完成（100%）' : '标记完成（100%）' }]
      : []),
    ...(!item.terminated && state !== 'todo'
      ? [{ value: 'reset', label: automatic ? '切换手动并重置（0%）' : '重置为未开始（0%）' }]
      : []),
    { value: 'terminated', label: '已终止' },
  ];
}
function changeState(item: WorkItem, value: string) {
  if (value === 'active' || value === 'terminated') {
    board.edit(item, { terminated: value === 'terminated' });
    return;
  }
  const progress =
    value === 'start' ? 1 : value === 'finish' ? 100 : value === 'reset' ? 0 : undefined;
  if (progress === undefined) return;
  board.edit(item, {
    terminated: false,
    progress,
    ...(props.type === 'annual' ? { progressMode: 'manual' as const } : {}),
  });
}
</script>
<template>
  <div class="wb-goal-table">
    <div class="wb-table-filters">
      <div class="wb-filter-tabs" :aria-label="`${name}完成筛选`">
        <button
          v-for="(label, key) in states"
          :key="key"
          type="button"
          :aria-pressed="filter === key"
          @click="filter = key"
        >
          {{ label }} <strong>{{ stateCount(key) }}</strong>
        </button>
      </div>
      <label class="wb-table-search"
        >搜索<input
          v-model="search"
          :aria-label="`搜索${name}`"
          placeholder="标题或说明"
          type="search"
      /></label>
      <small class="wb-weight-badge" :class="weightState" :data-weight-state="weightState">
        权重合计 {{ Number(weight.toFixed(2)) }}%
        {{
          weightState === 'balanced'
            ? '✓ 已配平'
            : weightState === 'over'
              ? `⚠ 超出 ${weightDifference}%`
              : `· 尚差 ${weightDifference}%`
        }}
      </small>
    </div>
    <table v-if="rows.length" class="wb-goals-table" :class="{ 'is-annual': type === 'annual' }">
      <caption class="sr-only">
        {{
          name
        }}，可直接编辑，修改后自动保存
      </caption>
      <thead>
        <tr>
          <th scope="col">目标 / 衡量标准</th>
          <th v-if="type === 'monthly'" scope="col">年度来源</th>
          <th scope="col">权重</th>
          <th scope="col">{{ type === 'annual' ? '预计完成' : '截止日期' }}</th>
          <th scope="col">{{ type === 'annual' ? '年度进度' : '进度' }}</th>
          <th v-if="type === 'annual'" scope="col">
            本月进度<small class="wb-month-context">{{ board.selection.month }}</small>
          </th>
          <th v-if="type === 'annual'" scope="col">
            月度完成<small class="wb-month-context">全部关联月份</small>
          </th>
          <th scope="col">状态</th>
          <th v-if="type === 'monthly'" scope="col">拆解与操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in rows.slice(0, limit)"
          :key="item.id"
          :data-item-id="item.id"
          :data-type="item.type"
          :class="{ 'is-complete': itemComplete(item, all) }"
        >
          <td data-label="目标 / 衡量标准" class="wb-table-title">
            <input
              class="wb-title-input"
              :value="item.title"
              :data-title-id="item.id"
              :aria-label="`${name}标题`"
              placeholder="点击填写目标"
              maxlength="500"
              @input="edit(item, 'title', $event)"
              @blur="board.save(item.id)"
              @keydown.enter.prevent="emit('add', type, item.parentId ?? undefined)"
            />
            <textarea
              class="wb-note-input"
              :value="item.note"
              :aria-label="`${name}说明`"
              placeholder="衡量标准 / 交付物"
              rows="1"
              maxlength="10000"
              @input="edit(item, 'note', $event)"
              @blur="board.save(item.id)"
            />
            <div class="wb-goal-title-footer">
              <small class="wb-table-save" :class="board.entries[item.id]?.state">{{
                board.entries[item.id]?.state === 'conflict'
                  ? '需要处理版本冲突'
                  : board.entries[item.id]?.state === 'error'
                    ? '保存失败，草稿已保留'
                    : board.entries[item.id]?.state
                      ? '本机已保存 · 待同步'
                      : '✓ 已保存'
              }}</small>
              <button
                v-if="['conflict', 'error'].includes(board.entries[item.id]?.state ?? '')"
                class="wb-link"
                type="button"
                @click="emit('open', item)"
              >
                查看并处理草稿
              </button>
              <div v-if="type === 'annual'" class="wb-table-row-actions wb-annual-row-actions">
                <button type="button" class="wb-link" @click="emit('add', 'monthly', item.id)">
                  + 拆月目标
                </button>
                <button type="button" class="wb-link" @click="emit('open', item)">详情</button>
                <button
                  type="button"
                  class="wb-delete"
                  aria-label="删除年度目标"
                  @click="emit('remove', item)"
                >
                  ×
                </button>
              </div>
            </div>
          </td>
          <td v-if="type === 'monthly'" data-label="年度来源">
            <ParentPicker :item="item" />
          </td>
          <td data-label="权重">
            <label class="wb-table-number"
              ><input
                type="number"
                min="0"
                max="100"
                step="0.1"
                :value="item.weight"
                :aria-label="`${name}权重`"
                @input="edit(item, 'weight', $event, true)"
                @blur="board.save(item.id)"
              /><span>%</span></label
            >
          </td>
          <td :data-label="type === 'annual' ? '预计完成' : '截止日期'">
            <input
              class="wb-table-date"
              type="date"
              :value="item.dueDate ?? ''"
              :aria-label="`${name}截止日期`"
              @change="edit(item, 'dueDate', $event)"
            />
          </td>
          <td :data-label="type === 'annual' ? '年度进度' : '进度'">
            <div class="wb-table-progress">
              <label
                v-if="
                  (type !== 'annual' || item.progressMode !== 'auto') &&
                  !hasProgressChildren(item, all)
                "
                class="wb-table-number"
                ><input
                  type="number"
                  min="0"
                  max="100"
                  :value="item.progress"
                  :aria-label="`${name}进度`"
                  @input="edit(item, 'progress', $event, true)"
                  @blur="board.save(item.id)"
                /><span>%</span></label
              >
              <strong v-else :data-auto-progress="item.id"
                >{{ effectiveProgress(item, all) }}%</strong
              >
              <small v-if="hasProgressChildren(item, all)">按关联周任务自动汇总</small>
              <div class="wb-progress-track">
                <span :style="{ width: `${effectiveProgress(item, all)}%` }" />
              </div>
              <ChoicePicker
                v-if="type === 'annual'"
                class="wb-progress-mode"
                :model-value="item.progressMode ?? 'manual'"
                label="年度进度模式"
                :options="[
                  { value: 'auto', label: '月目标自动汇总' },
                  { value: 'manual', label: '手动填写' },
                ]"
                @update:model-value="
                  (v) => board.edit(item, { progressMode: v as 'manual' | 'auto' })
                "
              />
              <small
                v-if="item.progressMode === 'auto'"
                :title="`切换回手动模式可继续使用已保留的 ${item.progress}% 进度`"
                >手动值 {{ item.progress }}% 已保留</small
              >
            </div>
          </td>
          <td
            v-if="type === 'annual'"
            :data-label="`本月进度（${board.selection.month}）`"
            :data-month-progress="item.id"
          >
            <strong
              class="wb-month-progress"
              :title="`${board.selection.month} 月目标按权重汇总；已终止项不计入`"
              >{{
                monthSummaries.get(item.id)?.progress == null
                  ? '—'
                  : `${monthSummaries.get(item.id)!.progress}%`
              }}</strong
            >
            <small
              v-if="monthSummaries.get(item.id)?.progress == null"
              class="wb-month-context"
              title="所选月份没有关联的月目标，或有效权重合计为 0"
              >暂无本月进度</small
            >
          </td>
          <td
            v-if="type === 'annual'"
            data-label="月度完成（全部关联月份）"
            :data-month-completion="item.id"
          >
            <div class="wb-month-counts" aria-label="全部关联月目标完成数量">
              <span
                class="is-done"
                :aria-label="`已完成 ${monthSummaries.get(item.id)?.complete} 项月目标`"
                >已完成 {{ monthSummaries.get(item.id)?.complete }} 项</span
              >
              <span :aria-label="`未完成 ${monthSummaries.get(item.id)?.incomplete} 项月目标`"
                >未完成 {{ monthSummaries.get(item.id)?.incomplete }} 项</span
              >
              <span
                v-if="monthSummaries.get(item.id)?.terminated"
                :aria-label="`已终止 ${monthSummaries.get(item.id)?.terminated} 项月目标`"
                >已终止 {{ monthSummaries.get(item.id)?.terminated }} 项</span
              >
            </div>
          </td>
          <td data-label="状态">
            <ChoicePicker
              class="wb-goal-state"
              :class="`is-${itemState(item, all)}`"
              :model-value="item.terminated ? 'terminated' : 'active'"
              :label="`${name}执行状态`"
              :options="stateOptions(item)"
              @update:model-value="(v) => changeState(item, v)"
            />
            <input
              v-if="item.terminated"
              class="wb-termination-reason"
              aria-label="终止原因"
              placeholder="记录终止原因"
              :value="item.terminationReason ?? ''"
              @input="edit(item, 'terminationReason', $event)"
              @blur="board.save(item.id)"
            />
          </td>
          <td v-if="type === 'monthly'" data-label="拆解与操作">
            <small
              >{{ children(item).filter((v) => itemComplete(v, all)).length }}/{{
                children(item).length
              }}
              项下级完成</small
            >
            <div class="wb-table-row-actions">
              <button type="button" class="wb-link" @click="emit('add', 'weekly', item.id)">
                + 拆周任务</button
              ><button type="button" class="wb-link" @click="emit('open', item)">详情</button
              ><button
                type="button"
                class="wb-delete"
                :aria-label="`删除${name}`"
                @click="emit('remove', item)"
              >
                ×
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="wb-insight-empty">当前筛选没有匹配目标。</p>
    <p v-if="type === 'monthly'" class="wb-goal-state-help">
      新增未完成月目标时，自动生成一条同名周任务并保留月目标关联；可继续拆分更多周任务。单独修改周任务标题后，保留你的修改。
    </p>
    <p v-if="rows.length" class="wb-goal-state-help">
      状态随进度更新：0% 未开始，1%–99% 进行中，100%
      已完成。可从状态菜单开始执行或标记完成；自动汇总时修改月目标进度即可，手动操作会明确切换进度模式。
    </p>
    <p
      v-if="goals.length"
      class="wb-weight-summary"
      :class="weightState"
      role="status"
      aria-live="polite"
    >
      {{ type === 'annual' ? `${board.selection.year} 年` : board.selection.month }}共
      {{ goals.length }} 项{{ name }}，权重合计 {{ Number(weight.toFixed(2)) }}% —
      <template v-if="weightState === 'over'"
        >已超出 {{ weightDifference }}%，请调整权重，使合计为 100%。</template
      >
      <template v-else-if="weightState === 'balanced'">已配平 100%，加权进度口径正常。</template>
      <template v-else>尚差 {{ weightDifference }}%，请继续分配权重。</template>
      <small v-if="weightState !== 'balanced'">进度仍按实际权重归一计算。</small>
      <small v-if="goals.some((v) => v.terminated)">已终止项不计入权重与进度；下级事项保留。</small>
    </p>
    <button v-if="rows.length > limit" type="button" class="wb-load-more" @click="limit += 50">
      加载更多（{{ limit }}/{{ rows.length }}）
    </button>
  </div>
</template>
