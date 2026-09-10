interface EmptyStateProps {
  icon?: string
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}

export function EmptyState({ icon = '📭', title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 animate-fade-in">
      <span className="text-4xl mb-4">{icon}</span>
      <h3 className="text-base font-medium text-foreground mb-2">{title}</h3>
      {description && (
        <p className="text-sm text-foreground/50 max-w-xs mb-4">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

export function ChatEmptyState({ onNewTask }: { onNewTask: () => void }) {
  const hour = new Date().getHours()
  let greeting = '下午好呀，接下来交给我吧'
  if (hour < 6) greeting = '夜深啦，别忘了照顾好自己呀'
  else if (hour < 11) greeting = '早上好呀，新的一天开始啦'
  else if (hour < 13) greeting = '中午好呀，要不要先休息一下'
  else if (hour < 18) greeting = '下午好呀，接下来交给我吧'
  else greeting = '晚上好呀，今天辛苦啦'

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 animate-fade-in">
      <div className="w-16 h-16 rounded-2xl bg-brand/10 flex items-center justify-center text-3xl mb-5">
        🤖
      </div>
      <h2 className="text-xl font-semibold text-foreground mb-2">{greeting}</h2>
      <p className="text-sm text-foreground/50 max-w-sm mb-6">
        有什么想让我帮忙的吗？我可以帮你编写代码、调试问题、重构项目。
      </p>
      <div className="grid grid-cols-2 gap-2 w-full max-w-md">
        {[
          { icon: '💻', label: '编写代码', desc: '实现新功能' },
          { icon: '🐛', label: '调试问题', desc: '定位并修复 bug' },
          { icon: '📝', label: '重构代码', desc: '优化代码结构' },
          { icon: '📖', label: '生成文档', desc: '编写项目文档' },
        ].map(item => (
          <button
            key={item.label}
            onClick={onNewTask}
            className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-surface-hover transition-colors text-left"
          >
            <span className="text-xl">{item.icon}</span>
            <div>
              <div className="text-sm font-medium text-foreground">{item.label}</div>
              <div className="text-xs text-foreground/40">{item.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
