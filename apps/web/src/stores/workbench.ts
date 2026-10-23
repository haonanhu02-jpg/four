import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  API,
  workItemValueSchemas,
  type AuthResponse,
  type WorkItem,
  type WorkItemList,
  type WorkItemResult,
  type WorkItemType,
  type WorkItemValues,
  type WorkbenchQuery,
  type WorkbenchResponse,
  type ReconcileResult,
  type TransferDocument,
} from '@workbench/contracts';
import { ApiClientError, errorMessage, request } from '../lib/api';
import { addDays, monday, todayIn } from '../lib/dates';
import * as local from '../lib/local-db';
type State = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';
interface SaveEntry {
  state: State;
  message: string;
  pending: WorkItemValues;
  remote?: WorkItem;
  rejected?: boolean;
}
const kinds: WorkItemType[] = ['annual', 'monthly', 'weekly', 'daily'];
const empty = (): WorkItemList => ({ items: [], ancestors: [], total: 0, limit: 50, offset: 0 });
export const useWorkbenchStore = defineStore('workbench', () => {
  const groups = reactive<WorkbenchResponse>({
    annual: empty(),
    monthly: empty(),
    weekly: empty(),
    daily: empty(),
  });
  const records = reactive<Record<string, WorkItem>>({}),
    entries = reactive<Record<string, SaveEntry>>({});
  const day = todayIn(),
    selection = reactive<WorkbenchQuery>({
      year: Number(day.slice(0, 4)),
      month: day.slice(0, 7),
      start: monday(day),
      end: addDays(monday(day), 6),
      date: day,
    });
  const view = ref<'annual' | 'monthly'>('monthly'),
    userId = ref(''),
    loading = ref(false),
    error = ref(''),
    notice = ref('');
  const creating = ref(false),
    createError = ref(''),
    createJob = ref(null),
    trash = ref<WorkItemList>(empty()),
    trashType = ref<WorkItemType>('annual');
  const trashLoading = ref(false),
    actionBusy = ref(false),
    moreBusy = ref<WorkItemType | null>(null),
    revision = ref(0),
    rolloverNotice = ref(''),
    pendingCarryovers = ref(0),
    serverDate = ref('');
  const offline = ref(!navigator.onLine),
    bulkPending = ref(false),
    storageError = ref(''),
    persisting = ref(0),
    pendingCount = ref(0),
    lastCloud = ref('');
  const memory = reactive<
    Record<string, { item: WorkItem; values: WorkItemValues; token: string; action: local.Action }>
  >({});
  const isGuest = computed(() => userId.value === local.GUEST);
  const hasUnpersisted = computed(
    () => Boolean(storageError.value) || persisting.value > 0 || Object.keys(memory).length > 0,
  );
  const hasUnsaved = computed(
    () => hasUnpersisted.value || pendingCount.value > 0 || bulkPending.value,
  );
  const saveLabel = computed(() =>
    hasUnpersisted.value
      ? '本机保存未完成，请勿关闭'
      : bulkPending.value
        ? '本机已保存 · 有批量操作待确认'
        : Object.values(entries).some((e) => e.state === 'conflict')
          ? '本机已保存 · 有版本冲突'
          : isGuest.value
            ? '已保存到本机 · 访客模式'
            : pendingCount.value
              ? `本机已保存 · ${pendingCount.value} 项待同步${offline.value ? ' · 离线' : ''}`
              : offline.value
                ? '本机缓存 · 离线'
                : '所有更改已保存 · 云端',
  );
  let writes: Promise<void> = Promise.resolve(),
    flight: Promise<boolean> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const limits: Record<WorkItemType, number> = { annual: 50, monthly: 50, weekly: 50, daily: 50 };
  const matches = (v: WorkItem) =>
    v.type === 'annual'
      ? v.year === selection.year
      : v.type === 'monthly'
        ? v.month === selection.month
        : v.type === 'weekly'
          ? v.startDate! <= selection.end && v.endDate! >= selection.start
          : v.date === selection.date;
  const active = (v: WorkItem) => !v.deletedAt && !v.archivedAt;
  function rebuild() {
    const all = Object.values(records).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    for (const type of kinds) {
      const rows = all.filter((v) => v.type === type && active(v) && matches(v));
      groups[type] = {
        items: rows.slice(0, limits[type]),
        ancestors: [],
        total: rows.length,
        offset: 0,
        limit: limits[type],
      };
    }
    const deleted = all.filter((v) => v.type === trashType.value && v.deletedAt);
    trash.value = {
      items: deleted.slice(0, Math.max(50, trash.value.limit)),
      ancestors: [],
      total: deleted.length,
      offset: 0,
      limit: Math.max(50, trash.value.limit),
    };
  }
  async function reloadLocal(owner = userId.value) {
    const data = await local.readLocal(owner);
    if (owner !== userId.value) return;
    const projected = local.project(data.items, data.commands),
      ids = new Set(projected.map((v) => v.id));
    for (const id of Object.keys(records)) if (!ids.has(id) && !memory[id]) delete records[id];
    for (const item of projected) {
      const overlay = memory[item.id]?.values;
      if (records[item.id]) Object.assign(records[item.id]!, item, overlay);
      else records[item.id] = { ...item, ...overlay };
    }
    for (const id of Object.keys(entries)) delete entries[id];
    for (const c of data.commands) {
      const previous = entries[c.itemId];
      const state: State =
        c.state === 'queued' ? 'pending' : c.state === 'sending' ? 'saving' : c.state;
      if (previous?.state === 'conflict' || previous?.state === 'error') continue;
      entries[c.itemId] = {
        state,
        message: c.message,
        pending: c.values,
        remote: c.remote,
        rejected: c.rejected,
      };
    }
    pendingCount.value = data.commands.length;
    rebuild();
    revision.value++;
  }
  const channel =
    typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('workbench-local');
  channel?.addEventListener('message', (event) => {
    if (event.data === userId.value)
      void reloadLocal().catch((caught) => {
        storageError.value = errorMessage(caught);
      });
  });
  function schedule() {
    clearTimeout(timer);
    if (!isGuest.value) timer = setTimeout(() => void sync(), 600);
  }
  function persist(item: WorkItem, action: local.Action, values: WorkItemValues = {}) {
    const owner = userId.value,
      token = crypto.randomUUID(),
      previous = memory[item.id];
    memory[item.id] = {
      item: { ...item },
      values: { ...previous?.values, ...values },
      action,
      token,
    };
    if (!records[item.id]) records[item.id] = { ...item };
    Object.assign(records[item.id]!, values);
    if (action === 'delete') records[item.id]!.deletedAt = new Date().toISOString();
    if (action === 'restore') records[item.id]!.deletedAt = null;
    entries[item.id] = { state: 'pending', message: '正在保存到本机', pending: values };
    persisting.value++;
    rebuild();
    const snapshot = { ...item };
    writes = writes
      .then(async () => {
        await local.enqueue(owner, snapshot, action, values);
        if (owner !== userId.value) return;
        if (memory[item.id]?.token === token) delete memory[item.id];
        storageError.value = '';
        await reloadLocal(owner);
        channel?.postMessage(owner);
        schedule();
      })
      .catch((caught) => {
        if (owner === userId.value) {
          storageError.value = `本机保存失败：${errorMessage(caught)}。请导出草稿并重试，不要关闭页面。`;
          error.value = storageError.value;
        }
      })
      .finally(() => {
        persisting.value--;
      });
    return writes;
  }
  function edit(item: WorkItem, values: WorkItemValues) {
    void persist(item, 'update', values);
  }
  async function persistAll() {
    await writes;
    return !hasUnpersisted.value;
  }
  async function retryLocal() {
    await writes;
    const pending = Object.values(memory).map((v) => ({ ...v }));
    for (const draft of pending) await persist(draft.item, draft.action, draft.values);
    if (!Object.keys(memory).length) {
      try {
        await reloadLocal();
        storageError.value = '';
      } catch (caught) {
        storageError.value = errorMessage(caught);
      }
    }
    return persistAll();
  }
  async function pull(owner = userId.value) {
    let doc: TransferDocument;
    let generation: string | undefined;
    try {
      const snapshot = await request<{ generation: string; document: TransferDocument }>(
        '/api/data/cache',
        undefined,
        { headers: { 'X-Workbench-Account': owner } },
      );
      doc = snapshot.document;
      generation = snapshot.generation;
    } catch (caught) {
      if (!(caught instanceof ApiClientError && caught.status === 404)) throw caught;
      doc = await request<TransferDocument>('/api/data/export', undefined, {
        headers: { 'X-Workbench-Account': owner },
      });
    }
    const previous = await local.metaGet<string>(`cache-generation:${owner}`);
    if (generation && previous !== generation) {
      await local.resetCloudCache(
        owner,
        Object.values(doc.items).flat(),
        generation,
        Boolean(previous),
      );
      if (previous && owner === userId.value)
        notice.value =
          '云端已恢复或更换数据版本，本机缓存已刷新；未提交草稿仍保留，请处理提示中的冲突。';
    } else await local.cacheItems(owner, Object.values(doc.items).flat());
    await local.metaPut(`last-cloud:${owner}`, new Date().toISOString());
    if (owner === userId.value) {
      offline.value = false;
      lastCloud.value = new Date().toISOString();
      await reloadLocal(owner);
    }
  }
  function sync(): Promise<boolean> {
    if (flight) return flight;
    const owner = userId.value;
    flight = (async () => {
      await writes;
      if (owner === local.GUEST) return !hasUnpersisted.value;
      if (!navigator.onLine) {
        offline.value = true;
        return false;
      }
      try {
        const result = await local.withSyncLock(owner, async () => {
          const session = await request<AuthResponse>(API.me);
          if (session.user.id !== owner)
            throw new Error('浏览器账号已切换，待同步内容仍保存在原账号下，请重新登录该账号');
          offline.value = false;
          const cachedGeneration = await local.metaGet<string>(`cache-generation:${owner}`);
          if (session.cacheGeneration && cachedGeneration !== session.cacheGeneration)
            await pull(owner);
          const attempted = new Set<string>(),
            blocked = new Set<string>();
          let pullAfter = false,
            compensate = false;
          for (let batch = 0; batch < 10000; batch++) {
            if (owner !== userId.value) break;
            await writes;
            const data = await local.readLocal(owner);
            const next = data.commands.find(
              (c) => !attempted.has(c.operationId) && !blocked.has(c.itemId),
            );
            if (!next) break;
            attempted.add(next.operationId);
            if (next.state === 'conflict' || next.rejected) {
              blocked.add(next.itemId);
              continue;
            }
            if (
              next.values.parentId &&
              data.commands.some((c) => c.itemId === next.values.parentId && c.action === 'create')
            ) {
              blocked.add(next.itemId);
              continue;
            }
            const c = await local.markSending(next.operationId);
            if (!c) continue;
            try {
              const path = `/api/work-items/${c.type}${c.action === 'create' ? '' : `/${c.itemId}`}${['delete', 'restore'].includes(c.action) ? `/${c.action}` : ''}`;
              const body =
                c.action === 'create'
                  ? { operationId: c.operationId, itemId: c.itemId, values: c.values }
                  : c.action === 'update'
                    ? { operationId: c.operationId, baseVersion: c.baseVersion, values: c.values }
                    : { operationId: c.operationId, baseVersion: c.baseVersion };
              const response = await request<WorkItemResult>(path, body, {
                method: c.action === 'update' ? 'PATCH' : 'POST',
                headers: { 'X-Workbench-Account': owner },
              });
              await local.acknowledge(owner, c, response.item);
              compensate ||= c.action === 'restore' || c.action === 'create';
              pullAfter ||= compensate || response.detachedChildren > 0;
              channel?.postMessage(owner);
            } catch (caught) {
              c.message = errorMessage(caught);
              c.state = 'error';
              if (caught instanceof ApiClientError) {
                if (caught.code === 'VERSION_CONFLICT') {
                  c.state = 'conflict';
                  c.remote = (caught.details as { currentRecord?: WorkItem })?.currentRecord;
                }
                c.rejected = caught.status === 400;
              }
              await local.commandPut(c);
              blocked.add(c.itemId);
              if (
                caught instanceof ApiClientError &&
                (caught.status === 0 ||
                  caught.status === 401 ||
                  caught.status === 403 ||
                  caught.status >= 500)
              )
                throw caught;
            }
            if (owner === userId.value) await reloadLocal(owner);
          }
          if (
            compensate &&
            !(await local.readLocal(owner)).commands.length &&
            owner === userId.value
          )
            await reconcile(owner);
          if (pullAfter) await pull(owner);
          else await reloadLocal(owner);
          return (await local.readLocal(owner)).commands.length === 0;
        });
        await reloadLocal(owner);
        if (result === undefined) schedule();
        return result ?? false;
      } catch (caught) {
        if (owner === userId.value) {
          offline.value = caught instanceof ApiClientError && caught.status === 0;
          error.value = errorMessage(caught) + '；本机内容已保留';
          await reloadLocal(owner);
        }
        return false;
      }
    })().finally(() => {
      flight = undefined;
    });
    return flight;
  }
  async function reconcile(owner = userId.value): Promise<ReconcileResult> {
    if (isGuest.value || offline.value)
      return {
        asOfDate: todayIn(),
        changed: { monthly: 0, weekly: 0, daily: 0 },
        remaining: 0,
        pendingCarryovers: 0,
      } as ReconcileResult;
    const changed = { monthly: 0, weekly: 0, daily: 0 };
    let result!: ReconcileResult;
    for (let i = 0; i < 10; i++) {
      result = await request<ReconcileResult>(
        '/api/rollover/reconcile',
        {},
        { headers: { 'X-Workbench-Account': owner } },
      );
      for (const key of ['monthly', 'weekly', 'daily'] as const)
        changed[key] += result.changed[key];
      if (!result.remaining) break;
    }
    if (owner !== userId.value) return { ...result, changed };
    serverDate.value = result.asOfDate;
    pendingCarryovers.value = result.pendingCarryovers;
    if (Object.values(changed).some(Boolean))
      rolloverNotice.value = `已承接：月 ${changed.monthly} 项、周 ${changed.weekly} 项、日 ${changed.daily} 项；原计划已保留。`;
    return { ...result, changed };
  }
  async function load() {
    loading.value = true;
    error.value = '';
    try {
      await persistAll();
      await reloadLocal();
      if (!isGuest.value) {
        const synced = await sync();
        if (!navigator.onLine) return true;
        if (synced) await reconcile();
        await pull();
      }
      return true;
    } catch (caught) {
      offline.value = caught instanceof ApiClientError && caught.status === 0;
      error.value = errorMessage(caught) + '；显示本机缓存';
      return Object.keys(records).length > 0;
    } finally {
      loading.value = false;
    }
  }
  async function initialize(id: string, timezone: string) {
    await writes;
    clearTimeout(timer);
    userId.value = id;
    for (const key of Object.keys(records)) delete records[key];
    for (const key of Object.keys(entries)) delete entries[key];
    for (const key of Object.keys(memory)) delete memory[key];
    error.value = '';
    storageError.value = '';
    notice.value = '';
    rolloverNotice.value = '';
    pendingCarryovers.value = 0;
    pendingCount.value = 0;
    bulkPending.value = false;
    serverDate.value = '';
    trash.value = empty();
    const today = todayIn(timezone);
    Object.assign(selection, {
      year: Number(today.slice(0, 4)),
      month: today.slice(0, 7),
      date: today,
      start: monday(today),
      end: addDays(monday(today), 6),
    });
    for (const type of kinds) {
      groups[type] = empty();
      limits[type] = 50;
    }
    try {
      lastCloud.value = (await local.metaGet<string>(`last-cloud:${id}`)) ?? '';
      await load();
    } catch (caught) {
      storageError.value = `本机数据库不可用：${errorMessage(caught)}。请恢复浏览器存储权限后刷新；未保存内容可导出。`;
      error.value = storageError.value;
      loading.value = false;
    }
  }
  async function save(_id: string) {
    void _id;
    await writes;
    if (hasUnpersisted.value) await retryLocal();
    return sync();
  }
  async function flushAll() {
    await persistAll();
    return sync();
  }
  async function resolveConflict(id: string, keepMine: boolean) {
    await writes;
    const remote = entries[id]?.remote;
    await local.resolveCommands(userId.value, id, remote, keepMine);
    await reloadLocal();
    channel?.postMessage(userId.value);
    if (keepMine) await sync();
    else if (!isGuest.value && !offline.value)
      await pull().catch((caught) => {
        error.value = errorMessage(caught);
      });
  }
  async function discard(id: string) {
    if (!window.confirm('放弃此事项的本机修改？可先导出 JSON 保存草稿。')) return;
    await writes;
    const data = await local.readLocal(userId.value),
      remote =
        entries[id]?.remote ??
        (data.commands.some((c) => c.itemId === id && c.action === 'create')
          ? undefined
          : data.items.find((v) => v.id === id));
    await local.resolveCommands(userId.value, id, remote, false);
    await reloadLocal();
    await load();
  }
  async function copyDraft(id: string) {
    const draft = records[id];
    if (!draft) return;
    const values = Object.fromEntries(
      Object.keys(workItemValueSchemas[draft.type].shape).map((key) => [
        key,
        draft[key as keyof WorkItem],
      ]),
    ) as WorkItemValues;
    if (draft.parentId && records[draft.parentId]?.deletedAt) values.parentId = null;
    const now = new Date().toISOString(),
      copy = {
        ...draft,
        id: crypto.randomUUID(),
        version: 0,
        deletedAt: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
    await persist(copy, 'create', values);
    notice.value = '已复制为新事项，原草稿保留，可确认后放弃原修改';
  }
  function visible(type: WorkItemType) {
    return groups[type].items.map((v) => records[v.id] ?? v);
  }
  async function add(type: WorkItemType, parentId?: string) {
    creating.value = true;
    try {
      const defaults: Record<WorkItemType, WorkItemValues> = {
        annual: { year: selection.year, progress: 0, weight: 1 },
        monthly: {
          month: selection.month,
          progress: 0,
          weight: 1,
          parentId: parentId ?? visible('annual')[0]?.id ?? null,
          dueDate: null,
        },
        weekly: {
          startDate: selection.start,
          endDate: selection.end,
          status: 'todo',
          priority: 'P1',
          parentId: parentId ?? visible('monthly')[0]?.id ?? null,
        },
        daily: {
          date: selection.date,
          done: false,
          minutes: 30,
          parentId: parentId ?? visible('weekly')[0]?.id ?? null,
        },
      };
      const values = { title: '', ...(type === 'daily' ? {} : { note: '' }), ...defaults[type] },
        now = new Date().toISOString();
      const item: WorkItem = {
        id: crypto.randomUUID(),
        type,
        version: 0,
        parentId: null,
        note: '',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        archivedAt: null,
        rolloverCount: 0,
        ...values,
      };
      if (type === 'monthly') item.originalMonth = item.month;
      if (type === 'weekly') {
        item.originalStartDate = item.startDate;
        item.originalEndDate = item.endDate;
      }
      if (type === 'daily') item.originalDate = item.date;
      await persist(item, 'create', values);
      schedule();
      return records[item.id] ?? null;
    } catch (caught) {
      createError.value = errorMessage(caught);
      return null;
    } finally {
      creating.value = false;
    }
  }
  async function finishCreate() {
    await sync();
    return null;
  }
  async function changeSelection(next: WorkbenchQuery) {
    if (!(await persistAll())) return false;
    Object.assign(selection, next);
    for (const type of kinds) limits[type] = 50;
    rebuild();
    revision.value++;
    return true;
  }
  async function more(type: WorkItemType) {
    limits[type] += 50;
    rebuild();
  }
  async function remove(item: WorkItem) {
    await persist(item, 'delete');
    notice.value = '已移入回收站，下级内容保留；联网后同步';
    schedule();
    return !hasUnpersisted.value;
  }
  async function restore(item: WorkItem) {
    await persist(item, 'restore');
    notice.value = '已恢复到原排期；联网后同步';
    schedule();
  }
  async function loadTrash(type = trashType.value, more = false) {
    trashType.value = type;
    trash.value.limit = more ? trash.value.limit + 50 : 50;
    rebuild();
  }
  async function options(type: WorkItemType, search: string, offset = 0): Promise<WorkItemList> {
    const items = Object.values(records).filter(
      (v) =>
        v.type === type &&
        active(v) &&
        `${v.title} ${v.note ?? ''}`.toLowerCase().includes(search.toLowerCase()),
    );
    return {
      items: items.slice(offset, offset + 100),
      ancestors: [],
      total: items.length,
      offset,
      limit: 100,
    };
  }
  function lineage(item: WorkItem) {
    const result: WorkItem[] = [];
    let current = item;
    for (let i = 0; i < 3 && current.parentId; i++) {
      const parent = records[current.parentId];
      if (!parent || !active(parent)) break;
      result.push(parent);
      current = parent;
    }
    return result;
  }
  async function detail(_type: WorkItemType, id: string) {
    await writes;
    return records[id] ?? null;
  }
  function localDocument(): TransferDocument {
    const doc: TransferDocument = {
      format: 'four-layer-workbench',
      version: 3,
      exportedAt: new Date().toISOString(),
      items: { annual: [], monthly: [], weekly: [], daily: [] },
    };
    for (const item of Object.values(records))
      doc.items[item.type].push({
        ...item,
        ...memory[item.id]?.values,
        version: Math.max(1, item.version),
      });
    return doc;
  }
  function dispose() {
    clearTimeout(timer);
  }
  return {
    groups,
    records,
    entries,
    selection,
    view,
    userId,
    loading,
    error,
    notice,
    creating,
    createError,
    createJob,
    trash,
    trashType,
    trashLoading,
    actionBusy,
    moreBusy,
    revision,
    rolloverNotice,
    pendingCarryovers,
    serverDate,
    offline,
    bulkPending,
    isGuest,
    storageError,
    persisting,
    pendingCount,
    lastCloud,
    hasUnpersisted,
    hasUnsaved,
    saveLabel,
    visible,
    initialize,
    load,
    edit,
    save,
    resolveConflict,
    discard,
    copyDraft,
    add,
    finishCreate,
    flushAll,
    persistAll,
    retryLocal,
    changeSelection,
    more,
    remove,
    loadTrash,
    restore,
    options,
    lineage,
    detail,
    reconcile,
    reloadLocal,
    localDocument,
    dispose,
  };
});
