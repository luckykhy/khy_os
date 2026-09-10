import { useState } from 'react'

interface LoginPageProps {
  onLogin: () => void
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码')
      return
    }
    setLoading(true)
    setError('')
    // 模拟登录
    await new Promise(r => setTimeout(r, 1500))
    setLoading(false)
    onLogin()
  }

  return (
    <div className="h-screen flex bg-background">
      {/* 左侧品牌区 */}
      <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-br from-brand/5 to-background p-12">
        <div className="max-w-md text-center">
          <div className="w-20 h-20 rounded-3xl bg-brand/10 flex items-center justify-center text-5xl mx-auto mb-6">
            🤖
          </div>
          <h1 className="text-3xl font-bold text-foreground mb-3">Welcome to KhyOS</h1>
          <p className="text-base text-foreground/60 leading-relaxed">
            KhyOS 桌面端 — 围绕 AI 深度调优的 Agentic Development Environment
          </p>
          <div className="mt-8 grid grid-cols-2 gap-3 text-left">
            {[
              { icon: '💻', label: '智能编码', desc: 'AI 辅助编写代码' },
              { icon: '🔧', label: '自动调试', desc: '定位并修复 bug' },
              { icon: '📝', label: '文档生成', desc: '自动生成项目文档' },
              { icon: '🔄', label: '重构优化', desc: '优化代码结构' },
            ].map(item => (
              <div key={item.label} className="p-3 rounded-xl bg-card border border-card-border">
                <span className="text-xl">{item.icon}</span>
                <div className="text-sm font-medium text-foreground mt-1">{item.label}</div>
                <div className="text-xs text-foreground/40">{item.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 右侧登录区 */}
      <div className="w-[420px] flex flex-col items-center justify-center p-12 border-l border-border bg-panel">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-semibold text-foreground mb-1">登录</h2>
          <p className="text-sm text-foreground/50 mb-8">登录以开始你的 AI 编程之旅</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground/70 mb-2">用户名</label>
              <input
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="请输入用户名"
                className="w-full bg-input border border-input-border rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-foreground/30 focus:outline-none focus:border-input-border-focused transition-colors"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground/70 mb-2">密码</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="请输入密码"
                className="w-full bg-input border border-input-border rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-foreground/30 focus:outline-none focus:border-input-border-focused transition-colors"
              />
            </div>

            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-xl text-sm text-destructive">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-primary text-primary-foreground rounded-xl text-sm font-semibold disabled:opacity-50 hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  <span>登录中...</span>
                </>
              ) : (
                <span>登录</span>
              )}
            </button>
          </form>

          <div className="mt-6 text-center">
            <span className="text-xs text-foreground/40">还没有账号？</span>
            <button className="text-xs text-brand hover:underline ml-1">注册新账号</button>
          </div>

          <div className="mt-8 pt-6 border-t border-border">
            <button
              onClick={onLogin}
              className="w-full py-2.5 text-sm text-foreground/60 hover:text-foreground border border-card-border rounded-xl hover:bg-surface-hover transition-colors"
            >
              跳过登录（本地模式）
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function WelcomePage({ onContinue }: { onContinue: () => void }) {
  const hour = new Date().getHours()
  let greeting = '下午好呀，接下来交给我吧'
  if (hour < 6) greeting = '夜深啦，别忘了照顾好自己呀'
  else if (hour < 11) greeting = '早上好呀，新的一天开始啦'
  else if (hour < 13) greeting = '中午好呀，要不要先休息一下'
  else if (hour < 18) greeting = '下午好呀，接下来交给我吧'
  else greeting = '晚上好呀，今天辛苦啦'

  return (
    <div className="h-full flex flex-col items-center justify-center bg-background p-8">
      <div className="max-w-lg text-center animate-fade-in">
        <div className="w-16 h-16 rounded-2xl bg-brand/10 flex items-center justify-center text-3xl mx-auto mb-6">
          🤖
        </div>
        <h1 className="text-2xl font-bold text-foreground mb-2">{greeting}</h1>
        <p className="text-base text-foreground/50 mb-8">
          有什么想让我帮忙的吗？我可以帮你编写代码、调试问题、重构项目。
        </p>

        <div className="grid grid-cols-2 gap-3 mb-8">
          {[
            { icon: '💻', label: '编写代码', desc: '实现新功能', prompt: '帮我写一个排序算法' },
            { icon: '🐛', label: '调试问题', desc: '定位并修复 bug', prompt: '帮我调试这段代码' },
            { icon: '📝', label: '重构代码', desc: '优化代码结构', prompt: '帮我重构这个模块' },
            { icon: '📖', label: '生成文档', desc: '编写项目文档', prompt: '帮我生成 API 文档' },
          ].map(item => (
            <button
              key={item.label}
              onClick={onContinue}
              className="flex items-center gap-3 p-4 rounded-xl border border-card-border bg-card hover:bg-surface-hover transition-colors text-left"
            >
              <span className="text-2xl">{item.icon}</span>
              <div>
                <div className="text-sm font-medium text-foreground">{item.label}</div>
                <div className="text-xs text-foreground/40">{item.desc}</div>
              </div>
            </button>
          ))}
        </div>

        <div className="relative">
          <input
            placeholder="描述你想做的事情..."
            className="w-full bg-input border border-input-border rounded-xl px-4 py-3.5 text-sm text-foreground placeholder:text-foreground/30 focus:outline-none focus:border-input-border-focused transition-colors"
          />
          <button
            onClick={onContinue}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 8h10M8 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
