/**
 * @pattern Visitor
 */
import pluginVue from 'eslint-plugin-vue'

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['**/*.{js,jsx,cjs,mjs,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { vue: pluginVue },
    rules: {
      'vue/no-unused-vars': 'warn',
      'vue/return-in-computed-property': 'warn',
      'vue/no-side-effects-in-computed-properties': 'warn',
    },
  },
  ...pluginVue.configs['flat/recommended'],
];
