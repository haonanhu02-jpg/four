<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import {
  normalizeDocument,
  documentCounts,
  sampleDocument,
  type TransferDocument,
  type ImportPreview,
  type BackupList,
} from '@workbench/contracts';
import { request, errorMessage, ApiClientError } from '../lib/api';
import { todayIn } from '../lib/dates';
import { useWorkbenchStore } from '../stores/workbench';
import * as local from '../lib/local-db';
import { readTransferFile, downloadTransfer, type FileFormat } from '../lib/file-transfer';
import DialogCloseButton from './DialogCloseButton.vue';
const board = useWorkbenchStore(),
  dialog = ref<HTMLDialogElement>();
const exportDialog = ref<HTMLDialogElement>(),
  exportFormat = ref<FileFormat>('xlsx');
const busy = ref(false),
  error = ref(''),
  notice = ref(''),
  mode = ref<'append' | 'replace'>('append'),
  preview = ref<ImportPreview | null>(null),
  document = ref<TransferDocument | null>(null);
const cloudBackups = ref<BackupList | null>(null),
  guestBackups = ref<local.LocalBackup[]>([]),
  guestAvailable = ref(false),
  guestRevision = ref('');
let commitJob: { previewId: string; operationId: string } | undefined,
  clearJob: { revision: string; operationId: string } | undefined,
  localRevision = '';
const headers = () => ({ 'X-Workbench-Account': board.userId });
const fingerprint = (doc: TransferDocument) => JSON.stringify(doc.items);
type BulkJob =
  | { action: 'commit'; body: { previewId: string; operationId: string }; guest?: string }
  | { action: 'clear'; body: { revision: string; operationId: string } };
const pendingBulk = ref<BulkJob | null>(null);
watch(
  pendingBulk,
  (job) => {
    board.bulkPending = Boolean(job);
  },
  { immediate: true },
);
async function execute(job: BulkJob) {
  const owner = board.userId;
  await local.reserveBulk(owner, job);
  pendingBulk.value = job;
  try {
    await request(`/api/data/${job.action}`, job.body, {
      headers: { 'X-Workbench-Account': owner },
    });
  } catch (caught) {
    if (caught instanceof ApiClientError && [400, 404, 409].includes(caught.status)) {
      await local.clearBulk(owner, job.body.operationId);
      pendingBulk.value = null;
      commitJob = undefined;
      clearJob = undefined;
    }
    throw caught;
  }
  if (job.action === 'commit' && job.guest) {
    await local.metaPut(`guest-dismiss:${owner}`, job.guest);
    guestAvailable.value = false;
  }
  await local.clearBulk(owner, job.body.operationId);
  pendingBulk.value = null;
}
async function resume() {
  await run(async () => {
    if (!pendingBulk.value) return;
    await execute(pendingBulk.value);
    await board.load();
    await backups();
    notice.value = '上次操作已确认完成，未重复执行';
    board.notice = notice.value;
    preview.value = null;
    commitJob = undefined;
    clearJob = undefined;
  });
}
async function run(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await work();
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}
async function backups() {
  if (board.isGuest) guestBackups.value = await local.localBackups(local.GUEST);
  else if (!board.offline)
    cloudBackups.value = await request<BackupList>(
      '/api/data/backups?limit=20&offset=0',
      undefined,
      { headers: headers() },
    );
}
async function open() {
  preview.value = null;
  document.value = null;
  commitJob = undefined;
  clearJob = undefined;
  dialog.value?.showModal();
  await run(backups);
}
async function exportData() {
  await run(async () => {
    await board.persistAll();
    await downloadTransfer(
      board.localDocument(),
      board.hasUnsaved ? '本机草稿' : '导出',
      exportFormat.value,
    );
    exportDialog.value?.close();
  });
}
async function prepare(doc: unknown, sourceMode = mode.value) {
  if (pendingBulk.value) throw new Error('请先重试确认上次批量操作，再开始新导入');
  if (!(await board.persistAll())) throw new Error('本机保存尚未完成，请先导出草稿并重试');
  commitJob = undefined;
  clearJob = undefined;
  document.value = null;
  preview.value = null;
  const normalized = normalizeDocument(doc);
  if (board.isGuest) {
    localRevision = fingerprint(board.localDocument());
    document.value = normalized.document;
    preview.value = {
      id: crypto.randomUUID(),
      mode: sourceMode,
      counts: documentCounts(normalized.document),
      current: documentCounts(board.localDocument()),
      warnings: normalized.warnings,
      titles: Object.values(normalized.document.items)
        .flat()
        .slice(0, 8)
        .map((v) => v.title || '未命名'),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      pastItems: 0,
    };
  } else {
    if (!(await board.flushAll()))
      throw new Error('请先联网同步完毕并处理冲突，再导入；本机草稿可随时导出');
    preview.value = await request<ImportPreview>(
      '/api/data/preview',
      { document: normalized.document, mode: sourceMode },
      { headers: headers() },
    );
  }
}
async function file(event: Event) {
  const input = event.target as HTMLInputElement,
    selected = input.files?.[0];
  if (!selected) return;
  await run(async () => {
    preview.value = null;
    document.value = null;
    commitJob = undefined;
    await prepare(await readTransferFile(selected, todayIn()));
  });
  input.value = '';
}
async function sample() {
  await run(() => prepare(sampleDocument(todayIn()), 'append'));
}
async function commit() {
  await run(async () => {
    const p = preview.value;
    if (!p) return;
    if (board.isGuest) {
      if (localRevision !== fingerprint(board.localDocument()))
        throw new Error('预览后本机数据已变化，请重新预检');
      if (Date.now() > Date.parse(p.expiresAt)) throw new Error('预览已过期，请重新预检');
      const incoming = document.value!;
      const mapping = new Map(
        Object.values(incoming.items)
          .flat()
          .map((v) => [v.id, crypto.randomUUID()]),
      );
      const merged =
        p.mode === 'append'
          ? board.localDocument()
          : ({
              ...incoming,
              items: { annual: [], monthly: [], weekly: [], daily: [] },
            } as TransferDocument);
      for (const type of ['annual', 'monthly', 'weekly', 'daily'] as const)
        for (const row of incoming.items[type])
          merged.items[type].push({
            ...row,
            id: mapping.get(row.id)!,
            parentId: row.parentId ? (mapping.get(row.parentId) ?? null) : null,
            version: 1,
          });
      await local.replaceLocal(local.GUEST, merged);
      await board.reloadLocal();
    } else {
      commitJob ??= { previewId: p.id, operationId: crypto.randomUUID() };
      await execute({
        action: 'commit',
        body: commitJob,
        ...(guestRevision.value ? { guest: guestRevision.value } : {}),
      });
      await board.load();
    }
    preview.value = null;
    document.value = null;
    commitJob = undefined;
    notice.value = '导入完成；替换前的数据可在备份中恢复';
    board.notice = notice.value;
    dialog.value?.close();
    await backups();
    if (guestRevision.value) {
      await local.metaPut(`guest-dismiss:${board.userId}`, guestRevision.value);
      guestAvailable.value = false;
      guestRevision.value = '';
    }
  });
}
async function clear() {
  await run(async () => {
    if (pendingBulk.value) throw new Error('请先重试确认上次批量操作');
    preview.value = null;
    if (!clearJob) {
      if (!(await board.flushAll())) throw new Error('请先联网同步完毕并处理冲突，再清空');
      const state = board.isGuest
        ? { revision: '', counts: documentCounts(board.localDocument()) }
        : await request<{ revision: string; counts: ReturnType<typeof documentCounts> }>(
            '/api/data/state',
            undefined,
            { headers: headers() },
          );
      const counts = state.counts;
      if (
        !window.confirm(
          `清空当前${board.isGuest ? '本机访客' : '账号'}全部事项？年 ${counts.annual}、月 ${counts.monthly}、周 ${counts.weekly}、日 ${counts.daily}。将先自动备份，历史复盘保留。`,
        )
      )
        return;
      clearJob = { revision: state.revision, operationId: crypto.randomUUID() };
    }
    if (board.isGuest) {
      const doc = board.localDocument();
      doc.items = { annual: [], monthly: [], weekly: [], daily: [] };
      await local.replaceLocal(local.GUEST, doc);
      await board.reloadLocal();
    } else {
      await execute({ action: 'clear', body: clearJob });
      await board.load();
    }
    clearJob = undefined;
    notice.value = '已清空，自动备份可恢复';
    await backups();
  });
}
async function restore(id: string) {
  await run(async () => {
    if (pendingBulk.value) throw new Error('请先重试确认上次批量操作');
    if (board.isGuest) {
      const backup = guestBackups.value.find((v) => v.id === id);
      if (backup) await prepare(backup.document, 'replace');
    } else {
      if (!(await board.flushAll())) throw new Error('请先同步并处理冲突');
      preview.value = await request<ImportPreview>(
        `/api/data/backups/${id}/preview`,
        {},
        { headers: headers() },
      );
      commitJob = undefined;
    }
  });
}
async function migrateGuest() {
  await open();
  await run(async () => {
    const guest = await local.readLocal(local.GUEST),
      doc: TransferDocument = {
        format: 'four-layer-workbench',
        version: 3,
        exportedAt: new Date().toISOString(),
        items: { annual: [], monthly: [], weekly: [], daily: [] },
      };
    for (const item of guest.items) doc.items[item.type].push(item);
    guestRevision.value = fingerprint(doc);
    await prepare(doc, 'append');
  });
}
async function dismissGuest() {
  const data = await local.readLocal(local.GUEST);
  await local.metaPut(
    `guest-dismiss:${board.userId}`,
    JSON.stringify(
      Object.fromEntries(
        ['annual', 'monthly', 'weekly', 'daily'].map((t) => [
          t,
          data.items.filter((v) => v.type === t),
        ]),
      ),
    ),
  );
  guestAvailable.value = false;
}
onMounted(async () => {
  if (board.isGuest) return;
  pendingBulk.value =
    (await local.metaGet<BulkJob>(`bulk-job:${board.userId}`).catch(() => undefined)) ?? null;
  const data = await local.readLocal(local.GUEST);
  const doc = {
    items: Object.fromEntries(
      ['annual', 'monthly', 'weekly', 'daily'].map((t) => [
        t,
        data.items.filter((v) => v.type === t),
      ]),
    ),
  } as TransferDocument;
  guestAvailable.value =
    data.items.some((v) => !v.deletedAt) &&
    (await local.metaGet(`guest-dismiss:${board.userId}`)) !== fingerprint(doc);
});
</script>
<template>
  <div class="wb-data-tools">
    <button class="wb-button" type="button" @click="open">数据管理</button
    ><button
      class="wb-button"
      type="button"
      @click="
        error = '';
        exportDialog?.showModal();
      "
    >
      导出数据{{ board.hasUnsaved ? '（本机草稿）' : '' }}
    </button>
  </div>
  <dialog ref="exportDialog" class="wb-dialog wb-export-dialog" aria-labelledby="export-heading">
    <div class="wb-dialog-top">
      <h2 id="export-heading">导出数据</h2>
      <DialogCloseButton label="关闭导出" :disabled="busy" @click="exportDialog?.close()" />
    </div>
    <p>选择导出格式。导出包含当前账号的四层事项、原计划与关联关系；未同步的本机草稿一并保留。</p>
    <div class="wb-export-formats" role="group" aria-label="导出格式">
      <label
        v-for="option in [
          { value: 'xlsx', label: 'Excel（.xlsx）' },
          { value: 'txt', label: '文本（.txt）' },
          { value: 'docx', label: 'Word（.docx）' },
          { value: 'json', label: 'JSON（.json）' },
        ]"
        :key="option.value"
        ><input
          v-model="exportFormat"
          type="radio"
          name="export-format"
          :value="option.value"
          :disabled="busy"
        />{{ option.label }}</label
      >
    </div>
    <p v-if="error" class="wb-banner wb-banner-error" role="alert">{{ error }}</p>
    <div class="wb-dialog-actions">
      <button type="button" class="wb-button primary" :disabled="busy" @click="exportData">
        {{ busy ? '正在生成文件…' : '下载文件' }}
      </button>
    </div>
  </dialog>
  <div v-if="pendingBulk" class="wb-banner wb-banner-error" role="alert">
    <span
      >上次{{
        pendingBulk.action === 'commit' ? '导入/恢复' : '清空'
      }}尚未确认结果，原操作已保存在本机。</span
    ><button type="button" :disabled="busy" @click="resume">重试确认上次操作</button>
  </div>
  <div v-if="guestAvailable" class="wb-banner" role="status">
    <span>本机还有访客数据。确认预览后可追加到此账号，访客原件保留。</span
    ><button type="button" @click="migrateGuest">预览迁移</button
    ><button type="button" @click="dismissGuest">暂不迁移</button>
  </div>
  <dialog ref="dialog" class="wb-dialog wb-data-dialog" aria-labelledby="data-heading">
    <div class="wb-dialog-top">
      <h2 id="data-heading">数据管理 · {{ board.isGuest ? '本机访客' : '当前账号' }}</h2>
      <DialogCloseButton label="关闭数据管理" :disabled="busy" @click="dialog?.close()" />
    </div>
    <p>
      支持 Word（.docx）、Excel（.xlsx）、TXT 和
      JSON（v1/v2/v3）。导入先预检；替换、清空、恢复前自动备份。单文件最多 5 MiB / 10000 条。
    </p>
    <p>
      表格包含“标题”列，可选“层级、编号、上级编号、年度、月份、执行日期”等列；可先导出一份作为模板。Word
      正文或普通 TXT 每段/每行作为一条日待办，日期默认为今天。旧版 .doc / .xls 请另存为 .docx /
      .xlsx。
    </p>
    <p v-if="!board.isGuest">
      {{
        board.offline
          ? '当前离线：可导出本机草稿，联网后再导入或恢复。'
          : '云端备份保留原事项和关联；历史复盘独立保留。'
      }}
    </p>
    <div v-if="error" class="wb-banner wb-banner-error" role="alert">{{ error }}</div>
    <div v-if="notice" class="wb-banner wb-banner-success" role="status">{{ notice }}</div>
    <div class="wb-data-tools">
      <label
        >导入方式
        <select v-model="mode" :disabled="busy">
          <option value="append">追加，保留现有数据</option>
          <option value="replace">替换，先自动备份</option>
        </select></label
      ><label class="wb-button"
        >选择文件<input
          type="file"
          accept=".json,.txt,.docx,.xlsx,application/json,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          :disabled="busy"
          @change="file" /></label
      ><button type="button" class="wb-button" :disabled="busy" @click="sample">
        载入示例并预览</button
      ><button type="button" class="wb-button" :disabled="busy" @click="clear">清空并备份</button>
    </div>
    <section v-if="preview" class="wb-data-preview" aria-label="导入预览">
      <h3>{{ preview.mode === 'append' ? '追加' : '替换' }}预览</h3>
      <p>
        年度 {{ preview.counts.annual }} · 月度 {{ preview.counts.monthly }} · 周任务
        {{ preview.counts.weekly }} · 日待办 {{ preview.counts.daily }}
      </p>
      <p>
        现有：年度 {{ preview.current.annual }} · 月度 {{ preview.current.monthly }} · 周任务
        {{ preview.current.weekly }} · 日待办 {{ preview.current.daily }}
      </p>
      <p v-for="warning in preview.warnings" :key="warning">{{ warning }}</p>
      <p v-if="preview.pastItems">
        {{ preview.pastItems }} 条未完成事项已过期，导入后按账号当前日期顺延，保留原计划。
      </p>
      <ul>
        <li v-for="(title, index) in preview.titles" :key="index">{{ title }}</li>
      </ul>
      <p>有效至 {{ new Date(preview.expiresAt).toLocaleString() }}；提交前检查现有数据是否变化。</p>
      <button type="button" class="wb-button primary" :disabled="busy" @click="commit">
        确认{{ preview.mode === 'append' ? '追加' : '替换' }}</button
      ><button type="button" class="wb-button" :disabled="busy" @click="preview = null">
        取消预览
      </button>
    </section>
    <h3>自动备份（最近 20 条）</h3>
    <button type="button" class="wb-button" :disabled="busy" @click="run(backups)">刷新备份</button>
    <div
      v-for="backup in board.isGuest ? guestBackups.slice(0, 20) : (cloudBackups?.items ?? [])"
      :key="backup.id"
      class="wb-data-backup"
    >
      <span
        >{{ new Date(backup.createdAt).toLocaleString() }} ·
        {{
          'reason' in backup
            ? { clear: '清空前', replace: '替换前', restore: '恢复前' }[backup.reason]
            : '本机备份'
        }}</span
      ><button type="button" class="wb-button" :disabled="busy" @click="restore(backup.id)">
        预览恢复
      </button>
    </div>
  </dialog>
</template>
