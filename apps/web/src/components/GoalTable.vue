<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  effectiveProgress,
  itemComplete,
  type WorkItem,
  type WorkItemType,
  type WorkItemValues,
} from '@workbench/contracts';
import { useWorkbenchStore } from '../stores/workbench';
import ParentPicker from './ParentPicker.vue';
import ChoicePicker from './ChoicePicker.vue';
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
const all = computed(() => Object.values(board.records));
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
      (filter.value === 'all' || itemComplete(v, all.value) === (filter.value === 'complete')),
  ),
);
watch([filter, search, () => board.selection.year, () => board.selection.month], () => {
  limit.value = 50;
});
const weight = computed(() => goals.value.reduce((sum, v) => sum + (v.weight ?? 0), 0));
function edit(item: WorkItem, field: keyof WorkItemValues, event: Event, number = false) {
  const value = (event.target as HTMLInputElement).value;
  board.edit(item, {
    [field]: number ? Number(value) : field === 'dueDate' ? value || null : value,
  });
}
const name = computed(() => (props.type === 'annual' ? '年度目标' : '月度目标'));
const children = (item: WorkItem) =>
  all.value.filter((v) => v.parentId === item.id && !v.deletedAt && !v.archivedAt);
</script>
<template>
  <div class="wb-goal-table">
    <div class="wb-table-filters">
      <div class="wb-filter-tabs" :aria-label="`${name}完成筛选`">
        <button
          v-for="(label, key) in { all: '全部', incomplete: '未完成', complete: '已完成' }"
          :key="key"
          type="button"
          :aria-pressed="filter === key"
          @click="filter = key"
        >
          {{ label }}
        </button>
      </div>
      <label class="wb-table-search"
        >搜索<input
          v-model="search"
          :aria-label="`搜索${name}`"
          placeholder="标题或说明"
          type="search"
      /></label>
      <small>权重合计 {{ Number(weight.toFixed(1)) }}% · 按实际权重归一计算</small>
    </div>
    <table v-if="rows.length" class="wb-goals-table">
      <caption class="sr-only">
        {{
          name
        }}，可直接编辑，修改后自动保存
      </caption>
      <thead>
        <tr>
          <th scope="col">目标 / 衡量标准</th>
          <th scope="col">{{ type === 'annual' ? '进度模式' : '年度来源' }}</th>
          <th scope="col">权重</th>
          <th scope="col">{{ type === 'annual' ? '预计完成' : '截止日期' }}</th>
          <th scope="col">进度</th>
          <th scope="col">拆解与操作</th>
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
              rows="2"
              maxlength="10000"
              @input="edit(item, 'note', $event)"
              @blur="board.save(item.id)"
            />
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
          </td>
          <td :data-label="type === 'annual' ? '进度模式' : '年度来源'">
            <ChoicePicker
              v-if="type === 'annual'"
              :model-value="item.progressMode ?? 'manual'"
              label="年度进度模式"
              :options="[
                { value: 'manual', label: '手动填写' },
                { value: 'auto', label: '月目标自动汇总' },
              ]"
              @update:model-value="
                (v) => board.edit(item, { progressMode: v as 'manual' | 'auto' })
              "
            />
            <ParentPicker v-else :item="item" />
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
          <td data-label="进度">
            <div class="wb-table-progress">
              <label
                v-if="type !== 'annual' || item.progressMode !== 'auto'"
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
              <div class="wb-progress-track">
                <span :style="{ width: `${effectiveProgress(item, all)}%` }" />
              </div>
              <small v-if="item.progressMode === 'auto'"
                >自动 · 手动值 {{ item.progress }}% 保留</small
              >
            </div>
          </td>
          <td data-label="拆解与操作">
            <small
              >{{ children(item).filter((v) => itemComplete(v, all)).length }}/{{
                children(item).length
              }}
              项下级完成</small
            >
            <div class="wb-table-row-actions">
              <button
                type="button"
                class="wb-link"
                @click="emit('add', type === 'annual' ? 'monthly' : 'weekly', item.id)"
              >
                {{ type === 'annual' ? '+ 拆月目标' : '+ 拆周任务' }}</button
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
    <button v-if="rows.length > limit" type="button" class="wb-load-more" @click="limit += 50">
      加载更多（{{ limit }}/{{ rows.length }}）
    </button>
  </div>
</template>
