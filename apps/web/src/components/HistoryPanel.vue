<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type {
  ChangeList,
  PeriodDetail,
  PeriodList,
  PeriodType,
  WorkItem,
  WorkItemType,
} from '@workbench/contracts';
import { useAccountStore } from '../stores/account';
import { request, errorMessage } from '../lib/api';
import { itemNames, periodOf, progressOf } from '../lib/insights';
import { addDays, monday, todayIn } from '../lib/dates';
const props = defineProps<{ initialItem?: WorkItem }>();
const emit = defineEmits<{ open: [item: WorkItem] }>();
const account = useAccountStore();
const tab = ref<'periods' | 'changes'>(props.initialItem ? 'changes' : 'periods');
const periodType = ref<'' | PeriodType>('');
const periods = ref<PeriodList | null>(null),
  detail = ref<PeriodDetail | null>(null),
  changes = ref<ChangeList | null>(null);
const selected = ref(''),
  completion = ref('all'),
  itemType = ref<'' | WorkItemType>('');
const busy = ref(false),
  error = ref('');
const sealType = ref<PeriodType>('day'),
  start = ref(addDays(todayIn(account.session?.user.timezone), -1)),
  end = ref(start.value);
let sequence = 0;
const headers = () => ({ 'X-Workbench-Account': account.session!.user.id });
const reason = (value: string) =>
  value.startsWith('rollover_')
    ? '自动顺延'
    : value === 'manual_edit'
      ? '手动调整排期'
      : value === 'manual_seal'
        ? '补充封存'
        : value === 'before_edit'
          ? '历史修改前封存'
          : value === 'before_delete'
            ? '删除前封存'
            : '周期结束 / 顺延前封存';
const format = (value: Record<string, string>) => Object.values(value).join(' — ');
const sourceLabel = (ancestors: WorkItem[]) =>
  ancestors.map((v) => `${itemNames[v.type]}：${v.title || '未命名'}`).join(' ← ');
const original = (value: WorkItem) =>
  value.originalDate ||
  value.originalMonth ||
  (value.originalStartDate
    ? `${value.originalStartDate} — ${value.originalEndDate}`
    : `${value.year}年`);
async function loadPeriods(offset = 0) {
  busy.value = true;
  error.value = '';
  const generation = ++sequence;
  try {
    const data = await request<PeriodList>(
      `/api/history/periods?offset=${offset}${periodType.value ? `&periodType=${periodType.value}` : ''}`,
      undefined,
      { headers: headers() },
    );
    if (generation !== sequence) return;
    periods.value = data;
    if (!data.items.some((v) => v.id === selected.value)) selected.value = data.items[0]?.id ?? '';
    if (selected.value) await loadDetail();
    else detail.value = null;
  } catch (caught) {
    if (generation === sequence) error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}
async function loadDetail(offset = 0) {
  busy.value = true;
  error.value = '';
  const generation = ++sequence;
  try {
    const data = await request<PeriodDetail>(
      `/api/history/periods/${selected.value}?offset=${offset}&completion=${completion.value}${itemType.value ? `&type=${itemType.value}` : ''}`,
      undefined,
      { headers: headers() },
    );
    if (generation === sequence) detail.value = data;
  } catch (caught) {
    if (generation === sequence) error.value = errorMessage(caught);
  } finally {
    if (generation === sequence) busy.value = false;
  }
}
async function loadChanges(offset = 0) {
  busy.value = true;
  error.value = '';
  const generation = ++sequence;
  try {
    const data = await request<ChangeList>(
      `/api/history/changes?offset=${offset}${props.initialItem ? `&itemId=${props.initialItem.id}` : ''}${itemType.value ? `&itemType=${itemType.value}` : ''}`,
      undefined,
      { headers: headers() },
    );
    if (generation === sequence) changes.value = data;
  } catch (caught) {
    if (generation === sequence) error.value = errorMessage(caught);
  } finally {
    if (generation === sequence) busy.value = false;
  }
}
function switchTab(value: 'periods' | 'changes') {
  tab.value = value;
  itemType.value = '';
  void (value === 'periods' ? loadPeriods() : loadChanges());
}
function sealDates() {
  if (sealType.value === 'day') end.value = start.value;
  if (sealType.value === 'week') {
    start.value = monday(start.value);
    end.value = addDays(start.value, 6);
  }
  if (sealType.value === 'month') {
    start.value = `${start.value.slice(0, 7)}-01`;
    const d = new Date(`${start.value}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    end.value = d.toISOString().slice(0, 10);
  }
  if (sealType.value === 'year') {
    start.value = `${start.value.slice(0, 4)}-01-01`;
    end.value = `${start.value.slice(0, 4)}-12-31`;
  }
}
async function seal() {
  busy.value = true;
  error.value = '';
  try {
    const result = await request<{ id: string }>(
      '/api/history/periods',
      { periodType: sealType.value, start: start.value, end: end.value },
      { headers: headers() },
    );
    periodType.value = '';
    selected.value = result.id;
    await loadPeriods();
    selected.value = result.id;
    await loadDetail();
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}
onMounted(() => void (tab.value === 'periods' ? loadPeriods() : loadChanges()));
</script>
<template>
  <div class="wb-history">
    <nav class="wb-filter-tabs" aria-label="历史类型">
      <button :aria-pressed="tab === 'periods'" @click="switchTab('periods')">周期复盘</button
      ><button :aria-pressed="tab === 'changes'" @click="switchTab('changes')">
        {{ initialItem ? '本事项排期记录' : '排期与顺延记录' }}
      </button>
    </nav>
    <p class="wb-history-note">
      封存内容只读，代表封存时刻的计划、状态与来源，不会因后续修改而变化。{{
        initialItem ? `当前事项：${initialItem.title || '未命名'}` : ''
      }}
    </p>
    <p v-if="error" class="wb-insight-error" role="alert">
      {{ error }}
      <button class="wb-link" @click="tab === 'periods' ? loadPeriods() : loadChanges()">
        重试
      </button>
    </p>
    <template v-if="tab === 'periods'">
      <div class="wb-insight-filters">
        <label
          >周期类型<select v-model="periodType" aria-label="复盘周期类型" @change="loadPeriods()">
            <option value="">全部周期</option>
            <option value="year">年</option>
            <option value="month">月</option>
            <option value="week">周 / 自定义区间</option>
            <option value="day">日</option>
          </select></label
        ><label
          >已封存周期<select v-model="selected" aria-label="封存周期" @change="loadDetail()">
            <option v-if="!periods?.items.length" value="">暂无封存</option>
            <option v-for="p in periods?.items" :key="p.id" :value="p.id">
              {{ { year: '年', month: '月', week: '区间', day: '日' }[p.periodType] }} ·
              {{ p.key }}（{{ p.total }}项）
            </option>
          </select></label
        >
      </div>
      <div v-if="periods && periods.total > 20" class="wb-pagination">
        <span
          >周期 {{ periods.offset + 1 }}–{{ Math.min(periods.offset + 20, periods.total) }} /
          {{ periods.total }}</span
        ><button
          class="wb-button"
          :disabled="busy || !periods.offset"
          @click="loadPeriods(periods.offset - 20)"
        >
          上一批周期</button
        ><button
          class="wb-button"
          :disabled="busy || periods.offset + 20 >= periods.total"
          @click="loadPeriods(periods.offset + 20)"
        >
          下一批周期
        </button>
      </div>
      <div v-if="detail" class="wb-history-heading">
        <h3>{{ detail.period.start }} — {{ detail.period.end }}</h3>
        <p>
          封存于
          {{
            new Date(detail.period.capturedAt).toLocaleString('zh-CN', {
              timeZone: account.session?.user.timezone,
            })
          }}
          · {{ reason(detail.period.reason) }}
        </p>
        <p>已完成 {{ detail.period.completed }} / {{ detail.period.total }} 条 · 各层级分别计数</p>
      </div>
      <div v-if="detail" class="wb-insight-filters">
        <label
          >层级<select v-model="itemType" aria-label="复盘事项层级" @change="loadDetail()">
            <option value="">全部层级</option>
            <option v-for="(name, type) in itemNames" :key="type" :value="type">{{ name }}</option>
          </select></label
        ><label
          >完成状态<select v-model="completion" aria-label="复盘完成状态" @change="loadDetail()">
            <option value="all">全部</option>
            <option value="incomplete">未完成</option>
            <option value="complete">已完成</option>
          </select></label
        >
      </div>
      <p v-if="busy" class="wb-loading" role="status">正在读取历史…</p>
      <template v-else
        ><article v-for="row in detail?.items" :key="row.item.id" class="wb-frozen-row">
          <span class="wb-item-type">{{ itemNames[row.item.type] }}</span>
          <div>
            <strong>{{ row.item.title || '未命名事项' }}</strong>
            <p>{{ progressOf(row.item) }} · 当时排期 {{ periodOf(row.item) }}</p>
            <small
              >最初计划 {{ original(row.item)
              }}{{ row.item.dueDate ? ` · 截止 ${row.item.dueDate}` : '' }} · 当时顺延
              {{ row.item.rolloverCount || 0 }} 次</small
            >
            <p class="wb-lineage">
              {{ sourceLabel(row.ancestors) || '当时未关联上级' }}
            </p>
          </div>
          <button class="wb-link" @click="emit('open', row.item)">查看当前事项</button>
        </article>
        <p v-if="!detail?.items.length" class="wb-insight-empty">
          没有匹配的封存事项。可选择其他周期，或补充封存一个已结束的周期。
        </p></template
      >
      <div v-if="detail && detail.total > 20" class="wb-pagination">
        <span>{{ detail.offset + 1 }} / {{ detail.total }}</span
        ><button
          class="wb-button"
          :disabled="busy || !detail.offset"
          @click="loadDetail(detail.offset - 20)"
        >
          上一页事项</button
        ><button
          class="wb-button"
          :disabled="busy || detail.offset + 20 >= detail.total"
          @click="loadDetail(detail.offset + 20)"
        >
          下一页事项
        </button>
      </div>
      <details class="wb-seal-form">
        <summary>补充封存已结束周期</summary>
        <p>
          首次启用前未封存的周期，可按现存数据补充封存；无法还原此前已改动且没有快照的数据。已有封存不会覆盖。
        </p>
        <form @submit.prevent="seal">
          <select v-model="sealType" aria-label="补充封存类型" @change="sealDates">
            <option value="day">日</option>
            <option value="week">周 / 区间</option>
            <option value="month">月</option>
            <option value="year">年</option></select
          ><input
            v-model="start"
            type="date"
            aria-label="封存开始日期"
            required
            @change="sealDates"
          /><input
            v-model="end"
            type="date"
            aria-label="封存结束日期"
            required
            :disabled="sealType !== 'week'"
          /><button class="wb-button" :disabled="busy">封存并查看</button>
        </form>
      </details>
    </template>
    <template v-else
      ><div class="wb-insight-filters">
        <label
          >层级<select v-model="itemType" aria-label="排期记录层级" @change="loadChanges()">
            <option value="">全部层级</option>
            <option v-for="(name, type) in itemNames" :key="type" :value="type">{{ name }}</option>
          </select></label
        >
      </div>
      <p v-if="busy" class="wb-loading">正在读取记录…</p>
      <template v-else
        ><article v-for="row in changes?.items" :key="row.id" class="wb-change-row">
          <div>
            <strong>{{ row.snapshot.item.title || '未命名事项' }}</strong>
            <p>{{ format(row.from) }} → {{ format(row.to) }}</p>
            <small
              >{{ reason(row.reason) }} ·
              {{
                new Date(row.createdAt).toLocaleString('zh-CN', {
                  timeZone: account.session?.user.timezone,
                })
              }}</small
            >
            <p class="wb-lineage">
              当时来源：{{
                row.snapshot.ancestors.map((v) => v.title || '未命名').join(' ← ') || '未关联上级'
              }}
            </p>
          </div>
          <button class="wb-link" @click="emit('open', row.snapshot.item)">查看当前事项</button>
        </article>
        <p v-if="!changes?.items.length" class="wb-insight-empty">还没有排期变更记录。</p></template
      >
      <div v-if="changes && changes.total > 20" class="wb-pagination">
        <span>{{ changes.offset + 1 }} / {{ changes.total }}</span
        ><button
          class="wb-button"
          :disabled="busy || !changes.offset"
          @click="loadChanges(changes.offset - 20)"
        >
          上一页记录</button
        ><button
          class="wb-button"
          :disabled="busy || changes.offset + 20 >= changes.total"
          @click="loadChanges(changes.offset + 20)"
        >
          下一页记录
        </button>
      </div></template
    >
  </div>
</template>
