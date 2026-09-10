import { useState, useEffect, useCallback } from 'react'
import { AppLayout } from './components/layout/AppLayout'
import { MessageList } from './components/message/MessageBubble'
import { Composer } from './components/composer/Composer'
import { ModeSelector } from './components/composer/ModeSelector'
import { GoalBanner } from './components/message/GoalBanner'
import { AppHeader } from './components/message/AppHeader'
import { CommandCenter } from './components/message/CommandCenter'
import { ContextUsagePanel } from './components/message/ContextUsage'
import { DiffSummary } from './components/message/DiffViewer'
import { ToastContainer } from './components/ui/ToastContainer'
import { ToolExecutionPanel } from './components/message/ToolExecutionPanel'
import { LoginPage, WelcomePage } from './components/auth/LoginPage'
import { KeyManagerPage } from './components/keyManager/KeyManagerPage'

type AppView = 'login' | 'welcome' | 'main'

// DESIGN-ARCH-091 §5.1 入口③: the standalone key-manager window loads
// #/key-manager and renders the full-screen manager (no login gate — it is a
// local tool, spec §12-Q4).
function isKeyManagerHash(): boolean {
  return window.location.hash.replace(/^#\/?/, '') === 'key-manager'
}

export default function App() {
  const [view, setView] = useState<AppView>('login')
  const [provider, setProvider] = useState('glm')
  const [mode, setMode] = useState('default')
  const [goal, setGoal] = useState<string | undefined>()
  const [commandCenterOpen, setCommandCenterOpen] = useState(false)
  const [thoughtLevel, setThoughtLevel] = useState('max')
  const [showContextUsage, setShowContextUsage] = useState(true)

  // 独立密钥管理窗口（#/key-manager）
  const [keyManager, setKeyManager] = useState(isKeyManagerHash)
  useEffect(() => {
    const onHash = () => setKeyManager(isKeyManagerHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 全局快捷键（主界面）
  useEffect(() => {
    if (keyManager) return
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault()
        setCommandCenterOpen((v) => !v)
      }
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault()
        const levels = ['off', 'low', 'high', 'max']
        const currentIndex = levels.indexOf(thoughtLevel)
        setThoughtLevel(levels[(currentIndex + 1) % levels.length])
      }
      if (e.key === 'Escape') {
        setCommandCenterOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [thoughtLevel, keyManager])

  const handleReload = useCallback(() => {
    console.log('[app] reload session')
  }, [])

  if (keyManager) {
    return (
      <>
        <KeyManagerPage standalone />
        <ToastContainer />
      </>
    )
  }

  // 登录页面
  if (view === 'login') {
    return <LoginPage onLogin={() => setView('welcome')} />
  }

  // 欢迎页面
  if (view === 'welcome') {
    return <WelcomePage onContinue={() => setView('main')} />
  }

  // 主界面
  return (
    <AppLayout>
      <div className="flex flex-col h-full">
        {/* 会话头部 */}
        <AppHeader
          sessionId="sess_74b99e12-4b39-45a0-ac8f-539e2a5e1b8a"
          workspacePath="D:\Portable\khy-os"
          modelName="GLM-5.3Max"
          onReload={handleReload}
        />

        {/* Goal 横幅 */}
        <GoalBanner
          goal={goal}
          status={goal ? 'running' : 'idle'}
          onSetGoal={setGoal}
          onCancel={() => setGoal(undefined)}
        />

        {/* 正在执行的工具 */}
        <ToolExecutionPanel />

        {/* 消息列表 */}
        <MessageList />

        {/* 上下文用量面板 */}
        {showContextUsage && <ContextUsagePanel />}

        {/* Diff 摘要 */}
          <DiffSummary
          files={[
            { path: 'src/sort/quicksort.ts', status: 'modified', additions: 8, deletions: 2 },
            { path: 'src/sort/quicksort.test.ts', status: 'added', additions: 45, deletions: 0 },
          ]}
        />

        {/* 底部区域 */}
        <div className="border-t border-border bg-panel">
          {/* 模式选择器 + 思考强度 */}
          <div className="flex items-center gap-2 px-4 pt-2">
            <ModeSelector
              provider={provider}
              mode={mode}
              onProviderChange={setProvider}
              onModeChange={setMode}
            />
            <button
              onClick={() => {
                const levels = ['off', 'low', 'high', 'max']
                const currentIndex = levels.indexOf(thoughtLevel)
                setThoughtLevel(levels[(currentIndex + 1) % levels.length])
              }}
              className="px-3 py-1.5 rounded-lg bg-card border border-card-border hover:bg-surface-hover transition-colors text-xs font-medium text-foreground/70"
              title="思考强度 (Ctrl+T)"
            >
              💭 {thoughtLevel === 'off' ? '关闭' : thoughtLevel === 'low' ? '低' : thoughtLevel === 'high' ? '高' : '最高'}
            </button>
            <div className="flex-1" />
            <span className="text-xs text-foreground/30">
              Shift+Tab 切换模式 · Ctrl+T 思考强度 · Ctrl+K 命令中心
            </span>
          </div>

          {/* 输入框 */}
          <Composer />
        </div>
      </div>

      {/* 命令中心 */}
      <CommandCenter
        visible={commandCenterOpen}
        onClose={() => setCommandCenterOpen(false)}
      />

      {/* Toast 通知 */}
      <ToastContainer />
    </AppLayout>
  )
}
