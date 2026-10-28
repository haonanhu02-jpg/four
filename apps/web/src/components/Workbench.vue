<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  businessDateSchema,
  monthSchema,
  type WorkItem,
  type WorkItemType,
  type WorkbenchQuery,
} from '@workbench/contracts';
import { useAccountStore } from '../stores/account';
import { useWorkbenchStore } from '../stores/workbench';
import { addDays, dayLabel, daySpan, monday, todayIn } from '../lib/dates';
import WorkItemCard from './WorkItemCard.vue';
import OverviewPanel from './OverviewPanel.vue';
import AnnualExecution from './AnnualExecution.vue';
import AlignmentPanel from './AlignmentPanel.vue';
import { useInsightsStore } from '../stores/insights';
import HistoryPanel from './HistoryPanel.vue';
import CarryoverPanel from './CarryoverPanel.vue';
import DataPanel from './DataPanel.vue';
import '../workbench.css';
defineProps<{ loggingOut: boolean; logoutError: string }>();
const emit = defineEmits<{ logout: [] }>();
const account = useAccountStore();
const store = useWorkbenchStore();
const insights = useInsightsStore();
const detailDialog = ref<HTMLDialogElement>();
const focusedId = ref('');
const historyDialog = ref<HTMLDialogElement>();
const historyItem = ref<WorkItem>();
const historyMounted = ref(false);
let boundaryTimer: ReturnType<typeof setInterval> | undefined;
let checkingBoundary = false;
async function openHistory(value?: WorkItem) {
  if (!(await store.flushAll())) {
    store.error = '请先处理未保存内容，再查看历史';
    return;
  }
  detailDialog.value?.close();
  historyMounted.value = false;
  historyItem.value = value;
  await nextTick();
  historyMounted.value = true;
  await nextTick();
  historyDialog.value?.showModal();
}
async function openFromHistory(value: WorkItem) {
  historyDialog.value?.close();
  await openItem(value);
}
async function checkBoundary() {
  if (checkingBoundary || document.visibilityState === 'hidden' || !mounted) return;
  checkingBoundary = true;
  try {
    if (store.isGuest) return;
    const previous = store.serverDate;
    await store.load();
    if (!(await store.flushAll())) return;
    const result = await store.reconcile();
    if (!mounted) return;
    const follow =
      previous &&
      previous !== result.asOfDate &&
      store.selection.date === previous &&
      store.selection.start === monday(previous) &&
      store.selection.end === addDays(monday(previous), 6) &&
      !historyDialog.value?.open;
    if (follow) {
      const value = result.asOfDate;
      await store.changeSelection({
        year: Number(value.slice(0, 4)),
        month: value.slice(0, 7),
        date: value,
        start: monday(value),
        end: addDays(monday(value), 6),
      });
      syncSelection();
    } else if (previous !== result.asOfDate || Object.values(result.changed).some(Boolean))
      await store.load();
  } catch {
    store.error = '周期检查暂未完成，请刷新重试；当前编辑仍保留';
  } finally {
    checkingBoundary = false;
  }
}
const focused = computed(() => store.records[focusedId.value]);
let detailsSequence = 0;
let mounted = true;
watch(
  () => JSON.stringify(store.selection),
  () => insights.schedule(true),
);
watch(
  () => store.revision,
  () => insights.schedule(),
);
async function openItem(value: WorkItem) {
  const sequence = ++detailsSequence;
  const result = await store.detail(value.type, value.id);
  if (!result || sequence !== detailsSequence) return;
  focusedId.value = result.id;
  await nextTick();
  detailDialog.value?.showModal();
}
const initialDate = todayIn(account.session?.user.timezone);
const year = ref(Number(initialDate.slice(0, 4)));
const month = ref(initialDate.slice(0, 7));
const start = ref(monday(initialDate));
const end = ref(addDays(monday(initialDate), 6));
const date = ref(initialDate);
const removeDialog = ref<HTMLDialogElement>();
const recycleDialog = ref<HTMLDialogElement>();
const removing = ref<WorkItem | null>(null);
const names: Record<WorkItemType, string> = {
  annual: '年度目标',
  monthly: '月度目标',
  weekly: '周任务',
  daily: '当日待办',
};
const marks: Record<WorkItemType, string> = {
  annual: '年',
  monthly: '月',
  weekly: '周',
  daily: '日',
};
function syncSelection() {
  ({
    year: year.value,
    month: month.value,
    start: start.value,
    end: end.value,
    date: date.value,
  } = store.selection);
}
async function select(next: WorkbenchQuery) {
  if (await store.changeSelection(next)) syncSelection();
  else syncSelection();
}
async function changeMonth(value = month.value) {
  if (!monthSchema.safeParse(value).success) {
    store.error = '请选择有效的月份';
    syncSelection();
    return;
  }
  const today = todayIn(account.session!.user.timezone);
  const selected = value === today.slice(0, 7) ? today : `${value}-01`;
  const from = monday(selected);
  await select({
    year: Number(value.slice(0, 4)),
    month: value,
    date: selected,
    start: from,
    end: addDays(from, 6),
  });
}
async function changeYear() {
  if (!Number.isInteger(year.value) || year.value < 1970 || year.value > 9999) {
    syncSelection();
    return;
  }
  await changeMonth(`${year.value}-${store.selection.month.slice(5)}`);
}
async function applyRange() {
  if (
    !businessDateSchema.safeParse(start.value).success ||
    !businessDateSchema.safeParse(end.value).success ||
    start.value > end.value
  ) {
    store.error = '请填写有效区间，结束日期不能早于开始日期';
    return;
  }
  const selected =
    store.selection.date >= start.value && store.selection.date <= end.value
      ? store.selection.date
      : start.value;
  await select({ ...store.selection, start: start.value, end: end.value, date: selected });
}
async function changeDate() {
  if (!businessDateSchema.safeParse(date.value).success) {
    syncSelection();
    return;
  }
  const from =
    date.value >= store.selection.start && date.value <= store.selection.end
      ? store.selection.start
      : monday(date.value);
  const to =
    date.value >= store.selection.start && date.value <= store.selection.end
      ? store.selection.end
      : addDays(from, 6);
  await select({
    year: Number(date.value.slice(0, 4)),
    month: date.value.slice(0, 7),
    date: date.value,
    start: from,
    end: to,
  });
}
async function shift(direction: number) {
  const amount = daySpan(store.selection.start, store.selection.end) * direction;
  start.value = addDays(store.selection.start, amount);
  end.value = addDays(store.selection.end, amount);
  await applyRange();
}
async function today() {
  const value = todayIn(account.session!.user.timezone);
  const from = monday(value);
  await select({
    year: Number(value.slice(0, 4)),
    month: value.slice(0, 7),
    date: value,
    start: from,
    end: addDays(from, 6),
  });
}
async function add(type: WorkItemType, parentId?: string) {
  if (!(await store.persistAll())) {
    store.error = '请先处理未保存的内容';
    return;
  }
  if (type !== 'annual') store.view = 'monthly';
  const created = await store.add(type, parentId);
  if (created) {
    detailDialog.value?.close();
    await nextTick();
    const input = document.querySelector<HTMLInputElement>(`[data-title-id="${created.id}"]`);
    input?.focus();
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
async function remove(value: WorkItem) {
  detailDialog.value?.close();
  removing.value = value;
  await nextTick();
  removeDialog.value?.showModal();
}
async function confirmRemove() {
  if (removing.value && (await store.remove(removing.value))) {
    removeDialog.value?.close();
    removing.value = null;
  }
}
async function openTrash() {
  recycleDialog.value?.showModal();
  await store.loadTrash();
}
async function refresh() {
  if (await store.persistAll()) {
    await store.load();
    await insights.refresh();
  }
}
async function logout() {
  if (await store.persistAll()) {
    store.dispose();
    emit('logout');
  } else store.error = '本机保存未完成，请先导出草稿或重试后退出';
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (store.hasUnpersisted) {
    event.preventDefault();
    event.returnValue = '';
  }
}
function retryOnline() {
  void checkBoundary();
}
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('online', retryOnline);
  const user = account.session!.user;
  await store.initialize(user.id, user.timezone);
  if (!mounted) return;
  syncSelection();
  await insights.initialize(user.id);
  if (!mounted) return;
  boundaryTimer = setInterval(() => void checkBoundary(), 60000);
  window.addEventListener('focus', retryOnline);
  document.addEventListener('visibilitychange', retryOnline);
});
onUnmounted(() => {
  mounted = false;
  detailsSequence++;
  insights.dispose();
  store.dispose();
  clearInterval(boundaryTimer);
  window.removeEventListener('focus', retryOnline);
  document.removeEventListener('visibilitychange', retryOnline);
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('online', retryOnline);
});
</script>
<template>
  <main class="workbench" aria-label="四层工作台">
    <div class="wb-toolbar">
      <div>
        <p class="wb-eyebrow">年 → 月 → 周 → 日</p>
        <h1>把目标，落实到今天。</h1>
        <p class="wb-subtitle">从年度方向到每日行动，每件事都有清晰的来处。</p>
      </div>
      <div class="wb-actions">
        <span class="wb-cloud" :class="{ pending: store.hasUnsaved }" role="status"
          >● {{ store.saveLabel }}</span
        ><button type="button" class="wb-button" :disabled="store.loading" @click="refresh">
          刷新</button
        ><button
          type="button"
          class="wb-button"
          :disabled="store.isGuest || store.offline"
          @click="openHistory()"
        >
          历史复盘</button
        ><button type="button" class="wb-button" @click="openTrash">回收站</button
        ><button
          type="button"
          class="wb-button wb-account"
          :title="account.session?.user.username ?? account.session?.user.email"
          :disabled="loggingOut"
          @click="logout"
        >
          {{ loggingOut ? '正在退出…' : store.isGuest ? '登录同步' : '退出登录' }}
        </button>
      </div>
    </div>
    <div class="wb-account-line">
      {{ account.session?.user.username ?? account.session?.user.email
      }}<span>今天 · {{ dayLabel(todayIn(account.session?.user.timezone)) }}</span>
    </div>
    <DataPanel v-if="store.userId === account.session?.user.id" />
    <p v-if="store.isGuest || store.offline || store.hasUnsaved" class="wb-local-note">
      {{
        store.isGuest
          ? '访客数据仅保存在此浏览器，登录后可确认迁移。'
          : store.offline
            ? '当前离线，显示本机缓存；联网后自动同步。'
            : '待同步内容已在本机保留。'
      }}
      统计依据本机数据。{{
        store.lastCloud ? `上次云端读取：${new Date(store.lastCloud).toLocaleString()}` : ''
      }}
    </p>
    <div v-if="store.storageError" class="wb-banner wb-banner-error" role="alert">
      <span>{{ store.storageError }}</span
      ><button type="button" @click="store.retryLocal()">重试本机保存</button>
    </div>
    <div v-for="(entry, id) in store.entries" :key="id">
      <div
        v-if="entry.state === 'conflict' || entry.state === 'error'"
        class="wb-banner wb-banner-error"
        role="alert"
      >
        <span
          >{{ store.records[id]?.title || '未命名事项' }}：{{
            entry.message
          }}。本机草稿仍保留，可导出。</span
        ><button type="button" @click="openItem(store.records[id]!)">查看草稿</button
        ><button
          v-if="entry.remote"
          type="button"
          @click="store.resolveConflict(String(id), false)"
        >
          采用云端版本</button
        ><button
          v-if="entry.remote && !entry.remote.deletedAt"
          type="button"
          @click="store.resolveConflict(String(id), true)"
        >
          保留我的修改</button
        ><button v-if="entry.state === 'error'" type="button" @click="store.save(String(id))">
          重试同步
        </button>
        <button type="button" @click="store.copyDraft(String(id))">复制为新事项</button>
        <button type="button" @click="store.discard(String(id))">放弃本机修改</button>
      </div>
    </div>
    <div v-if="store.error || logoutError" class="wb-banner wb-banner-error" role="alert">
      <span>{{ store.error || logoutError }}</span
      ><button type="button" @click="refresh">重试</button
      ><button type="button" aria-label="关闭提示" @click="store.error = ''">×</button>
    </div>
    <div v-if="store.notice" class="wb-banner wb-banner-success" role="status">
      <span>{{ store.notice }}</span
      ><button type="button" aria-label="关闭提示" @click="store.notice = ''">×</button>
    </div>
    <div v-if="store.createError" class="wb-banner wb-banner-error" role="alert">
      <span>{{ store.createJob ? '新事项尚未确认保存' : '创建失败' }}：{{ store.createError }}</span
      ><button
        v-if="store.createJob"
        type="button"
        :disabled="store.creating"
        @click="store.finishCreate"
      >
        重试创建
      </button>
    </div>

    <div v-if="store.rolloverNotice" class="wb-banner wb-banner-success" role="status">
      <span>{{ store.rolloverNotice }}</span
      ><button type="button" @click="openHistory()">查看历史</button
      ><button type="button" aria-label="关闭顺延提示" @click="store.rolloverNotice = ''">×</button>
    </div>
    <CarryoverPanel v-if="!store.isGuest && !store.offline" @open="openItem" />
    <nav class="wb-view-tabs" aria-label="工作台视图">
      <button
        type="button"
        :class="{ active: store.view === 'annual' }"
        :aria-pressed="store.view === 'annual'"
        @click="store.view = 'annual'"
      >
        年度目标 <span>{{ store.groups.annual.total }}</span></button
      ><button
        type="button"
        :class="{ active: store.view === 'monthly' }"
        :aria-pressed="store.view === 'monthly'"
        @click="store.view = 'monthly'"
      >
        月度执行 <span>{{ store.groups.monthly.total }}</span></button
      ><small
        >{{ store.selection.year }} 年{{
          store.view === 'monthly' ? ` · ${store.selection.month.slice(5)}月` : ''
        }}</small
      >
    </nav>
    <section class="wb-period" aria-label="查看周期">
      <label
        >年度<input
          v-model.number="year"
          type="number"
          min="1970"
          max="9999"
          aria-label="查看年度"
          :disabled="store.loading"
          @change="changeYear"
      /></label>
      <template v-if="store.view === 'monthly'">
        <label
          >月份<input
            v-model="month"
            type="month"
            aria-label="查看月份"
            :disabled="store.loading"
            @change="changeMonth()"
        /></label>
        <form class="wb-range-form" @submit.prevent="applyRange">
          <span>周 / 自定义区间</span>
          <div>
            <button type="button" class="wb-icon-button" aria-label="上一个区间" @click="shift(-1)">
              ‹</button
            ><input v-model="start" type="date" aria-label="查看区间开始" required /><span>—</span
            ><input v-model="end" type="date" aria-label="查看区间结束" required /><button
              type="button"
              class="wb-icon-button"
              aria-label="下一个区间"
              @click="shift(1)"
            >
              ›</button
            ><button type="submit" class="wb-button">应用</button>
          </div>
        </form>
        <label
          >日期<input
            v-model="date"
            type="date"
            aria-label="查看日期"
            :disabled="store.loading"
            @change="changeDate"
        /></label>
      </template>
      <button type="button" class="wb-today" @click="today">回到今天</button>
      <small v-if="store.view === 'monthly'" class="wb-range-meta"
        >{{ dayLabel(store.selection.start) }} — {{ dayLabel(store.selection.end) }} ·
        {{ daySpan(store.selection.start, store.selection.end) }}
        天<br />显示与区间有交集的周任务</small
      >
    </section>
    <p v-if="store.loading" class="wb-loading" role="status">正在读取工作台…</p>

    <OverviewPanel v-if="!store.loading" @open="openItem" />

    <template
      v-for="type in (store.view === 'annual'
        ? ['annual']
        : ['monthly', 'weekly', 'daily']) as WorkItemType[]"
      :key="type"
    >
      <section class="wb-section" :aria-label="names[type]">
        <header class="wb-section-header">
          <span class="wb-level" :class="type">{{ marks[type] }}</span>
          <div>
            <h2>{{ names[type] }}</h2>
            <p>
              {{
                type === 'annual'
                  ? '这一年要拿下的几件大事'
                  : type === 'monthly'
                    ? '从年度目标拆解，本月完成什么'
                    : type === 'weekly'
                      ? '围绕月目标，安排区间内的具体动作'
                      : '从周任务拆解，专注今天要做的事'
              }}
            </p>
          </div>
          <span class="wb-count">{{ store.groups[type].total }} 项</span
          ><button
            type="button"
            class="wb-button primary"
            :disabled="store.creating || store.loading"
            :data-add-type="type"
            @click="add(type)"
          >
            + 新增{{ names[type] }}
          </button>
        </header>
        <div v-if="!store.groups[type].items.length && !store.loading" class="wb-empty">
          <span class="wb-empty-symbol">{{ marks[type] }}</span>
          <h3>
            {{
              type === 'annual'
                ? '先写下这一年的方向'
                : type === 'monthly'
                  ? '把年度目标拆到这个月'
                  : type === 'weekly'
                    ? '让月度目标有具体的推进动作'
                    : '安排今天的第一件事'
            }}
          </h3>
          <p>点击上方新增，标题、说明和各项设置都可以直接编辑。</p>
          <button type="button" class="wb-link" :disabled="store.creating" @click="add(type)">
            + 创建第一条{{ names[type] }}
          </button>
        </div>
        <div
          v-else-if="!store.loading"
          class="wb-item-grid"
          :class="{ 'wb-two-columns': type === 'monthly' }"
        >
          <WorkItemCard
            v-for="(value, index) in store.visible(type)"
            :key="value.id"
            :item="value"
            :index="index"
            @remove="remove"
            @add="add"
            @history="openHistory"
          />
        </div>
        <button
          v-if="store.groups[type].items.length < store.groups[type].total"
          class="wb-load-more"
          type="button"
          @click="store.more(type)"
          :disabled="store.moreBusy !== null"
        >
          加载更多（已显示 {{ store.groups[type].items.length }} / {{ store.groups[type].total }}）
        </button>
      </section>
    </template>
    <AnnualExecution v-if="store.view === 'annual' && !store.loading" @open="openItem" />
    <AlignmentPanel v-if="!store.loading" @open="openItem" @add="add" />
    <p class="wb-bottom-note">
      点击文字直接编辑 · 停止输入后自动保存 · 标题处按 Enter 连续新增 · 删除后可在回收站恢复
    </p>

    <dialog
      ref="historyDialog"
      class="wb-dialog wb-history-dialog"
      aria-labelledby="history-heading"
      @close="historyMounted = false"
    >
      <header>
        <div>
          <h2 id="history-heading">历史复盘</h2>
          <p>查看封存周期与排期变更，当前查看日期保持不变。</p>
        </div>
        <button
          class="wb-delete"
          type="button"
          aria-label="关闭历史复盘"
          @click="historyDialog?.close()"
        >
          ×
        </button>
      </header>
      <HistoryPanel v-if="historyMounted" :initial-item="historyItem" @open="openFromHistory" />
    </dialog>
    <dialog
      ref="detailDialog"
      class="wb-dialog wb-detail-dialog"
      aria-labelledby="detail-heading"
      @close="focusedId = ''"
    >
      <header>
        <div>
          <h2 id="detail-heading">事项详情</h2>
          <p>可直接修改内容、排期和上级关联，修改后自动保存。</p>
        </div>
        <button
          type="button"
          class="wb-delete"
          aria-label="关闭事项详情"
          @click="detailDialog?.close()"
        >
          ×
        </button>
      </header>
      <WorkItemCard
        v-if="focused && !focused.deletedAt"
        :item="focused"
        @history="openHistory"
        :index="0"
        @remove="remove"
        @add="add"
      />
    </dialog>
    <dialog
      ref="removeDialog"
      class="wb-dialog"
      aria-labelledby="delete-heading"
      @cancel="store.actionBusy && $event.preventDefault()"
    >
      <h2 id="delete-heading">删除这条{{ removing ? names[removing.type] : '事项' }}？</h2>
      <p>「{{ removing?.title || '未命名事项' }}」将移到回收站。</p>
      <p>下级事项会保留，其直接上级关联将解除。恢复当前事项后，下级保持现有的关联。</p>
      <p v-if="store.error" class="wb-dialog-error" role="alert">
        {{ store.error }}。可重试删除，或关闭后处理修改。
      </p>
      <div class="wb-dialog-actions">
        <button
          type="button"
          class="wb-button"
          :disabled="store.actionBusy"
          @click="removeDialog?.close()"
        >
          取消</button
        ><button
          type="button"
          class="wb-button danger"
          :disabled="store.actionBusy"
          @click="confirmRemove"
        >
          {{ store.actionBusy ? '正在删除…' : '确认删除' }}
        </button>
      </div>
    </dialog>
    <dialog ref="recycleDialog" class="wb-dialog wb-trash-dialog" aria-labelledby="trash-heading">
      <header>
        <div>
          <h2 id="trash-heading">回收站</h2>
          <p>恢复原内容和排期；已解除的下级关联不会自动重新挂接。</p>
        </div>
        <button
          type="button"
          class="wb-delete"
          aria-label="关闭回收站"
          @click="recycleDialog?.close()"
        >
          ×
        </button>
      </header>
      <nav class="wb-trash-tabs" aria-label="回收站类型">
        <button
          v-for="type in ['annual', 'monthly', 'weekly', 'daily'] as WorkItemType[]"
          :key="type"
          type="button"
          :aria-pressed="store.trashType === type"
          :class="{ active: store.trashType === type }"
          @click="store.loadTrash(type)"
        >
          {{ names[type] }}
        </button>
      </nav>
      <p v-if="store.trashLoading" role="status">正在读取…</p>
      <p v-if="store.error" class="wb-dialog-error" role="alert">{{ store.error }}</p>
      <p v-if="!store.trash.items.length && !store.trashLoading" class="wb-trash-empty">
        这里还没有已删除的{{ names[store.trashType] }}。
      </p>
      <article v-for="value in store.trash.items" :key="value.id" class="wb-trash-row">
        <div>
          <strong>{{ value.title || '未命名事项' }}</strong
          ><small>{{
            value.year || value.month || value.date || `${value.startDate} — ${value.endDate}`
          }}</small>
        </div>
        <button
          type="button"
          class="wb-button"
          :disabled="store.actionBusy"
          @click="store.restore(value)"
        >
          恢复
        </button>
      </article>
      <button
        v-if="store.trash.items.length < store.trash.total"
        type="button"
        class="wb-load-more"
        @click="store.loadTrash(store.trashType, true)"
      >
        加载更多
      </button>
    </dialog>
  </main>
</template>
