module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: ['eslint:recommended', 'plugin:vue/vue3-recommended', 'prettier'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['vue'],
  rules: {
    'vue/component-tags-order': ['warn', { order: ['template', 'script', 'style'] }],
    'vue/attributes-order': ['warn', { alphabetical: true }],
    'vue/multi-word-component-names': 'off',
    'vue/no-v-html': 'warn',
    'no-unused-vars': 'warn',
    'prefer-const': 'warn',
    'no-var': 'warn',
  },
};
