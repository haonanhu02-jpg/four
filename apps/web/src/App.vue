<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue';
import { API, passwordLoginSchema, registerSchema, type AuthResponse } from '@workbench/contracts';
import { ApiClientError, errorMessage, request } from './lib/api';
import { useAccountStore } from './stores/account';
import Workbench from './components/Workbench.vue';
import AppTools from './components/AppTools.vue';

type Mode = 'password' | 'register';
const account = useAccountStore();
watchEffect(() => {
  document.title = account.session ? '四层对齐工作台' : '四层对齐工作台 · 登录';
});
const mode = ref<Mode>('password');
const username = ref('');
const password = ref('');
const showPassword = ref(false);
const submitting = ref(false);
const error = ref('');
const requestId = ref('');
const notice = ref('');
const fieldErrors = ref<Record<string, string>>({});
const title = computed(() => (mode.value === 'register' ? '开始有目标的一天' : '欢迎回来'));
const subtitle = computed(() =>
  mode.value === 'register'
    ? '用工号创建账号，连接你的目标与行动。'
    : '使用工号和密码登录，连接你的工作台。',
);
const submitLabel = computed(() => (mode.value === 'register' ? '创建账号' : '登录工作台'));

function changeMode(next: Mode) {
  mode.value = next;
  password.value = '';
  error.value = '';
  notice.value = '';
  requestId.value = '';
  fieldErrors.value = {};
  showPassword.value = false;
}
function displayError(caught: unknown) {
  error.value = errorMessage(caught);
  requestId.value = caught instanceof ApiClientError ? (caught.requestId ?? '') : '';
}
async function submit() {
  if (submitting.value) return;
  error.value = '';
  notice.value = '';
  requestId.value = '';
  fieldErrors.value = {};
  const schema = mode.value === 'register' ? registerSchema : passwordLoginSchema;
  const parsed = schema.safeParse({ username: username.value, password: password.value });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'form');
      if (!fieldErrors.value[field]) fieldErrors.value[field] = issue.message;
    }
    return;
  }
  submitting.value = true;
  try {
    const result = await request<AuthResponse>(
      mode.value === 'register' ? API.register : API.passwordLogin,
      parsed.data,
    );
    password.value = '';
    await account.acceptSession(result);
  } catch (caught) {
    displayError(caught);
  } finally {
    submitting.value = false;
  }
}
async function logout() {
  if (submitting.value) return;
  submitting.value = true;
  error.value = '';
  try {
    await account.logout();
    changeMode('password');
    notice.value = '已安全退出登录。';
  } catch (caught) {
    displayError(caught);
  } finally {
    submitting.value = false;
  }
}
onMounted(() => {
  void account.initialize();
});
</script>

<template>
  <div class="site-shell">
    <header class="site-header">
      <a class="brand" href="/" aria-label="四层对齐工作台首页">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none">
            <path
              d="m16 5 11 6-11 6-11-6 11-6Zm-11 12 11 6 11-6M5 23l11 6 11-6"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span>四层对齐<span class="brand-accent">工作台</span></span>
      </a>
      <AppTools />
    </header>

    <main v-if="account.initializing" class="initial-state" aria-live="polite" aria-busy="true">
      <span class="spinner spinner-large" aria-hidden="true" />
      <h1>正在连接你的工作台</h1>
      <p>检查登录状态，请稍候…</p>
    </main>

    <main v-else-if="!account.session" class="auth-layout">
      <section class="intro-panel" aria-labelledby="intro-heading">
        <p class="eyebrow"><span class="eyebrow-line" />从目标到行动，层层对齐</p>
        <h1 id="intro-heading">让每天的行动，<br />都有<span>目标可循。</span></h1>
        <p class="intro-copy">
          看清一年的方向，安排一个月的重点，<br
            class="desktop-break"
          />把这一周的任务，落在今天的每一步。
        </p>

        <div class="alignment-preview" aria-label="年度、月度、每周、每日的四层工作关系">
          <div class="preview-top">
            <span class="preview-caption">一条清晰的行动路径</span
            ><span class="preview-label">年 → 月 → 周 → 日</span>
          </div>
          <div class="path-row">
            <span class="path-mark annual">年</span>
            <div><strong>年度目标</strong><span>这一年，想要实现什么</span></div>
            <span class="path-number">01</span>
          </div>
          <div class="path-connector" aria-hidden="true" />
          <div class="path-row">
            <span class="path-mark monthly">月</span>
            <div><strong>月度重点</strong><span>这个月，向目标更近一步</span></div>
            <span class="path-number">02</span>
          </div>
          <div class="path-connector" aria-hidden="true" />
          <div class="path-row">
            <span class="path-mark weekly">周</span>
            <div><strong>每周任务</strong><span>这一周，推进具体的事</span></div>
            <span class="path-number">03</span>
          </div>
          <div class="path-connector" aria-hidden="true" />
          <div class="path-row today-row">
            <span class="path-mark daily">日</span>
            <div><strong>今日行动</strong><span>今天，专注做好眼前一步</span></div>
            <span class="today-pill">从这里开始</span>
          </div>
        </div>
        <div class="intro-note">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="m10 2 6 2.5V10c0 4-6 7-6 7s-6-3-6-7V4.5L10 2Z"
              stroke="currentColor"
              stroke-width="1.4"
            />
            <path
              d="m7 9 2 2 4-4"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            /></svg
          >账号独立 · 数据由你掌握
        </div>
      </section>

      <section class="auth-card" aria-labelledby="auth-heading">
        <div class="main-tabs" aria-label="账号操作">
          <button
            type="button"
            :class="{ active: mode === 'password' }"
            :aria-pressed="mode === 'password'"
            :disabled="submitting"
            @click="changeMode('password')"
          >
            登录
          </button>
          <button
            type="button"
            :class="{ active: mode === 'register' }"
            :aria-pressed="mode === 'register'"
            :disabled="submitting"
            @click="changeMode('register')"
          >
            注册
          </button>
        </div>
        <h2 id="auth-heading">{{ title }}</h2>
        <p class="auth-subtitle">{{ subtitle }}</p>
        <div v-if="account.sessionError" class="alert alert-warning" role="alert">
          <span>{{ account.sessionError }}</span>
          <button type="button" class="text-button" @click="account.initialize()">重新连接</button>
        </div>
        <div v-if="error" id="form-error" class="alert alert-error" role="alert">
          <span>{{ error }}</span
          ><small v-if="requestId">请求编号：{{ requestId }}</small>
        </div>
        <div v-if="notice" class="alert alert-success" role="status">{{ notice }}</div>
        <form novalidate :aria-busy="submitting" @submit.prevent="submit">
          <div class="form-field">
            <label for="username">工号</label>
            <div class="input-shell" :class="{ invalid: fieldErrors.username }">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="10" cy="6" r="3" stroke="currentColor" stroke-width="1.5" />
                <path
                  d="M4 17v-2a6 6 0 0 1 12 0v2"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
              <input
                id="username"
                v-model="username"
                name="username"
                type="text"
                autocomplete="username"
                autocapitalize="none"
                :spellcheck="false"
                placeholder="请输入您的工号"
                maxlength="254"
                :disabled="submitting"
                :aria-invalid="Boolean(fieldErrors.username)"
                :aria-describedby="fieldErrors.username ? 'username-error' : undefined"
              />
            </div>
            <p v-if="fieldErrors.username" id="username-error" class="field-error">
              {{ fieldErrors.username }}
            </p>
          </div>
          <div class="form-field">
            <label for="password">{{ mode === 'register' ? '设置密码' : '登录密码' }}</label>
            <div class="input-shell" :class="{ invalid: fieldErrors.password }">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <rect
                  x="4"
                  y="8"
                  width="12"
                  height="9"
                  rx="2.5"
                  stroke="currentColor"
                  stroke-width="1.5"
                />
                <path
                  d="M6.5 8V6a3.5 3.5 0 0 1 7 0v2M10 11.5v2"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
              <input
                id="password"
                v-model="password"
                name="password"
                :type="showPassword ? 'text' : 'password'"
                :autocomplete="mode === 'password' ? 'current-password' : 'new-password'"
                :placeholder="mode === 'password' ? '请输入您的密码' : '设置至少 6 位密码'"
                minlength="6"
                maxlength="128"
                :disabled="submitting"
                :aria-invalid="Boolean(fieldErrors.password)"
                :aria-describedby="fieldErrors.password ? 'password-error' : 'password-hint'"
              />
              <button
                type="button"
                class="password-toggle"
                :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                :aria-pressed="showPassword"
                @click="showPassword = !showPassword"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z"
                    stroke="currentColor"
                    stroke-width="1.4"
                  />
                  <circle cx="10" cy="10" r="2" stroke="currentColor" stroke-width="1.4" />
                  <path
                    v-if="!showPassword"
                    d="m4 3 12 14"
                    stroke="currentColor"
                    stroke-width="1.4"
                  />
                </svg>
              </button>
            </div>
            <p v-if="fieldErrors.password" id="password-error" class="field-error">
              {{ fieldErrors.password }}
            </p>
            <p v-else id="password-hint" class="field-hint">密码至少 6 位</p>
          </div>
          <button class="primary-button submit-button" type="submit" :disabled="submitting">
            <span v-if="submitting" class="spinner" aria-hidden="true" />{{
              submitting ? '正在处理…' : submitLabel
            }}<span v-if="!submitting" aria-hidden="true">→</span>
          </button>
        </form>
        <p class="account-switch">
          {{ mode === 'register' ? '已经有账号？' : '还没有账号？'
          }}<button
            type="button"
            class="text-button"
            :disabled="submitting"
            @click="changeMode(mode === 'register' ? 'password' : 'register')"
          >
            {{ mode === 'register' ? '返回登录' : '创建一个账号' }}
          </button>
        </p>
        <div class="card-footer">
          <button type="button" class="text-button" @click="account.visit()">
            先以访客使用（仅本机保存）
          </button>
          <span class="lock-symbol" aria-hidden="true">◇</span> 账号同步，从这里开始
        </div>
      </section>
    </main>

    <Workbench
      v-else
      :key="account.session.user.id"
      :logging-out="submitting"
      :logout-error="error"
      @logout="logout"
    />

    <footer class="site-footer">
      <span>四层对齐工作台</span><span>把重要的事，落实到每一天。</span>
    </footer>
  </div>
</template>
