<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue';
import {
  API,
  emailSchema,
  otpLoginSchema,
  passwordLoginSchema,
  registerSchema,
  resetPasswordSchema,
  type AuthResponse,
  type OtpPurpose,
  type RequestCodeResponse,
} from '@workbench/contracts';
import { ApiClientError, errorMessage, request } from './lib/api';
import { useAccountStore } from './stores/account';
import Workbench from './components/Workbench.vue';
import AppTools from './components/AppTools.vue';

type Mode = 'password' | 'otp' | 'register' | 'reset';
const account = useAccountStore();
watchEffect(() => {
  document.title = account.session ? '四层对齐工作台' : '四层对齐工作台 · 登录';
});
const mode = ref<Mode>('password');
const email = ref('');
const password = ref('');
const code = ref('');
const showPassword = ref(false);
const submitting = ref(false);
const sendingCode = ref(false);
const error = ref('');
const requestId = ref('');
const notice = ref('');
const fieldErrors = ref<Record<string, string>>({});
const cooldowns = ref<Record<string, number>>({});
const now = ref(Date.now());
let timer: number | undefined;

const purpose = computed<OtpPurpose>(() =>
  mode.value === 'register' ? 'register' : mode.value === 'reset' ? 'reset' : 'login',
);
const cooldownKey = computed(() => `${email.value.trim().toLowerCase()}:${purpose.value}`);
const cooldown = computed(() =>
  Math.max(0, Math.ceil(((cooldowns.value[cooldownKey.value] ?? 0) - now.value) / 1000)),
);
const isLogin = computed(() => mode.value === 'password' || mode.value === 'otp');
const needsCode = computed(() => mode.value !== 'password');
const needsPassword = computed(() => mode.value !== 'otp');
const title = computed(() =>
  mode.value === 'register'
    ? '开始有目标的一天'
    : mode.value === 'reset'
      ? '找回你的账号'
      : '欢迎回来',
);
const subtitle = computed(() =>
  mode.value === 'register'
    ? '用邮箱创建账号，连接你的目标与行动。'
    : mode.value === 'reset'
      ? '验证邮箱后，设置一个新的登录密码。'
      : '登录账号，让手机和电脑连接同一个工作台。',
);
const submitLabel = computed(() =>
  mode.value === 'register' ? '创建账号' : mode.value === 'reset' ? '重置密码并登录' : '登录工作台',
);

function changeMode(next: Mode) {
  mode.value = next;
  password.value = '';
  code.value = '';
  error.value = '';
  notice.value = '';
  requestId.value = '';
  fieldErrors.value = {};
  showPassword.value = false;
}

function displayError(caught: unknown) {
  error.value = errorMessage(caught);
  requestId.value = caught instanceof ApiClientError ? (caught.requestId ?? '') : '';
  if (caught instanceof ApiClientError && caught.retryAfterSeconds) {
    cooldowns.value[cooldownKey.value] = Date.now() + caught.retryAfterSeconds * 1000;
  }
}

async function sendCode() {
  if (sendingCode.value || cooldown.value > 0 || submitting.value) return;
  error.value = '';
  notice.value = '';
  requestId.value = '';
  const parsed = emailSchema.safeParse(email.value);
  if (!parsed.success) {
    fieldErrors.value = { ...fieldErrors.value, email: '请输入有效的邮箱地址' };
    return;
  }
  fieldErrors.value = { ...fieldErrors.value, email: '' };
  sendingCode.value = true;
  const targetKey = cooldownKey.value;
  try {
    const result = await request<RequestCodeResponse>(API.requestCode, {
      email: parsed.data,
      purpose: purpose.value,
    });
    cooldowns.value[targetKey] = Date.now() + result.retryAfterSeconds * 1000;
    notice.value = result.message || '验证码已发送，请检查邮箱。';
  } catch (caught) {
    displayError(caught);
  } finally {
    sendingCode.value = false;
  }
}

async function submit() {
  if (submitting.value || sendingCode.value) return;
  error.value = '';
  notice.value = '';
  requestId.value = '';
  fieldErrors.value = {};
  const input = {
    email: email.value,
    ...(needsPassword.value ? { password: password.value } : {}),
    ...(needsCode.value ? { code: code.value } : {}),
  };
  const schema =
    mode.value === 'password'
      ? passwordLoginSchema
      : mode.value === 'otp'
        ? otpLoginSchema
        : mode.value === 'register'
          ? registerSchema
          : resetPasswordSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'form');
      if (!fieldErrors.value[field]) {
        fieldErrors.value[field] = field === 'email' ? '请输入有效的邮箱地址' : issue.message;
      }
    }
    return;
  }
  submitting.value = true;
  const endpoint =
    mode.value === 'password'
      ? API.passwordLogin
      : mode.value === 'otp'
        ? API.otpLogin
        : mode.value === 'register'
          ? API.register
          : API.resetPassword;
  try {
    const result = await request<AuthResponse>(endpoint, parsed.data);
    password.value = '';
    code.value = '';
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
  timer = window.setInterval(() => {
    now.value = Date.now();
  }, 500);
  void account.initialize();
});
onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer);
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
        <div v-if="mode !== 'reset'" class="main-tabs" aria-label="账号操作">
          <button
            type="button"
            :class="{ active: isLogin }"
            :aria-pressed="isLogin"
            :disabled="submitting || sendingCode"
            @click="changeMode('password')"
          >
            登录
          </button>
          <button
            type="button"
            :class="{ active: mode === 'register' }"
            :aria-pressed="mode === 'register'"
            :disabled="submitting || sendingCode"
            @click="changeMode('register')"
          >
            注册
          </button>
        </div>
        <button
          v-else
          type="button"
          class="back-button"
          :disabled="submitting || sendingCode"
          @click="changeMode('password')"
        >
          <span aria-hidden="true">←</span> 返回登录
        </button>

        <div class="auth-title">
          <h2 id="auth-heading">
            {{ title }}
          </h2>
          <p>{{ subtitle }}</p>
        </div>

        <div v-if="account.sessionError" class="alert alert-warning" role="alert">
          <span>{{ account.sessionError }}</span>
          <button type="button" class="text-button" @click="account.initialize()">重新连接</button>
        </div>
        <div v-if="error" id="form-error" class="alert alert-error" role="alert">
          <span>{{ error }}</span
          ><small v-if="requestId">请求编号：{{ requestId }}</small>
        </div>
        <div v-if="notice" class="alert alert-success" role="status">
          {{ notice }}
        </div>

        <div v-if="isLogin" class="login-methods" aria-label="登录方式">
          <button
            type="button"
            :class="{ selected: mode === 'password' }"
            :aria-pressed="mode === 'password'"
            :disabled="submitting || sendingCode"
            @click="changeMode('password')"
          >
            密码登录
          </button>
          <button
            type="button"
            :class="{ selected: mode === 'otp' }"
            :aria-pressed="mode === 'otp'"
            :disabled="submitting || sendingCode"
            @click="changeMode('otp')"
          >
            邮箱验证码
          </button>
        </div>

        <form novalidate :aria-busy="submitting" @submit.prevent="submit">
          <div class="form-field">
            <label for="email">邮箱地址</label>
            <div class="input-shell" :class="{ invalid: fieldErrors.email }">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <rect
                  x="2.5"
                  y="4"
                  width="15"
                  height="12"
                  rx="2.5"
                  stroke="currentColor"
                  stroke-width="1.5"
                />
                <path
                  d="m3 5 7 5 7-5"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linejoin="round"
                />
              </svg>
              <input
                id="email"
                v-model="email"
                name="email"
                type="email"
                autocomplete="email"
                placeholder="输入你的邮箱地址"
                maxlength="254"
                :disabled="submitting || sendingCode"
                :aria-invalid="Boolean(fieldErrors.email)"
                :aria-describedby="fieldErrors.email ? 'email-error' : undefined"
              />
            </div>
            <p v-if="fieldErrors.email" id="email-error" class="field-error">
              {{ fieldErrors.email }}
            </p>
          </div>

          <div v-if="needsCode" class="form-field">
            <label for="code">邮箱验证码</label>
            <div class="code-input-row">
              <div class="input-shell" :class="{ invalid: fieldErrors.code }">
                <input
                  id="code"
                  v-model="code"
                  name="code"
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  placeholder="6 位验证码"
                  maxlength="6"
                  :disabled="submitting"
                  :aria-invalid="Boolean(fieldErrors.code)"
                  :aria-describedby="fieldErrors.code ? 'code-error' : 'code-hint'"
                />
              </div>
              <button
                type="button"
                class="code-button"
                :disabled="sendingCode || submitting || cooldown > 0"
                @click="sendCode"
              >
                {{ sendingCode ? '发送中…' : cooldown > 0 ? `${cooldown}s 后重发` : '获取验证码' }}
              </button>
            </div>
            <p v-if="fieldErrors.code" id="code-error" class="field-error">
              {{ fieldErrors.code }}
            </p>
            <p v-else id="code-hint" class="field-hint">请查收邮箱，验证码 10 分钟内有效。</p>
          </div>

          <div v-if="needsPassword" class="form-field">
            <div class="field-label-row">
              <label for="password">{{
                mode === 'reset' ? '新密码' : mode === 'register' ? '设置密码' : '登录密码'
              }}</label
              ><button
                v-if="mode === 'password'"
                type="button"
                class="text-button"
                :disabled="submitting"
                @click="changeMode('reset')"
              >
                忘记密码？
              </button>
            </div>
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
                :placeholder="mode === 'password' ? '输入登录密码' : '设置至少 8 位密码'"
                minlength="8"
                maxlength="128"
                :disabled="submitting"
                :aria-invalid="Boolean(fieldErrors.password)"
                :aria-describedby="fieldErrors.password ? 'password-error' : undefined"
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
          </div>

          <button
            class="primary-button submit-button"
            type="submit"
            :disabled="submitting || sendingCode"
          >
            <span v-if="submitting" class="spinner" aria-hidden="true" />{{
              submitting ? '正在处理…' : submitLabel
            }}<span v-if="!submitting" aria-hidden="true">→</span>
          </button>
        </form>

        <p class="account-switch">
          {{
            mode === 'register'
              ? '已经有账号？'
              : mode === 'reset'
                ? '想起密码了？'
                : '还没有账号？'
          }}<button
            type="button"
            class="text-button"
            :disabled="submitting || sendingCode"
            @click="changeMode(mode === 'register' || mode === 'reset' ? 'password' : 'register')"
          >
            {{ mode === 'register' || mode === 'reset' ? '返回登录' : '创建一个账号' }}
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
