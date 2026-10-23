<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type {
  Carryover,
  CarryoverList,
  WorkItem,
  WorkItemList,
  WorkItemResult,
} from '@workbench/contracts';
import { useAccountStore } from '../stores/account';
import { useWorkbenchStore } from '../stores/workbench';
import { request, errorMessage } from '../lib/api';
const emit = defineEmits<{ open: [item: WorkItem] }>();
const board = useWorkbenchStore(),
  account = useAccountStore();
const data = ref<CarryoverList | null>(null),
  error = ref(''),
  busy = ref(false),
  choices = ref<WorkItem[]>([]);
const selected = ref<Record<string, string>>({});
let sequence = 0;
let optionsSequence = 0;
const jobs = new Map<
  string,
  { operationId: string; baseVersion: number; choice: 'keep' | 'relink'; annualId?: string }
>();
const headers = () => ({ 'X-Workbench-Account': account.session!.user.id });
async function load(offset = 0) {
  const generation = ++sequence;
  try {
    const result = await request<CarryoverList>(
      `/api/rollover/carryovers?offset=${offset}`,
      undefined,
      { headers: headers() },
    );
    if (generation === sequence) {
      data.value = result;
      for (const carry of result.items) selected.value[carry.id] ??= '';
    }
    error.value = '';
  } catch (caught) {
    error.value = errorMessage(caught);
  }
}
async function options(year: number) {
  const generation = ++optionsSequence;
  choices.value = [];
  try {
    let offset = 0;
    while (true) {
      const result = await request<WorkItemList>(
        `/api/work-items/annual?year=${year}&limit=200&offset=${offset}`,
        undefined,
        { headers: headers() },
      );
      if (generation !== optionsSequence) return;
      choices.value.push(...result.items);
      offset += result.items.length;
      if (offset >= result.total || !result.items.length) break;
    }
  } catch (caught) {
    error.value = errorMessage(caught);
  }
}
async function resolve(carry: Carryover, choice: 'keep' | 'relink') {
  if (busy.value || !(await board.flushAll())) return;
  if (jobs.has(carry.id) && jobs.get(carry.id)!.choice !== choice) {
    error.value = '上次确认结果尚未收到，请先重试原来的确认操作';
    return;
  }
  error.value = '';
  busy.value = true;
  const body = jobs.get(carry.id) ?? {
    operationId: crypto.randomUUID(),
    baseVersion: carry.current.version,
    choice,
    ...(choice === 'relink' ? { annualId: selected.value[carry.id] } : {}),
  };
  jobs.set(carry.id, body);
  try {
    await request<WorkItemResult>(`/api/rollover/carryovers/${carry.id}/resolve`, body, {
      headers: headers(),
    });
    jobs.delete(carry.id);
    await board.load();
    await load();
  } catch (caught) {
    error.value = errorMessage(caught);
    if ((caught as { status?: number }).status && (caught as { status: number }).status < 500) {
      jobs.delete(carry.id);
      await load();
    }
  } finally {
    busy.value = false;
  }
}
watch(
  () => board.revision,
  () => void load(),
);
onMounted(() => void load());
</script>
<template>
  <section v-if="data?.total || error" class="wb-carryover" aria-label="跨年承接确认">
    <header>
      <h2>
        跨年承接待确认 <span>{{ data?.total || 0 }}</span>
      </h2>
      <p>
        事项已进入当前周期，年度来源仍保留。确认继续沿用，或选择本年度目标；下级事项随关联链归集。
      </p>
    </header>
    <p v-if="error" class="wb-insight-error" role="alert">
      {{ error }} <button class="wb-link" @click="load()">刷新确认项</button>
    </p>
    <article v-for="carry in data?.items" :key="carry.id" class="wb-carry-row">
      <div>
        <strong>{{ carry.current.title || '未命名月目标' }}</strong>
        <p>
          {{ carry.fromYear }} → {{ carry.targetYear }} · 原年度：{{
            carry.source.ancestors.find((v) => v.type === 'annual')?.title || '未关联年度目标'
          }}
        </p>
      </div>
      <div class="wb-carry-actions">
        <button class="wb-button" :disabled="busy" @click="resolve(carry, 'keep')">
          保留当前关联</button
        ><select
          v-model="selected[carry.id]"
          aria-label="承接年度目标"
          @focus="options(carry.targetYear)"
        >
          <option value="">选择 {{ carry.targetYear }} 年目标</option>
          <option v-for="goal in choices" :key="goal.id" :value="goal.id">
            {{ goal.title || '未命名目标' }}
          </option></select
        ><button
          class="wb-button primary"
          :disabled="busy || !selected[carry.id]"
          @click="resolve(carry, 'relink')"
        >
          确认改挂</button
        ><button class="wb-link" @click="emit('open', carry.current)">查看事项</button>
      </div>
    </article>
    <div v-if="data && data.total > 20" class="wb-pagination">
      <span>{{ data.offset + 1 }} / {{ data.total }}</span
      ><button class="wb-button" :disabled="!data.offset" @click="load(data.offset - 20)">
        上一页</button
      ><button
        class="wb-button"
        :disabled="data.offset + 20 >= data.total"
        @click="load(data.offset + 20)"
      >
        下一页
      </button>
    </div>
  </section>
</template>
