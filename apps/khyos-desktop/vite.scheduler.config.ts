import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  build: {
    rollupOptions: { input: 'src/scheduler/index.ts' },
    outDir: 'out/scheduler',
    ssr: true
  },
  plugins: [externalizeDepsPlugin()]
})
