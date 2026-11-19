<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { itemComplete, itemState, type WorkItem, type WorkItemType } from '@workbench/contracts';
import { useWorkbenchStore } from '../stores/workbench';
import { dayLabel, todayIn } from '../lib/dates';
import WorkItemCard from './WorkItemCard.vue';
import { newestFirst } from '../lib/item-order';
const emit = defineEmits<{
  open: [item: WorkItem];
  remove: [item: WorkItem];
  history: [item: WorkItem];
  add: [type: WorkItemType, parentId?: string, date?: string];
}>();
const board = useWorkbenchStore();
const opened = ref<Record<string, boolean>>({});
const limit = ref(50);
const all = computed(() =>
  Object.values(board.records)
    .filter((v) => !v.deletedAt && !v.archivedAt)
    .sort(newestFirst),
);
const weekFilter = ref('all');
const weekStates = {
  all: '全部',
  incomplete: '未完成',
  doing: '进行中',
  complete: '已完成',
  todo: '未开始',
  terminated: '已终止',
};
const monthGoals = computed(() =>
  all.value.filter(
    (v) =>
      v.type === 'monthly' &&
      !v.terminated &&
      !itemComplete(v, all.value) &&
      (v.month === board.selection.month ||
        (v.month! >= board.selection.start.slice(0, 7) &&
          v.month! <= board.selection.end.slice(0, 7))),
  ),
);
const unplannedMonths = computed(() =>
  monthGoals.value.filter((m) => !weeks.value.some((w) => w.parentId === m.id && !w.terminated)),
);
const weeks = computed(() =>
  all.value.filter(
    (v) =>
      v.type === 'weekly' &&
      v.startDate! <= board.selection.end &&
      v.endDate! >= board.selection.start,
  ),
);
const days = computed(() => all.value.filter((v) => v.type === 'daily'));
const extraWeeks = computed(() => {
  const ids = new Set(
    days.value
      .filter((d) => d.date! >= board.selection.start && d.date! <= board.selection.end)
      .map((d) => d.parentId),
  );
  const selected = new Set(weeks.value.map((v) => v.id));
  return all.value.filter((v) => v.type === 'weekly' && ids.has(v.id) && !selected.has(v.id));
});
const weekCandidates = computed(() =>
  [...weeks.value, ...extraWeeks.value].sort(
    (a, b) =>
      (a.terminated ? 2 : itemComplete(a) ? 1 : 0) - (b.terminated ? 2 : itemComplete(b) ? 1 : 0) ||
      newestFirst(a, b),
  ),
);
const weekMatches = (v: WorkItem, key: string) =>
  key === 'all' ||
  (key === 'incomplete' ? !v.terminated && !itemComplete(v) : itemState(v) === key);
const displayedWeeks = computed(() =>
  weekCandidates.value.filter((v) => weekMatches(v, weekFilter.value)),
);
const orphans = computed(() =>
  days.value.filter(
    (d) =>
      !all.value.some((v) => v.id === d.parentId && v.type === 'weekly') &&
      d.date! >= board.selection.start &&
      d.date! <= board.selection.end,
  ),
);
const children = (id: string) =>
  id === 'unlinked' ? orphans.value : days.value.filter((d) => d.parentId === id);
const remainingLabel = computed(() =>
  board.selection.date === (board.serverDate || todayIn()) ? '今日剩' : '所选日剩',
);
const remaining = (id: string) =>
  children(id).filter((d) => d.date === board.selection.date && !d.done && !d.terminated).length;
watch(
  [days, weeks, () => board.selection.date],
  () => {
    for (const id of displayedWeeks.value.map((v) => v.id))
      if (opened.value[id] === undefined && children(id).length)
        opened.value[id] = children(id).some((d) => d.date === board.selection.date && !d.done);
  },
  { immediate: true },
);
const isOpen = (id: string) =>
  opened.value[id] ??
  (id === 'unlinked'
    ? false
    : children(id).some((d) => d.date === board.selection.date && !d.done && !d.terminated));
const allOpen = computed(
  () =>
    displayedWeeks.value.every((w) => isOpen(w.id)) &&
    (!orphans.value.length || isOpen('unlinked')),
);
function expandAll() {
  const next = !allOpen.value;
  for (const row of displayedWeeks.value) opened.value[row.id] = next;
  opened.value.unlinked = next;
}
function groups(id: string) {
  const grouped = new Map<string, WorkItem[]>();
  for (const day of children(id)) {
    const list = grouped.get(day.date!) ?? [];
    list.push(day);
    grouped.set(day.date!, list);
  }
  return [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({ date, items }));
}
watch(
  () => `${board.selection.start}/${board.selection.end}`,
  () => {
    limit.value = 50;
  },
);
</script>
<template>
  <section class="wb-section wb-weekly-execution" aria-label="周任务">
    <header class="wb-section-header">
      <span class="wb-level weekly">周</span>
      <div>
        <h2>周任务</h2>
        <p>按区间交集展示任务，展开查看按日期分组的每日工作。</p>
      </div>
      <span class="wb-count"
        >{{ weeks.length }} 项<template v-if="extraWeeks.length">
          · {{ extraWeeks.length }} 个区间外来源</template
        ></span
      ><button
        class="wb-button"
        type="button"
        :disabled="!displayedWeeks.length && !orphans.length"
        @click="expandAll"
      >
        {{ allOpen ? '全部收起' : '全部展开' }}</button
      ><button
        class="wb-button primary"
        type="button"
        data-add-type="weekly"
        :disabled="board.creating"
        @click="emit('add', 'weekly')"
      >
        + 新增周任务</button
      ><button
        class="wb-button"
        type="button"
        data-add-type="daily"
        :disabled="board.creating"
        @click="emit('add', 'daily')"
      >
        + 新增当日待办
      </button>
    </header>
    <div class="wb-filter-tabs" aria-label="周任务状态筛选">
      <button
        v-for="(label, key) in weekStates"
        :key="key"
        type="button"
        :aria-pressed="weekFilter === key"
        @click="weekFilter = key"
      >
        {{ label }} <strong>{{ weekCandidates.filter((v) => weekMatches(v, key)).length }}</strong>
      </button>
    </div>
    <p class="wb-month-sources">
      月目标自动带入：本期 {{ monthGoals.length }} 项，已安排本周任务
      {{ monthGoals.length - unplannedMonths.length }} 项，待安排 {{ unplannedMonths.length }} 项。
      待安排月目标列在周任务下方，可直接安排本周任务。
    </p>
    <div v-if="!displayedWeeks.length && !orphans.length && !board.loading" class="wb-empty">
      <span class="wb-empty-symbol">周</span>
      <h3>让月度目标有具体的推进动作</h3>
      <p>先新增周任务，再展开安排每天的工作。</p>
      <button class="wb-link" type="button" @click="emit('add', 'weekly')">
        + 创建第一条周任务
      </button>
    </div>
    <article
      v-for="(week, index) in displayedWeeks.slice(0, limit)"
      :key="week.id"
      class="wb-week-group"
      :data-week-group="week.id"
    >
      <p v-if="extraWeeks.some((v) => v.id === week.id)" class="wb-external-week-source">
        区间外周任务来源 · 此任务下有本区间的每日工作，保留展示。
      </p>
      <WorkItemCard
        :item="week"
        :index="index"
        @remove="emit('remove', $event)"
        @history="emit('history', $event)"
        @add="(type, parent) => emit('add', type, parent)"
      />
      <div class="wb-week-day-toolbar">
        <button
          class="wb-expand-days"
          type="button"
          :aria-expanded="isOpen(week.id)"
          :aria-controls="`days-${week.id}`"
          @click="opened[week.id] = !isOpen(week.id)"
        >
          <span aria-hidden="true">{{ isOpen(week.id) ? '▾' : '▸' }}</span>
          每日工作 {{ children(week.id).length }} 条
          <span v-if="remaining(week.id)" class="wb-days-remaining"
            >· {{ remainingLabel }} {{ remaining(week.id) }}</span
          >
          <span v-else-if="children(week.id).length"
            >· 已完成 {{ children(week.id).filter((d) => d.done && !d.terminated).length }} 条</span
          ></button
        ><button
          type="button"
          class="wb-link"
          @click="
            opened[week.id] = true;
            emit('add', 'daily', week.id, board.selection.date);
          "
        >
          + 在所选日期记一条
        </button>
      </div>
      <div v-if="isOpen(week.id)" :id="`days-${week.id}`" class="wb-embedded-days">
        <p v-if="!children(week.id).length" class="wb-insight-empty">
          还没有每日工作，点击上方新增。
        </p>
        <section v-for="group in groups(week.id)" :key="group.date" class="wb-day-group">
          <header>
            <h3>
              {{ dayLabel(group.date) }}
              <span v-if="group.date === board.selection.date">所选日期</span>
            </h3>
            <small
              >{{ group.items.filter((d) => d.done).length }}/{{ group.items.length }} 完成</small
            ><button
              class="wb-link"
              type="button"
              @click="emit('add', 'daily', week.id, group.date)"
            >
              + 加一条
            </button>
          </header>
          <WorkItemCard
            v-for="(day, i) in group.items"
            :key="day.id"
            :item="day"
            :index="i"
            compact
            @remove="emit('remove', $event)"
            @history="emit('history', $event)"
            @add="(type, parent) => emit('add', type, parent, group.date)"
          />
        </section>
      </div>
    </article>
    <button
      v-if="displayedWeeks.length > limit"
      type="button"
      class="wb-load-more"
      @click="limit += 50"
    >
      加载更多周任务（{{ limit }}/{{ displayedWeeks.length }}）
    </button>
    <details v-if="unplannedMonths.length" class="wb-unplanned-months" open>
      <summary>本周未安排周任务的月目标 {{ unplannedMonths.length }} 项</summary>
      <p class="wb-month-planning-note">这些月目标已自动带入周视图，可直接安排并关联本周任务。</p>
      <article v-for="goal in unplannedMonths" :key="goal.id" :data-unplanned-month="goal.id">
        <div>
          <strong>{{ goal.title || '未命名月目标' }}</strong>
          <p>{{ goal.month }} · {{ goal.note || '尚未填写交付物' }}</p>
        </div>
        <button type="button" class="wb-link" @click="emit('open', goal)">查看月目标</button>
        <button
          type="button"
          class="wb-button"
          :disabled="board.creating"
          @click="emit('add', 'weekly', goal.id)"
        >
          + 安排本周任务
        </button>
      </article>
    </details>
    <article v-if="orphans.length" class="wb-unlinked-days">
      <header class="wb-section-header">
        <div>
          <h3>未挂周任务的待办 {{ orphans.length }} 条</h3>
          <p>这些每日待办尚未关联周任务，展开可查看内容、填写工作情况或补充关联。</p>
        </div>
        <button
          type="button"
          class="wb-expand-days wb-unlinked-toggle"
          :aria-label="`${isOpen('unlinked') ? '收起' : '展开'}未挂周任务的待办`"
          :aria-expanded="isOpen('unlinked')"
          aria-controls="wb-unlinked-day-list"
          @click="opened.unlinked = !isOpen('unlinked')"
        >
          <span aria-hidden="true">{{ isOpen('unlinked') ? '▾' : '▸' }}</span>
          {{ orphans.length }} 条
          <span class="wb-days-remaining">· {{ remainingLabel }} {{ remaining('unlinked') }}</span>
        </button>
      </header>
      <div v-if="isOpen('unlinked')" id="wb-unlinked-day-list">
        <section v-for="group in groups('unlinked')" :key="group.date" class="wb-day-group">
          <header>
            <h3>
              {{ dayLabel(group.date)
              }}<span v-if="group.date === board.selection.date">所选日期</span>
            </h3>
            <small
              >{{ group.items.length }} 条 · 已完成
              {{ group.items.filter((d) => d.done && !d.terminated).length }} 条</small
            >
          </header>
          <WorkItemCard
            v-for="(day, i) in group.items"
            :key="day.id"
            :item="day"
            :index="i"
            compact
            @remove="emit('remove', $event)"
            @history="emit('history', $event)"
            @add="(type, parent) => emit('add', type, parent)"
          />
        </section>
      </div>
    </article>
  </section>
</template>
