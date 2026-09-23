import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/main/index.ts'
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
        // Sandboxed Electron preloads must be CommonJS (real ZCode ships
        // .cjs preloads too). package.json type:module makes electron-vite
        // default to ESM, which fails with "Cannot use import statement
        // outside a module" — force CJS output (ZC-ALIGN-001 P0-6).
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer')
      },
      // pnpm can resolve react and react-dom to different copies, which
      // crashes the renderer with React error #527 — force a single copy.
      dedupe: ['react', 'react-dom']
    }
  }
})
