import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { store } from './state/store'
import App from './App'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import './i18n'
import './theme/globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      {/* 顶层兜底：ErrorBoundary 早已实现（连文案都写着「不会直接白屏」），
          却从没被任何地方挂载 —— 于是任何渲染期异常都会把整棵 React 树卸载成
          纯白屏，用户连错误信息都看不到。「自动化」页空白就是这么暴露出来的。
          必须挂在 App **外面**，才能兜住 App 自身的渲染错误。 */}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </Provider>
  </StrictMode>
)
