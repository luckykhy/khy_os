import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  build: {
    rollupOptions: { input: 'src/host/index.ts' },
    outDir: 'out/host',
    ssr: true
  },
  plugins: [externalizeDepsPlugin()]
})
