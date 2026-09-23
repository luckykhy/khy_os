// vite.config.js
import { defineConfig } from "file:///D:/Portable/khy-os/node_modules/.pnpm/vite@5.4.21_@types+node@24._7cda96948b52e9c484b19a47465df0b4/node_modules/vite/dist/node/index.js";
import vue from "file:///D:/Portable/khy-os/node_modules/.pnpm/@vitejs+plugin-vue@5.2.4_vi_9fdececb271913074b236afd3f41df40/node_modules/@vitejs/plugin-vue/dist/index.mjs";
import { VitePWA } from "file:///D:/Portable/khy-os/node_modules/.pnpm/vite-plugin-pwa@1.3.0_@type_83e7269fad16e9c333af9560ba0b25f5/node_modules/vite-plugin-pwa/dist/index.js";
import path from "path";
var __vite_injected_original_dirname = "D:\\Portable\\khy-os\\software\\khyquant\\frontend";
var backendPort = process.env.VITE_BACKEND_PORT || "3000";
var backendHost = process.env.VITE_BACKEND_HOST || "127.0.0.1";
var vite_config_default = defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: "prompt",
      includeAssets: [
        "favicon-32x32.png",
        "apple-touch-icon-180x180.png",
        "logo.png",
        "logo.svg",
        "offline.html"
      ],
      manifest: {
        name: "Khy OS",
        short_name: "KhyOS",
        description: "Khy OS AI operating system platform",
        theme_color: "#1f2d3d",
        background_color: "#f5f7fa",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "/pwa-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,jpg,jpeg,woff2,woff,wasm}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Static assets — cache-first, long-lived
            urlPattern: ({ request }) => ["style", "script", "worker", "font"].includes(request.destination),
            handler: "CacheFirst",
            options: {
              cacheName: "static-assets",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 }
            }
          },
          {
            // Images — cache-first with size cap
            urlPattern: ({ request }) => request.destination === "image",
            handler: "CacheFirst",
            options: {
              cacheName: "images",
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 }
            }
          },
          {
            // API requests — network only (stale trading data is dangerous)
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkOnly"
          }
        ]
      }
    })
  ],
  resolve: {
    alias: {
      "@": path.resolve(__vite_injected_original_dirname, "src")
    }
  },
  server: {
    port: 8080,
    host: "0.0.0.0",
    strictPort: false,
    // Auto-increment port if occupied
    cors: true,
    historyApiFallback: {
      index: "/index.html"
    },
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    proxy: {
      "/api": {
        target: `http://${backendHost}:${backendPort}`,
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on("error", (err, req, res) => {
            console.log("proxy error", err);
          });
          proxy.on("proxyReq", (proxyReq, req, res) => {
            console.log("Sending Request to the Target:", req.method, req.url);
          });
          proxy.on("proxyRes", (proxyRes, req, res) => {
            console.log("Received Response from the Target:", proxyRes.statusCode, req.url);
          });
        }
      },
      "/ws": {
        target: `ws://${backendHost}:${backendPort}`,
        ws: true,
        changeOrigin: true,
        secure: false
      }
    }
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
    minify: "terser",
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        main: path.resolve(__vite_injected_original_dirname, "index.html")
      },
      output: {
        manualChunks: {
          "vendor-vue": ["vue", "vue-router", "pinia"],
          "vendor-element": ["element-plus"],
          "vendor-charts": ["lightweight-charts"]
        }
      }
    }
  },
  base: "/",
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler"
      }
    }
  },
  optimizeDeps: {
    include: ["vue", "vue-router", "pinia", "element-plus", "axios"]
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJEOlxcXFxQb3J0YWJsZVxcXFxraHktb3NcXFxcc29mdHdhcmVcXFxca2h5cXVhbnRcXFxcZnJvbnRlbmRcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkQ6XFxcXFBvcnRhYmxlXFxcXGtoeS1vc1xcXFxzb2Z0d2FyZVxcXFxraHlxdWFudFxcXFxmcm9udGVuZFxcXFx2aXRlLmNvbmZpZy5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vRDovUG9ydGFibGUva2h5LW9zL3NvZnR3YXJlL2toeXF1YW50L2Zyb250ZW5kL3ZpdGUuY29uZmlnLmpzXCI7LyoqXG4gKiBAcGF0dGVybiBCdWlsZGVyXG4gKi9cbmltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gJ3ZpdGUnXG5pbXBvcnQgdnVlIGZyb20gJ0B2aXRlanMvcGx1Z2luLXZ1ZSdcbmltcG9ydCB7IFZpdGVQV0EgfSBmcm9tICd2aXRlLXBsdWdpbi1wd2EnXG5pbXBvcnQgcGF0aCBmcm9tICdwYXRoJ1xuXG5jb25zdCBiYWNrZW5kUG9ydCA9IHByb2Nlc3MuZW52LlZJVEVfQkFDS0VORF9QT1JUIHx8ICczMDAwJ1xuY29uc3QgYmFja2VuZEhvc3QgPSBwcm9jZXNzLmVudi5WSVRFX0JBQ0tFTkRfSE9TVCB8fCAnMTI3LjAuMC4xJ1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbXG4gICAgdnVlKCksXG4gICAgVml0ZVBXQSh7XG4gICAgICByZWdpc3RlclR5cGU6ICdwcm9tcHQnLFxuICAgICAgaW5jbHVkZUFzc2V0czogW1xuICAgICAgICAnZmF2aWNvbi0zMngzMi5wbmcnLFxuICAgICAgICAnYXBwbGUtdG91Y2gtaWNvbi0xODB4MTgwLnBuZycsXG4gICAgICAgICdsb2dvLnBuZycsXG4gICAgICAgICdsb2dvLnN2ZycsXG4gICAgICAgICdvZmZsaW5lLmh0bWwnLFxuICAgICAgXSxcbiAgICAgIG1hbmlmZXN0OiB7XG4gICAgICAgIG5hbWU6ICdLaHkgT1MnLFxuICAgICAgICBzaG9ydF9uYW1lOiAnS2h5T1MnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0toeSBPUyBBSSBvcGVyYXRpbmcgc3lzdGVtIHBsYXRmb3JtJyxcbiAgICAgICAgdGhlbWVfY29sb3I6ICcjMWYyZDNkJyxcbiAgICAgICAgYmFja2dyb3VuZF9jb2xvcjogJyNmNWY3ZmEnLFxuICAgICAgICBkaXNwbGF5OiAnc3RhbmRhbG9uZScsXG4gICAgICAgIHN0YXJ0X3VybDogJy8nLFxuICAgICAgICBzY29wZTogJy8nLFxuICAgICAgICBpY29uczogW1xuICAgICAgICAgIHsgc3JjOiAnL3B3YS0xOTJ4MTkyLnBuZycsIHNpemVzOiAnMTkyeDE5MicsIHR5cGU6ICdpbWFnZS9wbmcnIH0sXG4gICAgICAgICAgeyBzcmM6ICcvcHdhLTUxMng1MTIucG5nJywgc2l6ZXM6ICc1MTJ4NTEyJywgdHlwZTogJ2ltYWdlL3BuZycgfSxcbiAgICAgICAgICB7IHNyYzogJy9wd2EtbWFza2FibGUtNTEyeDUxMi5wbmcnLCBzaXplczogJzUxMng1MTInLCB0eXBlOiAnaW1hZ2UvcG5nJywgcHVycG9zZTogJ21hc2thYmxlJyB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICAgIHdvcmtib3g6IHtcbiAgICAgICAgZ2xvYlBhdHRlcm5zOiBbJyoqLyoue2pzLGNzcyxodG1sLHBuZyxzdmcsanBnLGpwZWcsd29mZjIsd29mZix3YXNtfSddLFxuICAgICAgICBuYXZpZ2F0ZUZhbGxiYWNrOiAnL2luZGV4Lmh0bWwnLFxuICAgICAgICBuYXZpZ2F0ZUZhbGxiYWNrRGVueWxpc3Q6IFsvXlxcL2FwaVxcLy9dLFxuICAgICAgICBydW50aW1lQ2FjaGluZzogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIC8vIFN0YXRpYyBhc3NldHMgXHUyMDE0IGNhY2hlLWZpcnN0LCBsb25nLWxpdmVkXG4gICAgICAgICAgICB1cmxQYXR0ZXJuOiAoeyByZXF1ZXN0IH0pID0+XG4gICAgICAgICAgICAgIFsnc3R5bGUnLCAnc2NyaXB0JywgJ3dvcmtlcicsICdmb250J10uaW5jbHVkZXMocmVxdWVzdC5kZXN0aW5hdGlvbiksXG4gICAgICAgICAgICBoYW5kbGVyOiAnQ2FjaGVGaXJzdCcsXG4gICAgICAgICAgICBvcHRpb25zOiB7XG4gICAgICAgICAgICAgIGNhY2hlTmFtZTogJ3N0YXRpYy1hc3NldHMnLFxuICAgICAgICAgICAgICBleHBpcmF0aW9uOiB7IG1heEVudHJpZXM6IDIwMCwgbWF4QWdlU2Vjb25kczogNjAgKiA2MCAqIDI0ICogMzAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICAvLyBJbWFnZXMgXHUyMDE0IGNhY2hlLWZpcnN0IHdpdGggc2l6ZSBjYXBcbiAgICAgICAgICAgIHVybFBhdHRlcm46ICh7IHJlcXVlc3QgfSkgPT4gcmVxdWVzdC5kZXN0aW5hdGlvbiA9PT0gJ2ltYWdlJyxcbiAgICAgICAgICAgIGhhbmRsZXI6ICdDYWNoZUZpcnN0JyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgY2FjaGVOYW1lOiAnaW1hZ2VzJyxcbiAgICAgICAgICAgICAgZXhwaXJhdGlvbjogeyBtYXhFbnRyaWVzOiAxMjAsIG1heEFnZVNlY29uZHM6IDYwICogNjAgKiAyNCAqIDMwIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgLy8gQVBJIHJlcXVlc3RzIFx1MjAxNCBuZXR3b3JrIG9ubHkgKHN0YWxlIHRyYWRpbmcgZGF0YSBpcyBkYW5nZXJvdXMpXG4gICAgICAgICAgICB1cmxQYXR0ZXJuOiAoeyB1cmwgfSkgPT4gdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvJyksXG4gICAgICAgICAgICBoYW5kbGVyOiAnTmV0d29ya09ubHknLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pXG4gIF0sXG4gIHJlc29sdmU6IHtcbiAgICBhbGlhczoge1xuICAgICAgJ0AnOiBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCAnc3JjJylcbiAgICB9XG4gIH0sXG4gIHNlcnZlcjoge1xuICAgIHBvcnQ6IDgwODAsXG4gICAgaG9zdDogJzAuMC4wLjAnLFxuICAgIHN0cmljdFBvcnQ6IGZhbHNlLCAvLyBBdXRvLWluY3JlbWVudCBwb3J0IGlmIG9jY3VwaWVkXG4gICAgY29yczogdHJ1ZSxcbiAgICBoaXN0b3J5QXBpRmFsbGJhY2s6IHtcbiAgICAgIGluZGV4OiAnL2luZGV4Lmh0bWwnXG4gICAgfSxcbiAgICBoZWFkZXJzOiB7XG4gICAgICAnQ2FjaGUtQ29udHJvbCc6ICduby1zdG9yZSwgbm8tY2FjaGUsIG11c3QtcmV2YWxpZGF0ZSwgcHJveHktcmV2YWxpZGF0ZScsXG4gICAgICAnUHJhZ21hJzogJ25vLWNhY2hlJyxcbiAgICAgICdFeHBpcmVzJzogJzAnXG4gICAgfSxcbiAgICBwcm94eToge1xuICAgICAgJy9hcGknOiB7XG4gICAgICAgIHRhcmdldDogYGh0dHA6Ly8ke2JhY2tlbmRIb3N0fToke2JhY2tlbmRQb3J0fWAsXG4gICAgICAgIGNoYW5nZU9yaWdpbjogdHJ1ZSxcbiAgICAgICAgc2VjdXJlOiBmYWxzZSxcbiAgICAgICAgY29uZmlndXJlOiAocHJveHksIG9wdGlvbnMpID0+IHtcbiAgICAgICAgICBwcm94eS5vbignZXJyb3InLCAoZXJyLCByZXEsIHJlcykgPT4ge1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ3Byb3h5IGVycm9yJywgZXJyKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBwcm94eS5vbigncHJveHlSZXEnLCAocHJveHlSZXEsIHJlcSwgcmVzKSA9PiB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZygnU2VuZGluZyBSZXF1ZXN0IHRvIHRoZSBUYXJnZXQ6JywgcmVxLm1ldGhvZCwgcmVxLnVybCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcHJveHkub24oJ3Byb3h5UmVzJywgKHByb3h5UmVzLCByZXEsIHJlcykgPT4ge1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ1JlY2VpdmVkIFJlc3BvbnNlIGZyb20gdGhlIFRhcmdldDonLCBwcm94eVJlcy5zdGF0dXNDb2RlLCByZXEudXJsKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgICcvd3MnOiB7XG4gICAgICAgIHRhcmdldDogYHdzOi8vJHtiYWNrZW5kSG9zdH06JHtiYWNrZW5kUG9ydH1gLFxuICAgICAgICB3czogdHJ1ZSxcbiAgICAgICAgY2hhbmdlT3JpZ2luOiB0cnVlLFxuICAgICAgICBzZWN1cmU6IGZhbHNlXG4gICAgICB9XG4gICAgfVxuICB9LFxuICBidWlsZDoge1xuICAgIG91dERpcjogJ2Rpc3QnLFxuICAgIGFzc2V0c0RpcjogJ2Fzc2V0cycsXG4gICAgc291cmNlbWFwOiBmYWxzZSxcbiAgICBtaW5pZnk6ICd0ZXJzZXInLFxuICAgIGNodW5rU2l6ZVdhcm5pbmdMaW1pdDogNjAwLFxuICAgIHJvbGx1cE9wdGlvbnM6IHtcbiAgICAgIGlucHV0OiB7XG4gICAgICAgIG1haW46IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICdpbmRleC5odG1sJylcbiAgICAgIH0sXG4gICAgICBvdXRwdXQ6IHtcbiAgICAgICAgbWFudWFsQ2h1bmtzOiB7XG4gICAgICAgICAgJ3ZlbmRvci12dWUnOiBbJ3Z1ZScsICd2dWUtcm91dGVyJywgJ3BpbmlhJ10sXG4gICAgICAgICAgJ3ZlbmRvci1lbGVtZW50JzogWydlbGVtZW50LXBsdXMnXSxcbiAgICAgICAgICAndmVuZG9yLWNoYXJ0cyc6IFsnbGlnaHR3ZWlnaHQtY2hhcnRzJ11cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSxcbiAgYmFzZTogJy8nLFxuICBjc3M6IHtcbiAgICBwcmVwcm9jZXNzb3JPcHRpb25zOiB7XG4gICAgICBzY3NzOiB7XG4gICAgICAgIGFwaTogJ21vZGVybi1jb21waWxlcidcbiAgICAgIH1cbiAgICB9XG4gIH0sXG4gIG9wdGltaXplRGVwczoge1xuICAgIGluY2x1ZGU6IFsndnVlJywgJ3Z1ZS1yb3V0ZXInLCAncGluaWEnLCAnZWxlbWVudC1wbHVzJywgJ2F4aW9zJ11cbiAgfVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFHQSxTQUFTLG9CQUFvQjtBQUM3QixPQUFPLFNBQVM7QUFDaEIsU0FBUyxlQUFlO0FBQ3hCLE9BQU8sVUFBVTtBQU5qQixJQUFNLG1DQUFtQztBQVF6QyxJQUFNLGNBQWMsUUFBUSxJQUFJLHFCQUFxQjtBQUNyRCxJQUFNLGNBQWMsUUFBUSxJQUFJLHFCQUFxQjtBQUVyRCxJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTO0FBQUEsSUFDUCxJQUFJO0FBQUEsSUFDSixRQUFRO0FBQUEsTUFDTixjQUFjO0FBQUEsTUFDZCxlQUFlO0FBQUEsUUFDYjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsTUFDQSxVQUFVO0FBQUEsUUFDUixNQUFNO0FBQUEsUUFDTixZQUFZO0FBQUEsUUFDWixhQUFhO0FBQUEsUUFDYixhQUFhO0FBQUEsUUFDYixrQkFBa0I7QUFBQSxRQUNsQixTQUFTO0FBQUEsUUFDVCxXQUFXO0FBQUEsUUFDWCxPQUFPO0FBQUEsUUFDUCxPQUFPO0FBQUEsVUFDTCxFQUFFLEtBQUssb0JBQW9CLE9BQU8sV0FBVyxNQUFNLFlBQVk7QUFBQSxVQUMvRCxFQUFFLEtBQUssb0JBQW9CLE9BQU8sV0FBVyxNQUFNLFlBQVk7QUFBQSxVQUMvRCxFQUFFLEtBQUssNkJBQTZCLE9BQU8sV0FBVyxNQUFNLGFBQWEsU0FBUyxXQUFXO0FBQUEsUUFDL0Y7QUFBQSxN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
