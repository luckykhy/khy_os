import { useState } from 'react'

interface ElicitationQuestion {
  id: string
  question: string
  options?: string[]
  allowCustom?: boolean
}

interface ElicitationPanelProps {
  questions: ElicitationQuestion[]
  onSubmit: (answers: Record<string, string>) => void
  onDismiss?: () => void
}

export function ElicitationPanel({ questions, onSubmit, onDismiss }: ElicitationPanelProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [customAnswer, setCustomAnswer] = useState('')
  const [expanded, setExpanded] = useState(true)

  const current = questions[currentIndex]
  const isLast = currentIndex === questions.length - 1

  const handleSelect = (questionId: string, answer: string) => {
    setAnswers(prev => ({ ...prev, [questionId]: answer }))
  }

  const handleSubmit = () => {
    if (current.allowCustom && customAnswer.trim()) {
      handleSelect(current.id, customAnswer.trim())
    }
    onSubmit(answers)
  }

  const handleNext = () => {
    if (isLast) {
      handleSubmit()
    } else {
      setCurrentIndex(i => i + 1)
      setCustomAnswer('')
    }
  }

  return (
    <div className="mx-4 my-3 rounded-xl border border-border bg-interaction-ask-surface overflow-hidden animate-slide-down">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <span className="text-sm">❓</span>
        <span className="text-sm font-medium text-interaction-ask-foreground">需要确认</span>
        <span className="text-xs text-foreground/30 ml-auto">
          {currentIndex + 1} / {questions.length}
        </span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="p-1 rounded text-foreground/40 hover:text-foreground text-xs"
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>

      {expanded && current && (
        <div className="p-4">
          {/* 问题 */}
          <div className="text-sm text-foreground mb-3">{current.question}</div>

          {/* 选项 */}
          {current.options && current.options.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {current.options.map((option, i) => (
                <button
                  key={i}
                  onClick={() => handleSelect(current.id, option)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all text-sm ${
                    answers[current.id] === option
                      ? 'border-brand bg-selected text-foreground'
                      : 'border-card-border bg-card hover:bg-surface-hover text-foreground/80'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          )}

          {/* 自定义回答 */}
          {current.allowCustom && (
            <div className="mb-3">
              <input
                value={customAnswer}
                onChange={e => setCustomAnswer(e.target.value)}
                placeholder="输入你的回答..."
                className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/30 focus:outline-none focus:border-input-border-focused"
              />
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {currentIndex > 0 && (
                <button
                  onClick={() => setCurrentIndex(i => i - 1)}
                  className="px-3 py-1.5 text-sm text-foreground/60 hover:text-foreground rounded-lg hover:bg-surface-hover"
                >
                  上一题
                </button>
              )}
              {!isLast && (
                <button
                  onClick={handleNext}
                  className="px-3 py-1.5 text-sm text-foreground/60 hover:text-foreground rounded-lg hover:bg-surface-hover"
                >
                  下一题
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {onDismiss && (
                <button
                  onClick={onDismiss}
                  className="px-3 py-1.5 text-sm text-foreground/40 hover:text-foreground rounded-lg hover:bg-surface-hover"
                >
                  忽略
                </button>
              )}
              <button
                onClick={handleSubmit}
                className="px-4 py-1.5 bg-interaction-ask-fill text-interaction-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                {isLast ? '提交' : '继续'}
              </button>
            </div>
          </div>

          {/* 键盘提示 */}
          <div className="mt-3 text-xs text-foreground/30">
            使用 Tab / 上下键选择，回车或空格选中
          </div>
        </div>
      )}
    </div>
  )
}
