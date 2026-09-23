/**
 * @pattern Builder
 */
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import path from 'path'
import { resolveBackendTarget, resolveWebBackendTarget } from './backendDiscovery.mjs'

// Two backends, two jobs:
//   • AI daemon (services/backend/start-daemon.js → aiManagementServer): serves
//     only the daemon-native namespaces — workflow canvas, marketplace, plugins,
//     user-gateway, mesh, gui-eval, wx, /api/daemon.
//   • Web backend (services/backend/server.js): serves everything else — auth,
//     api-keys, the user-scoped ai-gateway/payments route, proxy-subscriptions,
//     commands, config-sync, and the /ws/cross-platform WebSocket.
// Pointing ALL of /api at one of them is what produced the console errors:
// against the daemon → api-keys 404 + payments 403 + WS handshake failures;
// against the web backend → workflow/marketplace 404. So the proxy splits by
// path: daemon namespaces first, everything else to the web backend.
const backendTarget = resolveBackendTarget()
const webBackendTarget = await resolveWebBackendTarget()

// Daemon-only namespaces, in match-priority order (must precede the '/api'
// catch-all below — Vite applies proxy rules in registration order).
const DAEMON_ONLY_NAMESPACES = [
  '/api/workflow',
  '/api/marketplace',
  '/api/plugins',
  '/api/user-gateway',
  '/api/mesh',
  '/api/gui-eval',
  '/api/web-frontend-eval',
  '/gui-eval-screenshots',
  '/api/wx',
  '/api/daemon',
]

export default defineConfig({
  plugins: [
    vue(),
    // On-demand Element Plus: scan each template at build time and import only
    // the <el-*> components (and the v-loading directive) actually used, with
    // their css. Replaces the former full `app.use(ElementPlus)` + global css.
    Components({
      dts: false,
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
    }),
  ],
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.cjs'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    // Vitest config — runs alongside the existing node:test suite in test/.
    // Use `npx vitest run` for CI, `npx vitest` for watch mode.
    environment: 'node',
    include: ['src/**/*.test.{js,mjs}'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
  build: {
    // Raise chunk size warning: individual lazy-loaded views (AgentDashboard,
    // WorkflowEditor) legitimately exceed the default 500 kB.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Split the framework layer into stable chunks so they hit long-term
        // browser cache: app code changes rarely invalidate vendor/element-plus.
        // NOTE: public/vendor/khyos-muya.* is a static asset copied as-is; it
        // never goes through Rollup and must not be listed here.
        manualChunks: {
          // Core framework layer (framework layer long-term caching).
          vendor: ['vue', 'vue-router', 'pinia', 'axios'],
          // UI library split separately: large and versioned independently.
          'element-plus': ['element-plus'],
          // NOTE: object-form manualChunks resolves every listed id as an entry
          // module, so listing a package that is not installed fails the whole
          // build ("Could not resolve entry module"). The former 'charting'
          // (lightweight-charts) and 'markdown' (marked, highlight.js,
          // dompurify) entries did exactly that — none of the four is a
          // dependency or imported anywhere; the markdown libs ship as static
          // public/vendor assets copied by the prebuild step (see above), which
          // is precisely why they must not be listed here. Re-add a chunk only
          // together with a real dependency + import.
        },
      },
    },
  },
  server: {
    port: parseInt(process.env.AI_FRONTEND_PORT) || 8090,
    host: process.env.AI_FRONTEND_HOST || '127.0.0.1',
    proxy: {
      // Daemon-native namespaces → AI daemon.
      ...Object.fromEntries(
        DAEMON_ONLY_NAMESPACES.map((ns) => [ns, { target: backendTarget, changeOrigin: true }])
      ),
      // Everything else → web backend.
      '/api': {
        target: webBackendTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: webBackendTarget,
        ws: true,
      },
    },
  },
})
