'use strict';

/**
 * tsMigrationHelper.js — TypeScript migration helper for frontend.
 *
 * Generates TypeScript type definitions from existing JavaScript patterns
 * and provides migration utilities.
 *
 * @module tsMigrationHelper
 */

const fs = require('fs');
const path = require('path');

// ── Type Definition Generator ────────────────────────────────────────────

/**
 * Generate tsconfig.json for frontend.
 * @returns {object} tsconfig object
 */
function generateTsconfig() {
  return {
    compilerOptions: {
      target: 'ES2020',
      useDefineForClassFields: true,
      module: 'ESNext',
      lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: 'preserve',
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
      paths: {
        '@/*': ['./src/*'],
      },
      types: ['vite/client', 'vitest/globals'],
    },
    include: [
      'src/**/*.ts',
      'src/**/*.tsx',
      'src/**/*.vue',
      'vite.config.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
    ],
  };
}

/**
 * Generate vite.config.ts from vite.config.js.
 * @returns {string} TypeScript config content
 */
function generateViteConfigTS() {
  return `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { resolveBackendTarget } from './backendDiscovery.mjs';

export default defineConfig({
  plugins: [
    vue(),
    Components({
      dts: true, // Enable TypeScript declarations
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
    }),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,mjs,ts}'],
    globals: true,
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia', 'axios'],
          'element-plus': ['element-plus'],
        },
      },
    },
  },
  server: {
    port: process.env.AI_FRONTEND_PORT || 8090,
    host: process.env.AI_FRONTEND_HOST || '127.0.0.1',
    proxy: {
      '/api': {
        target: resolveBackendTarget(),
        changeOrigin: true,
      },
      '/ws': {
        target: resolveBackendTarget(),
        ws: true,
      },
    },
  },
});
`;
}

/**
 * Generate type definitions for common patterns.
 * @returns {string} Type definition content
 */
function generateTypeDefinitions() {
  return `// Auto-generated type definitions for Khy OS frontend

// ── Vue 3 Global Types ──────────────────────────────────────────────────

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// ── API Types ───────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Gateway Types ───────────────────────────────────────────────────────

export interface GatewayAdapter {
  key: string;
  name: string;
  enabled: boolean;
  priority: number;
  status: 'healthy' | 'degraded' | 'unavailable';
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  supportsVision: boolean;
  supportsTools: boolean;
}

// ── Tool Types ──────────────────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category: string;
  risk: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  read_only: boolean;
  mutates_files: boolean;
  parallel_safe: boolean;
  cancellable: boolean;
}

export interface ToolResult {
  content: string | unknown;
  is_error: boolean;
  changed_files?: string[];
  diff?: string;
  metadata?: Record<string, unknown>;
  token_count?: number;
}

// ── Memory Types ────────────────────────────────────────────────────────

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
  score: number;
  recall_count: number;
}

export interface DreamInsight {
  id: string;
  content: string;
  phase: 'light' | 'deep' | 'rem';
  score: number;
  recall_count: number;
  type: string;
  lifecycle: string;
}

// ── Task Types ──────────────────────────────────────────────────────────

export type TaskState = 'pending' | 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskPriority = 0 | 1 | 2 | 3 | 4;

export interface TaskInfo {
  id: string;
  name: string;
  state: TaskState;
  priority: TaskPriority;
  dependencies: string[];
  result?: unknown;
  error?: string;
  duration: number;
}

// ── Permission Types ────────────────────────────────────────────────────

export type PermissionVerdict = 'approved' | 'denied' | 'timeout' | 'cancelled';

export interface PermissionRequest {
  tool_name: string;
  reason: string;
  priority?: number;
  timeout_ms?: number;
}

// ── Composable Return Types ─────────────────────────────────────────────

export interface UseGatewayReturn {
  adapters: GatewayAdapter[];
  selectedModel: string | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  sendMessage: (content: string) => Promise<void>;
  clearHistory: () => void;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  tool_calls?: ToolCallInfo[];
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: ToolResult;
}
`;
}

/**
 * Generate env.d.ts for Vite.
 * @returns {string} env.d.ts content
 */
function generateEnvDeclarations() {
  return `/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AI_API_BASE_URL: string;
  readonly VITE_AI_WS_URL: string;
  readonly VITE_APP_TITLE: string;
  readonly AI_FRONTEND_PORT: string;
  readonly AI_FRONTEND_HOST: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
`;
}

/**
 * Generate vitest.config.ts.
 * @returns {string} Vitest config content
 */
function generateVitestConfig() {
  return `import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/**/*.test.{js,ts}',
        'src/**/*.spec.{js,ts}',
        'src/**/__tests__/**',
      ],
    },
  },
});
`;
}

/**
 * Write all TypeScript configuration files.
 * @param {string} frontendPath - Path to frontend root
 */
function writeTsConfig(frontendPath) {
  const tsconfig = generateTsconfig(frontendPath);
  fs.writeFileSync(
    path.join(frontendPath, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2)
  );

  const typesDir = path.join(frontendPath, 'src', 'types');
  if (!fs.existsSync(typesDir)) {
    fs.mkdirSync(typesDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(typesDir, 'index.d.ts'),
    generateTypeDefinitions()
  );

  fs.writeFileSync(
    path.join(frontendPath, 'src', 'env.d.ts'),
    generateEnvDeclarations()
  );

  fs.writeFileSync(
    path.join(frontendPath, 'vite.config.ts'),
    generateViteConfigTS()
  );

  fs.writeFileSync(
    path.join(frontendPath, 'vitest.config.ts'),
    generateVitestConfig()
  );
}

/**
 * Generate package.json additions for TypeScript.
 * @returns {object} devDependencies to add
 */
function getPackageJsonAdditions() {
  return {
    devDependencies: {
      typescript: '^5.4.0',
      'vue-tsc': '^2.0.0',
      '@types/node': '^20.11.0',
      'vite-plugin-dts': '^3.7.0',
    },
    scripts: {
      'type-check': 'vue-tsc --noEmit',
      'type-check:watch': 'vue-tsc --noEmit --watch',
    },
  };
}

// ── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  generateTsconfig,
  generateViteConfigTS,
  generateTypeDefinitions,
  generateEnvDeclarations,
  generateVitestConfig,
  writeTsConfig,
  getPackageJsonAdditions,
};
