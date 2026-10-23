import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'workbench-offline-shell',
      generateBundle(_options, bundle) {
        const files = [
            '/',
            '/manifest.webmanifest',
            '/favicon.svg',
            '/icons/icon-192.png',
            '/icons/icon-512.png',
            '/icons/icon-maskable-512.png',
            ...Object.keys(bundle)
              .filter((name) => !name.endsWith('.map'))
              .map((name) => `/${name}`),
          ],
          version = JSON.stringify(files);
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: `const CACHE='workbench-shell-'+${JSON.stringify(version)};const FILES=${JSON.stringify(files)};
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)));});
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('workbench-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.open(CACHE).then(cache=>cache.match('/'))));}else if(FILES.includes(url.pathname)){event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(event.request))||fetch(event.request)));}});`,
        });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  preview: { port: 4173, strictPort: true },
});
