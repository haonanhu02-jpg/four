<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import type { WorkItem, WorkItemType } from '@workbench/contracts';
import { useWorkbenchStore } from '../stores/workbench';
const props = defineProps<{ item: WorkItem }>();
const store = useWorkbenchStore();
const details = ref<HTMLDetailsElement>();
const search = ref('');
const results = ref<WorkItem[]>([]);
const total = ref(0);
const busy = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;
const parentType = computed<WorkItemType>(() =>
  props.item.type === 'monthly' ? 'annual' : props.item.type === 'weekly' ? 'monthly' : 'weekly',
);
const label = computed(() =>
  props.item.type === 'monthly' ? '年度目标' : props.item.type === 'weekly' ? '月度目标' : '周任务',
);
const selected = computed(() =>
  props.item.parentId ? store.records[props.item.parentId] : undefined,
);
async function load(append = false) {
  const current = ++sequence;
  busy.value = true;
  error.value = '';
  try {
    const list = await store.options(
      parentType.value,
      search.value,
      append ? results.value.length : 0,
    );
    if (current === sequence) {
      results.value = append ? [...results.value, ...list.items] : list.items;
      total.value = list.total;
    }
  } catch {
    if (current === sequence) error.value = '暂时无法读取上级事项，请重试';
  } finally {
    if (current === sequence) busy.value = false;
  }
}
function changeSearch() {
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 250);
}
function choose(id: string | null) {
  if (props.item.parentId !== id) {
    store.edit(props.item, { parentId: id });
    void store.save(props.item.id);
  }
  if (details.value) details.value.open = false;
}
onUnmounted(() => {
  clearTimeout(timer);
  sequence++;
});
</script>
<template>
  <details ref="details" class="wb-parent" @toggle="details?.open && load()">
    <summary :aria-label="`关联${label}`" :title="selected?.title || `未关联${label}`">
      <span>{{ label }}</span
      ><strong>{{ selected?.title || (item.parentId ? '未命名目标' : '未关联') }}</strong
      ><span aria-hidden="true">⌄</span>
    </summary>
    <div class="wb-parent-panel">
      <label class="wb-search-label"
        >搜索全部{{ label
        }}<input
          v-model="search"
          type="search"
          :aria-label="`搜索${label}`"
          placeholder="输入关键词查找其它月份或年份"
          @input="changeSearch"
      /></label>
      <button type="button" class="wb-option" @click="choose(null)">不关联上级</button>
      <p v-if="busy" role="status">正在读取…</p>
      <p v-if="error" role="alert">
        {{ error }} <button type="button" @click="load()">重试</button>
      </p>
      <div class="wb-option-list">
        <button
          v-for="candidate in results"
          :key="candidate.id"
          type="button"
          class="wb-option"
          :aria-pressed="candidate.id === item.parentId"
          @click="choose(candidate.id)"
        >
          <span>{{ candidate.title || '未命名目标' }}</span
          ><small>{{
            candidate.year || candidate.month || `${candidate.startDate} — ${candidate.endDate}`
          }}</small>
        </button>
      </div>
      <small v-if="!busy && !results.length">没有匹配的{{ label }}，可以先新增一条。</small>
      <button
        v-if="total > results.length"
        type="button"
        class="wb-option"
        :disabled="busy"
        @click="load(true)"
      >
        加载更多（{{ results.length }} / {{ total }}）
      </button>
    </div>
  </details>
</template>
