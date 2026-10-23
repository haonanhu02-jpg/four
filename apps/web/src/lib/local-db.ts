import type {
  AuthResponse,
  WorkItem,
  WorkItemType,
  WorkItemValues,
  TransferDocument,
} from '@workbench/contracts';
export const GUEST = 'guest';
export const clientTab = crypto.randomUUID();
export type Action = 'create' | 'update' | 'delete' | 'restore';
export interface Command {
  operationId: string;
  owner: string;
  tab: string;
  itemId: string;
  type: WorkItemType;
  action: Action;
  values: WorkItemValues;
  baseVersion: number;
  order: number;
  readyAt: number;
  state: 'queued' | 'sending' | 'error' | 'conflict';
  sent: boolean;
  message: string;
  remote?: WorkItem;
  rejected?: boolean;
}
interface Cached {
  key: string;
  owner: string;
  item: WorkItem;
}
export interface LocalBackup {
  id: string;
  owner: string;
  document: TransferDocument;
  createdAt: string;
}
let opened: Promise<IDBDatabase> | undefined;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function open(): Promise<IDBDatabase> {
  if (!opened)
    opened = new Promise((resolve, reject) => {
      const req = indexedDB.open('four-layer-workbench', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const [name, keyPath] of [
          ['items', 'key'],
          ['commands', 'operationId'],
          ['meta', 'key'],
          ['backups', 'id'],
          ['leases', 'owner'],
        ] as const) {
          const store = db.createObjectStore(name, { keyPath });
          if (['items', 'commands', 'backups'].includes(name)) store.createIndex('owner', 'owner');
        }
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close();
          opened = undefined;
        };
        resolve(req.result);
      };
      req.onerror = () => {
        opened = undefined;
        reject(req.error);
      };
      req.onblocked = () => reject(new Error('本机数据库正在升级，请关闭旧页面后重试'));
    });
  return opened;
}
const value = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
export async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await open(),
    tx = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('本机保存已中断'));
    tx.onerror = () => reject(tx.error);
  });
  try {
    const result = await work(tx);
    await done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* completed */
    }
    await done.catch(() => undefined);
    throw error;
  }
}
export const metaGet = async <T>(key: string): Promise<T | undefined> =>
  transaction(
    ['meta'],
    'readonly',
    async (tx) => (await value(tx.objectStore('meta').get(key)))?.value as T | undefined,
  );
export const metaPut = (key: string, v: unknown) =>
  transaction(['meta'], 'readwrite', async (tx) => {
    await value(tx.objectStore('meta').put({ key, value: plain(v) }));
  });
export const cachedProfile = () => metaGet<AuthResponse>('last-profile');
export async function reserveBulk(owner: string, job: { body: { operationId: string } }) {
  await transaction(['meta'], 'readwrite', async (tx) => {
    const store = tx.objectStore('meta'),
      key = `bulk-job:${owner}`,
      previous = await value(store.get(key));
    if (previous?.value && previous.value.body.operationId !== job.body.operationId)
      throw new Error('本账号已有未确认的批量操作，请刷新并重试确认上次操作');
    await value(store.put({ key, value: plain(job) }));
  });
}
export async function clearBulk(owner: string, operationId: string) {
  await transaction(['meta'], 'readwrite', async (tx) => {
    const store = tx.objectStore('meta'),
      key = `bulk-job:${owner}`,
      previous = await value(store.get(key));
    if (previous?.value?.body.operationId === operationId)
      await value(store.put({ key, value: null }));
  });
}
export async function readLocal(
  owner: string,
): Promise<{ items: WorkItem[]; commands: Command[] }> {
  return transaction(['items', 'commands'], 'readonly', async (tx) => ({
    items: ((await value(tx.objectStore('items').index('owner').getAll(owner))) as Cached[]).map(
      (v) => v.item,
    ),
    commands: (
      (await value(tx.objectStore('commands').index('owner').getAll(owner))) as Command[]
    ).sort((a, b) => a.order - b.order || a.operationId.localeCompare(b.operationId)),
  }));
}
export async function cacheItems(owner: string, items: WorkItem[]) {
  await transaction(['items'], 'readwrite', async (tx) => {
    const store = tx.objectStore('items');
    for (const item of items) {
      const key = `${owner}:${item.id}`;
      const old = (await value(store.get(key))) as Cached | undefined;
      if (!old || old.item.version <= item.version)
        await value(store.put(plain({ key, owner, item })));
    }
  });
}
export async function resetCloudCache(
  owner: string,
  items: WorkItem[],
  generation: string,
  confirmPending = false,
) {
  await transaction(['items', 'commands', 'meta'], 'readwrite', async (tx) => {
    const cache = tx.objectStore('items'),
      old = (await value(cache.index('owner').getAll(owner))) as Cached[],
      commands = (await value(
        tx.objectStore('commands').index('owner').getAll(owner),
      )) as Command[];
    const pending = new Set(commands.map((c) => c.itemId)),
      remote = new Set(items.map((item) => item.id));
    for (const row of old)
      if (!pending.has(row.item.id) || remote.has(row.item.id)) await value(cache.delete(row.key));
    for (const item of items)
      await value(cache.put(plain({ key: `${owner}:${item.id}`, owner, item })));
    if (confirmPending)
      for (const c of commands) {
        const restored = items.find((item) => item.id === c.itemId);
        c.state = restored ? 'conflict' : 'error';
        c.remote = restored;
        c.rejected = !restored;
        c.message = '云端数据库已恢复或更换，请确认保留本机草稿或采用云端；缺失事项可复制为新事项';
        await value(tx.objectStore('commands').put(plain(c)));
      }
    await value(
      tx.objectStore('meta').put({ key: `cache-generation:${owner}`, value: generation }),
    );
  });
}
export function project(items: WorkItem[], commands: Command[]): WorkItem[] {
  const map = new Map(items.map((v) => [v.id, { ...v }]));
  for (const c of commands) {
    const item = map.get(c.itemId);
    if (!item) continue;
    if (c.action === 'create' || c.action === 'update') Object.assign(item, c.values);
    if (c.action === 'delete') item.deletedAt = new Date(c.order).toISOString();
    if (c.action === 'restore') item.deletedAt = null;
    item.version = c.action === 'create' ? 1 : c.baseVersion + 1;
  }
  for (const item of map.values())
    if (item.parentId && map.get(item.parentId)?.deletedAt) item.parentId = null;
  return [...map.values()];
}
export async function enqueue(
  owner: string,
  item: WorkItem,
  action: Action,
  values: WorkItemValues = {},
): Promise<void> {
  await transaction(['items', 'commands'], 'readwrite', async (tx) => {
    const cache = tx.objectStore('items'),
      queue = tx.objectStore('commands');
    const key = `${owner}:${item.id}`;
    if (owner === GUEST) {
      const current = ((await value(cache.get(key))) as Cached | undefined)?.item ?? item;
      const next = {
        ...current,
        ...values,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
        deletedAt:
          action === 'delete'
            ? new Date().toISOString()
            : action === 'restore'
              ? null
              : current.deletedAt,
      };
      await value(cache.put(plain({ key, owner, item: next })));
      if (action === 'delete') {
        const all = (await value(cache.index('owner').getAll(owner))) as Cached[];
        for (const child of all)
          if (child.item.parentId === item.id && !child.item.deletedAt) {
            child.item.parentId = null;
            child.item.version++;
            await value(cache.put(child));
          }
      }
      return;
    }
    if (!(await value(cache.get(key)))) await value(cache.put(plain({ key, owner, item })));
    const all = ((await value(queue.index('owner').getAll(owner))) as Command[]).sort(
      (a, b) => a.order - b.order,
    );
    const mine = all.filter((c) => c.itemId === item.id),
      last = mine.at(-1);
    const rejected = mine.find((c) => c.rejected);
    if (action === 'update' && rejected) {
      const merged = Object.assign({}, ...mine.map((c) => c.values), values) as WorkItemValues;
      for (const c of mine) await value(queue.delete(c.operationId));
      await value(
        queue.put(
          plain({
            ...rejected,
            operationId: crypto.randomUUID(),
            values: merged,
            state: 'queued',
            sent: false,
            rejected: false,
            message: '',
            readyAt: Date.now() + 550,
          }),
        ),
      );
      return;
    }
    if (
      action === 'update' &&
      last &&
      last.tab === clientTab &&
      !last.sent &&
      last.state === 'queued' &&
      ['create', 'update'].includes(last.action)
    ) {
      Object.assign(last.values, values);
      last.readyAt = Date.now() + 550;
      await value(queue.put(plain(last)));
      return;
    }
    const baseVersion =
      last?.tab === clientTab
        ? last.action === 'create'
          ? 1
          : last.baseVersion + 1
        : item.version;
    const command: Command = {
      operationId: crypto.randomUUID(),
      owner,
      tab: clientTab,
      itemId: item.id,
      type: item.type,
      action,
      values,
      baseVersion,
      order: Math.max(Date.now(), (all.at(-1)?.order ?? 0) + 1),
      readyAt: Date.now() + 550,
      state: 'queued',
      sent: false,
      message: '',
    };
    await value(queue.put(plain(command)));
  });
}
export async function commandPut(c: Command) {
  await transaction(['commands'], 'readwrite', async (tx) => {
    await value(tx.objectStore('commands').put(plain(c)));
  });
}
export async function markSending(id: string): Promise<Command | undefined> {
  return transaction(['commands'], 'readwrite', async (tx) => {
    const store = tx.objectStore('commands'),
      c = (await value(store.get(id))) as Command | undefined;
    if (!c) return;
    c.state = 'sending';
    c.sent = true;
    await value(store.put(c));
    return c;
  });
}
export async function acknowledge(owner: string, c: Command, item: WorkItem) {
  await transaction(['items', 'commands'], 'readwrite', async (tx) => {
    const cache = tx.objectStore('items'),
      key = `${owner}:${item.id}`,
      old = (await value(cache.get(key))) as Cached | undefined;
    if (!old || old.item.version <= item.version)
      await value(cache.put(plain({ key, owner, item })));
    await value(tx.objectStore('commands').delete(c.operationId));
  });
}
export async function resolveCommands(
  owner: string,
  id: string,
  remote: WorkItem | undefined,
  keepMine: boolean,
) {
  await transaction(['items', 'commands'], 'readwrite', async (tx) => {
    const queue = tx.objectStore('commands'),
      cache = tx.objectStore('items');
    const all = ((await value(queue.index('owner').getAll(owner))) as Command[])
      .filter((c) => c.itemId === id)
      .sort((a, b) => a.order - b.order);
    for (const c of all) await value(queue.delete(c.operationId));
    if (remote) await value(cache.put(plain({ key: `${owner}:${id}`, owner, item: remote })));
    else if (all.some((c) => c.action === 'create')) await value(cache.delete(`${owner}:${id}`));
    if (!keepMine || !remote || !all.length) return;
    const last = all.at(-1)!,
      values = Object.assign({}, ...all.map((c) => c.values)) as WorkItemValues;
    await value(
      queue.put(
        plain({
          ...last,
          operationId: crypto.randomUUID(),
          action: ['delete', 'restore'].includes(last.action) ? last.action : 'update',
          values,
          baseVersion: remote.version,
          state: 'queued',
          sent: false,
          message: '',
          remote: undefined,
          rejected: false,
          readyAt: 0,
        }),
      ),
    );
  });
}
export async function withSyncLock<T>(
  owner: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  if (navigator.locks)
    return navigator.locks.request(`workbench-sync:${owner}`, { ifAvailable: true }, (lock) =>
      lock ? run() : Promise.resolve(undefined),
    );
  const acquired = await transaction(['leases'], 'readwrite', async (tx) => {
    const store = tx.objectStore('leases'),
      old = await value(store.get(owner));
    if (old && old.until > Date.now() && old.holder !== clientTab) return false;
    await value(store.put({ owner, holder: clientTab, until: Date.now() + 45000 }));
    return true;
  });
  if (!acquired) return;
  const renew = setInterval(() => {
    void transaction(['leases'], 'readwrite', async (tx) => {
      const store = tx.objectStore('leases'),
        old = await value(store.get(owner));
      if (old?.holder === clientTab) await value(store.put({ ...old, until: Date.now() + 45000 }));
    });
  }, 15000);
  try {
    return await run();
  } finally {
    clearInterval(renew);
    await transaction(['leases'], 'readwrite', async (tx) => {
      const store = tx.objectStore('leases'),
        old = await value(store.get(owner));
      if (old?.holder === clientTab) await value(store.delete(owner));
    });
  }
}
export async function replaceLocal(owner: string, document: TransferDocument, backup = true) {
  await transaction(['items', 'commands', 'backups'], 'readwrite', async (tx) => {
    const cache = tx.objectStore('items'),
      queue = tx.objectStore('commands');
    const old = (await value(cache.index('owner').getAll(owner))) as Cached[],
      commands = (await value(queue.index('owner').getAll(owner))) as Command[];
    if (backup) {
      const items = project(
        old.map((v) => v.item),
        commands,
      );
      const doc: TransferDocument = {
        format: 'four-layer-workbench',
        version: 3,
        exportedAt: new Date().toISOString(),
        items: { annual: [], monthly: [], weekly: [], daily: [] },
      };
      for (const item of items) doc.items[item.type].push(item);
      await value(
        tx.objectStore('backups').put(
          plain({
            id: crypto.randomUUID(),
            owner,
            createdAt: new Date().toISOString(),
            document: doc,
          }),
        ),
      );
    }
    for (const entry of old) await value(cache.delete(entry.key));
    for (const c of commands) await value(queue.delete(c.operationId));
    for (const rows of Object.values(document.items))
      for (const item of rows)
        await value(cache.put(plain({ key: `${owner}:${item.id}`, owner, item })));
  });
}
export async function localBackups(owner: string): Promise<LocalBackup[]> {
  return transaction(['backups'], 'readonly', async (tx) =>
    ((await value(tx.objectStore('backups').index('owner').getAll(owner))) as LocalBackup[]).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    ),
  );
}
