import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  API,
  type AccountSummary,
  type AuthResponse,
  type HealthResponse,
  type MessageResponse,
} from '@workbench/contracts';
import { ApiClientError, errorMessage, request } from '../lib/api';
import { cachedProfile, metaGet, metaPut, GUEST } from '../lib/local-db';

export const useAccountStore = defineStore('account', () => {
  const session = ref<AuthResponse | null>(null);
  const summary = ref<AccountSummary | null>(null);
  const health = ref<HealthResponse | null>(null);
  const initializing = ref(true);
  const refreshing = ref(false);
  const sessionError = ref('');
  const summaryError = ref('');
  const healthError = ref('');

  async function loadHealth() {
    try {
      health.value = await request<HealthResponse>(API.health);
      healthError.value = '';
    } catch (error) {
      health.value = null;
      healthError.value = errorMessage(error);
    }
  }

  async function loadSummary() {
    if (!session.value || session.value.user.id === GUEST) return;
    try {
      summary.value = await request<AccountSummary>(API.accountSummary);
      summaryError.value = '';
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        session.value = null;
        summary.value = null;
        sessionError.value = '登录已失效，请重新登录。';
      } else {
        summaryError.value = errorMessage(error);
      }
    }
  }

  async function initialize() {
    initializing.value = true;
    if (await metaGet<boolean>('visitor-active').catch(() => false)) {
      session.value = {
        user: {
          id: GUEST,
          username: '访客 · 数据仅在本机',
          timezone: 'Asia/Shanghai',
          createdAt: new Date().toISOString(),
        },
        sessionExpiresAt: '',
      };
      initializing.value = false;
      return;
    }
    sessionError.value = '';
    const healthPromise = loadHealth();
    try {
      session.value = await request<AuthResponse>(API.me);
      await metaPut('last-profile', session.value);
      await loadSummary();
    } catch (error) {
      session.value = null;
      summary.value = null;
      if (!(error instanceof ApiClientError && error.status === 401)) {
        sessionError.value = errorMessage(error);
        if (error instanceof ApiClientError && error.status === 0)
          session.value = (await cachedProfile().catch(() => undefined)) ?? null;
      }
    } finally {
      await healthPromise;
      initializing.value = false;
    }
  }

  async function acceptSession(response: AuthResponse) {
    await metaPut('visitor-active', false);
    session.value = response;
    await metaPut('last-profile', response);
    sessionError.value = '';
    summary.value = null;
    await Promise.all([loadSummary(), loadHealth()]);
  }

  async function refresh() {
    refreshing.value = true;
    await Promise.all([loadSummary(), loadHealth()]);
    refreshing.value = false;
  }

  async function logout() {
    if (session.value?.user.id === GUEST) {
      session.value = null;
      await metaPut('visitor-active', false);
      return;
    }
    try {
      await request<MessageResponse>(API.logout, {});
    } catch (error) {
      if (!(error instanceof ApiClientError && error.status === 401)) throw error;
    }
    session.value = null;
    await metaPut('last-profile', null);
    summary.value = null;
    summaryError.value = '';
    sessionError.value = '';
  }

  return {
    async visit() {
      session.value = {
        user: {
          id: GUEST,
          username: '访客 · 数据仅在本机',
          timezone: 'Asia/Shanghai',
          createdAt: new Date().toISOString(),
        },
        sessionExpiresAt: '',
      };
      await metaPut('visitor-active', true);
    },
    session,
    summary,
    health,
    initializing,
    refreshing,
    sessionError,
    summaryError,
    healthError,
    initialize,
    acceptSession,
    refresh,
    logout,
  };
});
