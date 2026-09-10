import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './zh-CN.json'

i18n.use(initReactI18next).init({
  resources: { 'zh-CN': { translation: zhCN } },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
  saveMissing: true,
  missingKeyHandler: (lng, ns, key) => { if (import.meta.env.DEV) console.error('[i18n] MISSING KEY: ' + ns + ':' + key + ' (' + lng + ')') }
})

export default i18n
