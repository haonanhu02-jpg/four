<script setup lang="ts">
import { ref } from 'vue';
import type { ManagedAccount, ManagedAccounts, AdminAuditList } from '@workbench/contracts';
import { adminCreateSchema, adminUpdateSchema, adminResetSchema } from '@workbench/contracts';
import { request, errorMessage } from '../lib/api';
import { useAccountStore } from '../stores/account';
import { useWorkbenchStore } from '../stores/workbench';
import DialogCloseButton from './DialogCloseButton.vue';
const account = useAccountStore(),
  dialog = ref<HTMLDialogElement>(),
  tab = ref<'accounts' | 'logs'>('accounts');
const busy = ref(false),
  error = ref(''),
  notice = ref(''),
  search = ref(''),
  status = ref('all'),
  actionFilter = ref('all'),
  offset = ref(0);
const accounts = ref<ManagedAccounts | null>(null),
  logs = ref<AdminAuditList | null>(null);
type EditKind = 'create' | 'update' | 'password' | 'disable' | 'enable' | 'delete' | 'restore';
const editor = ref<{ kind: EditKind; target?: ManagedAccount } | null>(null),
  username = ref(''),
  password = ref(''),
  role = ref<'user' | 'admin'>('user');
const actionNames: Record<string, string> = {
  bootstrap: '初始化管理员',
  create: '新建账号',
  update: '修改账号',
  reset_password: '重置密码',
  disable: '停用账号',
  enable: '启用账号',
  delete: '删除账号',
  restore: '恢复账号',
  password: '重置密码',
};
const state = (row: ManagedAccount) =>
  row.deletedAt ? '已删除' : row.disabledAt ? '已停用' : '正常';
async function load() {
  const q = new URLSearchParams({
    search: search.value,
    limit: '20',
    offset: String(offset.value),
  });
  if (tab.value === 'accounts') {
    q.set('status', status.value);
    accounts.value = await request<ManagedAccounts>('/api/admin/accounts?' + q);
  } else {
    q.set('action', actionFilter.value);
    logs.value = await request<AdminAuditList>('/api/admin/logs?' + q);
  }
}
async function run(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await work();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function open() {
  if (!(await useWorkbenchStore().persistAll())) {
    error.value = '本机草稿保存未完成，请先重试保存';
    return;
  }
  editor.value = null;
  password.value = '';
  dialog.value?.showModal();
  await run(load);
}
async function filter() {
  offset.value = 0;
  await run(load);
}
async function page(delta: number) {
  offset.value = Math.max(0, offset.value + delta * 20);
  await run(load);
}
async function changeTab(next: 'accounts' | 'logs') {
  tab.value = next;
  offset.value = 0;
  search.value = '';
  editor.value = null;
  password.value = '';
  await run(load);
}
function edit(kind: EditKind, target?: ManagedAccount) {
  editor.value = { kind, target };
  username.value = target?.username ?? '';
  password.value = '';
  role.value = target?.role ?? 'user';
  error.value = '';
  notice.value = '';
}
async function save() {
  await run(async () => {
    const e = editor.value;
    if (!e) return;
    const body =
      e.kind === 'create'
        ? { username: username.value, password: password.value, role: role.value }
        : e.kind === 'update'
          ? { username: username.value, role: role.value }
          : e.kind === 'password'
            ? { password: password.value }
            : {};
    const schema =
      e.kind === 'create'
        ? adminCreateSchema
        : e.kind === 'update'
          ? adminUpdateSchema
          : e.kind === 'password'
            ? adminResetSchema
            : null;
    const parsed = schema?.safeParse(body);
    if (parsed && !parsed.success) throw Error(parsed.error.issues[0]?.message ?? '请检查输入');
    const url =
      e.kind === 'create' ? '/api/admin/accounts' : `/api/admin/accounts/${e.target!.id}/${e.kind}`;
    await request(url, parsed?.success ? parsed.data : body);
    password.value = '';
    editor.value = null;
    notice.value = '操作已完成，并写入管理日志。';
    if (e.target?.id === account.session?.user.id) {
      await account.initialize();
      if (account.session?.user.role !== 'admin') {
        dialog.value?.close();
        return;
      }
    }
    await load();
  });
}
function description(before: ManagedAccount | null, after: ManagedAccount, action: string) {
  if (!before) return `${after.username} · ${after.role === 'admin' ? '管理员' : '普通账号'}`;
  const changes: string[] = [];
  if (before.username !== after.username)
    changes.push(`工号：${before.username} → ${after.username}`);
  if (before.role !== after.role)
    changes.push(
      `角色：${before.role === 'admin' ? '管理员' : '普通账号'} → ${after.role === 'admin' ? '管理员' : '普通账号'}`,
    );
  if (state(before) !== state(after)) changes.push(`${state(before)} → ${state(after)}`);
  return (
    changes.join('；') ||
    (action === 'reset_password' ? '密码已重置（日志不记录密码）' : '账号信息已保存')
  );
}
</script>
<template>
  <button
    v-if="account.session?.user.role === 'admin'"
    type="button"
    class="wb-button"
    @click="open"
  >
    账号管理
  </button>
  <dialog
    ref="dialog"
    class="wb-dialog wb-admin-dialog"
    aria-labelledby="admin-heading"
    @close="
      editor = null;
      password = '';
    "
  >
    <div class="wb-dialog-top">
      <h2 id="admin-heading">账号管理</h2>
      <DialogCloseButton label="关闭账号管理" :disabled="busy" @click="dialog?.close()" />
    </div>
    <div class="wb-admin-tabs">
      <button
        class="wb-button"
        :class="{ primary: tab === 'accounts' }"
        type="button"
        :disabled="busy"
        @click="changeTab('accounts')"
      >
        所有账号</button
      ><button
        class="wb-button"
        :class="{ primary: tab === 'logs' }"
        type="button"
        :disabled="busy"
        @click="changeTab('logs')"
      >
        管理日志
      </button>
    </div>
    <p v-if="error" class="wb-banner wb-banner-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="wb-banner wb-banner-success" role="status">{{ notice }}</p>
    <form v-if="editor" class="wb-admin-editor" @submit.prevent="save">
      <h3>
        {{ actionNames[editor.kind]
        }}<template v-if="editor.target"> · {{ editor.target.username }}</template>
      </h3>
      <template v-if="editor.kind === 'create' || editor.kind === 'update'"
        ><label
          >工号<input
            v-model="username"
            aria-label="管理账号工号"
            autocomplete="off"
            placeholder="请输入您的工号"
            maxlength="254"
            :disabled="busy" /></label
        ><label
          >角色<select v-model="role" aria-label="管理账号角色" :disabled="busy">
            <option value="user">普通账号</option>
            <option value="admin">管理员</option>
          </select></label
        ></template
      >
      <label v-if="editor.kind === 'create' || editor.kind === 'password'"
        >{{ editor.kind === 'create' ? '初始密码' : '新密码'
        }}<input
          v-model="password"
          type="password"
          aria-label="管理账号密码"
          autocomplete="new-password"
          placeholder="至少 6 位"
          minlength="6"
          maxlength="128"
          :disabled="busy"
      /></label>
      <p v-if="editor.kind === 'delete'">
        删除后无法登录，目标和历史数据会保留，可在“已删除”列表恢复。
      </p>
      <p v-if="editor.kind === 'disable'">
        停用后立即撤销该账号的在线会话，重新启用后可用原密码登录。
      </p>
      <p v-if="editor.kind === 'password'">
        重置密码会撤销该账号全部在线会话，需要使用新密码重新登录。
      </p>
      <p v-if="editor.kind === 'restore' || editor.kind === 'enable'">
        确认{{ actionNames[editor.kind] }}？
      </p>
      <div class="wb-dialog-actions">
        <button
          class="wb-button"
          type="button"
          :disabled="busy"
          @click="
            editor = null;
            password = '';
          "
        >
          取消</button
        ><button class="wb-button primary" type="submit" :disabled="busy">
          {{ busy ? '正在保存…' : '确认保存' }}
        </button>
      </div>
    </form>
    <form class="wb-admin-filters" @submit.prevent="filter">
      <input
        v-model="search"
        aria-label="管理搜索"
        :placeholder="tab === 'accounts' ? '搜索工号' : '搜索操作人或对象工号'"
        maxlength="100"
      /><select v-if="tab === 'accounts'" v-model="status" aria-label="账号状态筛选">
        <option value="all">全部账号（不含已删除）</option>
        <option value="active">正常</option>
        <option value="disabled">已停用</option>
        <option value="deleted">已删除</option></select
      ><select v-else v-model="actionFilter" aria-label="日志操作筛选">
        <option value="all">全部操作</option>
        <option
          v-for="(label, key) in actionNames"
          v-show="key !== 'password'"
          :key="key"
          :value="key"
        >
          {{ label }}
        </option></select
      ><button class="wb-button" type="submit" :disabled="busy">查询</button
      ><button
        v-if="tab === 'accounts'"
        type="button"
        class="wb-button primary"
        :disabled="busy"
        @click="edit('create')"
      >
        新建账号
      </button>
    </form>
    <div class="wb-admin-table-wrap">
      <table v-if="tab === 'accounts'" class="wb-admin-table">
        <thead>
          <tr>
            <th>工号</th>
            <th>角色</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>管理操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in accounts?.items ?? []" :key="row.id" :data-account-id="row.id">
            <td>
              {{ row.username
              }}<small v-if="row.id === account.session?.user.id">（当前账号）</small>
            </td>
            <td>{{ row.role === 'admin' ? '管理员' : '普通账号' }}</td>
            <td>{{ state(row) }}</td>
            <td>{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</td>
            <td>
              <div class="wb-admin-row-actions">
                <template v-if="!row.deletedAt"
                  ><button type="button" :disabled="busy" @click="edit('update', row)">修改</button
                  ><button type="button" :disabled="busy" @click="edit('password', row)">
                    重置密码</button
                  ><button
                    type="button"
                    :disabled="busy"
                    @click="edit(row.disabledAt ? 'enable' : 'disable', row)"
                  >
                    {{ row.disabledAt ? '启用' : '停用' }}</button
                  ><button type="button" :disabled="busy" @click="edit('delete', row)">
                    删除
                  </button></template
                ><button v-else type="button" :disabled="busy" @click="edit('restore', row)">
                  恢复
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <table v-else class="wb-admin-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>操作人</th>
            <th>对象</th>
            <th>操作</th>
            <th>变更内容</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in logs?.items ?? []" :key="row.id">
            <td>{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</td>
            <td>{{ row.actorUsername }}</td>
            <td>{{ row.targetUsername }}</td>
            <td>{{ actionNames[row.action] ?? row.action }}</td>
            <td>
              {{ description(row.before, row.after, row.action)
              }}<small>来源 {{ row.ip }} · 请求 {{ row.requestId }}</small>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!(tab === 'accounts' ? accounts?.items.length : logs?.items.length)">
      {{ busy ? '正在加载…' : '暂无记录' }}
    </p>
    <div class="wb-admin-pagination">
      <span>共 {{ tab === 'accounts' ? (accounts?.total ?? 0) : (logs?.total ?? 0) }} 条</span
      ><button class="wb-button" type="button" :disabled="busy || offset === 0" @click="page(-1)">
        上一页</button
      ><span>第 {{ Math.floor(offset / 20) + 1 }} 页</span
      ><button
        class="wb-button"
        type="button"
        :disabled="
          busy || offset + 20 >= (tab === 'accounts' ? (accounts?.total ?? 0) : (logs?.total ?? 0))
        "
        @click="page(1)"
      >
        下一页
      </button>
    </div>
  </dialog>
</template>
