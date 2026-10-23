<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { preference, setTheme, type ThemePreference } from '../lib/theme';
import { useWorkbenchStore } from '../stores/workbench';
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
const theme = ref(preference()),
  install = ref<InstallEvent>(),
  waiting = ref<ServiceWorker>(),
  updating = ref(false),
  notice = ref(''),
  board = useWorkbenchStore();
let registration: ServiceWorkerRegistration | undefined;
function installReady(event: Event) {
  event.preventDefault();
  install.value = event as InstallEvent;
}
function installed() {
  install.value = undefined;
  notice.value = '已安装，可从桌面打开工作台';
}
async function doInstall() {
  const event = install.value;
  if (!event) return;
  await event.prompt();
  await event.userChoice;
  install.value = undefined;
}
function changeTheme() {
  setTheme(theme.value as ThemePreference);
}
async function update() {
  if (!(await board.persistAll())) {
    notice.value = '本机保存未完成，请先重试或导出草稿再更新';
    return;
  }
  updating.value = true;
  waiting.value?.postMessage({ type: 'SKIP_WAITING' });
}
function controllerChanged() {
  if (updating.value) location.reload();
}
function watchRegistration(value: ServiceWorkerRegistration) {
  registration = value;
  waiting.value = value.waiting ?? undefined;
  value.addEventListener('updatefound', () => {
    const worker = value.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller)
        waiting.value = value.waiting ?? undefined;
    });
  });
}
function foreground() {
  if (registration && document.visibilityState === 'visible')
    void registration.update().catch(() => undefined);
}
onMounted(() => {
  window.addEventListener('beforeinstallprompt', installReady);
  window.addEventListener('appinstalled', installed);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    void navigator.serviceWorker.getRegistration().then((value) => {
      if (value) watchRegistration(value);
    });
    navigator.serviceWorker.ready.then(watchRegistration).catch(() => undefined);
    document.addEventListener('visibilitychange', foreground);
  }
});
onUnmounted(() => {
  window.removeEventListener('beforeinstallprompt', installReady);
  window.removeEventListener('appinstalled', installed);
  navigator.serviceWorker?.removeEventListener('controllerchange', controllerChanged);
  document.removeEventListener('visibilitychange', foreground);
});
</script>
<template>
  <div class="app-tools">
    <label
      >外观
      <select v-model="theme" aria-label="外观主题" @change="changeTheme">
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select></label
    ><button v-if="install" type="button" class="wb-button" @click="doInstall">安装工作台</button
    ><button v-if="waiting" type="button" class="wb-button" :disabled="updating" @click="update">
      {{ updating ? '正在更新…' : '新版本可用 · 保存并更新' }}</button
    ><span v-if="notice" role="status">{{ notice }}</span>
  </div>
</template>
