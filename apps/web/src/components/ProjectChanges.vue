<script setup lang="ts">
import { ref, watch } from 'vue';
import { itemState, type WorkItem } from '@workbench/contracts';
import { useWorkbenchStore } from '../stores/workbench';
import { request, errorMessage } from '../lib/api';
const board = useWorkbenchStore();
interface Result {
  baselineAt: string | null;
  projects: { current: WorkItem; initial: WorkItem | null; initialAt: string | null }[];
  changes: {
    id: string;
    itemId: string;
    action: string;
    before: WorkItem | null;
    after: WorkItem | null;
    createdAt: string;
  }[];
  total: number;
  limit: number;
  offset: number;
}
const data = ref<Result>(),
  error = ref(''),
  busy = ref(false),
  offset = ref(0);
let sequence = 0;
const fields = {
  title: '项目名称',
  note: '衡量标准',
  year: '所属年度',
  weight: '权重',
  dueDate: '截止日期',
  progress: '进度',
  progressMode: '进度模式',
  terminated: '终止状态',
  terminationReason: '终止原因',
};
function differences(before: WorkItem | null, after: WorkItem | null) {
  const display = (key: string, value: unknown) =>
    key === 'terminated'
      ? value
        ? '已终止'
        : '执行中'
      : key === 'progressMode'
        ? value === 'auto'
          ? '自动汇总'
          : '手动填写'
        : String(value ?? '未设置');
  return (
    Object.entries(fields)
      .filter(
        ([key]) =>
          JSON.stringify(before?.[key as keyof WorkItem]) !==
          JSON.stringify(after?.[key as keyof WorkItem]),
      )
      .map(
        ([key, label]) =>
          `${label}：${display(key, before?.[key as keyof WorkItem])} → ${display(key, after?.[key as keyof WorkItem])}`,
      )
      .join('；') || '记录创建或关联变动'
  );
}
async function load() {
  const token = ++sequence,
    owner = board.userId;
  data.value = undefined;
  error.value = '';
  if (board.isGuest) {
    busy.value = false;
    return;
  }
  busy.value = true;
  try {
    const result = await request<Result>(
      `/api/history/projects?year=${board.selection.year}&offset=${offset.value}&limit=20`,
      undefined,
      { headers: { 'X-Workbench-Account': owner } },
    );
    if (token === sequence) data.value = result;
  } catch (e) {
    if (token === sequence) error.value = errorMessage(e);
  } finally {
    if (token === sequence) busy.value = false;
  }
}
async function recordBaseline() {
  const owner = board.userId,
    year = board.selection.year;
  if (
    !window.confirm(
      '请确认当前年度目标与年初计划一致。将记录当前服务器数据作为本年度基线，记录后不覆盖；后续修改会保留变更历史。',
    )
  )
    return;
  error.value = '';
  try {
    if (!(await board.persistAll()) || !(await board.sync()) || board.pendingCount)
      throw Error('请先完成待同步修改，再记录基线');
    if (board.userId !== owner || board.selection.year !== year)
      throw Error('账号或年度已切换，请重新确认');
    await request(
      '/api/history/projects/baseline',
      { year },
      { headers: { 'X-Workbench-Account': owner } },
    );
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  }
}
watch(
  () => `${board.userId}/${board.selection.year}`,
  () => {
    offset.value = 0;
    void load();
  },
  { immediate: true },
);
</script>
<template>
  <section class="wb-section wb-project-changes" aria-label="项目变动情况">
    <header class="wb-section-header">
      <div>
        <h2>项目变动情况</h2>
        <p>对照初始计划、当前项目和每次调整，保留新增、修改、终止及删除记录。</p>
      </div>
      <button type="button" class="wb-button" :disabled="busy || board.isGuest" @click="load">
        刷新变动</button
      ><button
        v-if="!data?.baselineAt && !board.isGuest"
        type="button"
        class="wb-button"
        :disabled="busy"
        @click="recordBaseline"
      >
        记录年初计划基线
      </button>
    </header>
    <p v-if="board.isGuest" class="wb-insight-empty">
      登录同步后可查看账号的项目变动日志并记录年初计划基线；访客当前内容不会伪装成年初记录。
    </p>
    <p v-if="error" class="wb-error" role="alert">{{ error }}</p>
    <p v-if="busy">正在读取项目变动…</p>
    <template v-if="data">
      <p class="wb-month-sources">
        {{
          data.baselineAt
            ? `年初计划基线记录于 ${new Date(data.baselineAt).toLocaleString()}`
            : '尚未记录年初基线；以下仅展示最早留存记录，不能据此认定为年初计划。'
        }}
      </p>
      <details
        v-for="project in data.projects"
        :key="project.current.id"
        class="wb-project-comparison"
      >
        <summary>
          {{ project.current.title || '未命名项目' }}
          <span>{{
            project.current.deletedAt
              ? '已删除'
              : project.current.terminated
                ? '已终止'
                : project.current.year !== board.selection.year
                  ? '已移出本年度'
                  : data.baselineAt && !project.initial
                    ? '基线后新增'
                    : { todo: '未开始', doing: '进行中', complete: '已完成', terminated: '已终止' }[
                        itemState(project.current, Object.values(board.records))
                      ]
          }}</span>
        </summary>
        <div class="wb-project-columns">
          <div>
            <strong>{{ data.baselineAt ? '年初计划' : '最早留存记录' }}</strong
            ><template v-if="project.initial"
              ><p>{{ project.initial.title }}</p>
              <p>{{ project.initial.note }}</p>
              <p>
                权重 {{ project.initial.weight }}% · 截止 {{ project.initial.dueDate || '未设置' }}
              </p></template
            >
            <p v-else>{{ data.baselineAt ? '基线中不存在此项目' : '没有可追溯的初始记录' }}</p>
          </div>
          <div>
            <strong>当前情况</strong>
            <p>{{ project.current.title }}</p>
            <p>{{ project.current.note }}</p>
            <p>
              权重 {{ project.current.weight }}% · 截止 {{ project.current.dueDate || '未设置' }}
            </p>
            <p v-if="project.current.terminationReason">
              终止原因：{{ project.current.terminationReason }}
            </p>
          </div>
        </div>
        <p v-if="project.initial">变化：{{ differences(project.initial, project.current) }}</p>
      </details>
      <h3>变更记录 {{ data.total }} 条</h3>
      <ol class="wb-project-log">
        <li v-for="change in data.changes" :key="change.id">
          <strong
            >{{ new Date(change.createdAt).toLocaleString() }} ·
            {{ change.after?.title || change.before?.title || '未命名项目' }}</strong
          >
          <p>
            {{
              change.action === 'create'
                ? '新增项目'
                : change.action === 'delete'
                  ? '删除项目'
                  : change.action === 'restore'
                    ? '恢复项目'
                    : differences(change.before, change.after)
            }}
          </p>
        </li>
      </ol>
      <div class="wb-project-pages">
        <button
          class="wb-button"
          :disabled="offset === 0 || busy"
          @click="
            offset = Math.max(0, offset - 20);
            load();
          "
        >
          上一页</button
        ><span
          >{{ data.total ? offset + 1 : 0 }}–{{ Math.min(offset + 20, data.total) }} /
          {{ data.total }}</span
        ><button
          class="wb-button"
          :disabled="offset + 20 >= data.total || busy"
          @click="
            offset += 20;
            load();
          "
        >
          下一页
        </button>
      </div>
    </template>
  </section>
</template>
