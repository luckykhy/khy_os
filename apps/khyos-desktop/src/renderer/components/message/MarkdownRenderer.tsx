import { useState } from 'react'

interface MarkdownRendererProps {
  content: string
  isStreaming?: boolean
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-card-border">
      {/* 代码块头部 */}
      <div className="flex items-center justify-between px-4 py-2 bg-card border-b border-card-border">
        <span className="text-xs font-medium text-foreground/60">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="px-2.5 py-1 rounded-md text-xs text-foreground/50 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5"
        >
          {copied ? (
            <>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>已复制</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <rect x="3.5" y="3.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <path d="M5 2.5H8a1.5 1.5 0 011.5 1.5V7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      {/* 代码内容 */}
      <div className="bg-terminal-bg p-4 overflow-x-auto">
        <pre className="text-sm font-mono text-terminal-fg leading-relaxed whitespace-pre">
          <code>{highlightCode(code, language)}</code>
        </pre>
      </div>
    </div>
  )
}

function highlightCode(code: string, language: string): React.ReactNode {
  // 简化的语法高亮 — 实际项目中应使用 shiki
  if (language === 'typescript' || language === 'tsx' || language === 'javascript' || language === 'jsx') {
    return highlightTS(code)
  }
  if (language === 'python' || language === 'py') {
    return highlightPython(code)
  }
  if (language === 'bash' || language === 'shell' || language === 'sh') {
    return highlightBash(code)
  }
  return code
}

function highlightTS(code: string): React.ReactNode {
  const keywords = ['function', 'const', 'let', 'var', 'if', 'else', 'return', 'import', 'export', 'from', 'class', 'interface', 'type', 'extends', 'implements', 'new', 'async', 'await', 'try', 'catch', 'throw', 'for', 'while', 'switch', 'case', 'break', 'continue', 'default', 'typeof', 'instanceof', 'in', 'of']
  const types = ['number', 'string', 'boolean', 'any', 'void', 'null', 'undefined', 'never', 'unknown', 'object', 'Array', 'Record', 'Promise']

  const lines = code.split('\n')
  return lines.map((line, i) => {
    const parts: React.ReactNode[] = []
    let remaining = line
    let key = 0

    // 处理注释
    const commentIndex = remaining.indexOf('//')
    if (commentIndex >= 0) {
      const before = remaining.slice(0, commentIndex)
      const comment = remaining.slice(commentIndex)
      parts.push(<span key={key++}>{highlightTokens(before, keywords, types)}</span>)
      parts.push(<span key={key++} className="text-foreground/40 italic">{comment}</span>)
    } else {
      parts.push(highlightTokens(remaining, keywords, types))
    }

    return <div key={i}>{parts}</div>
  })
}

function highlightTokens(text: string, keywords: string[], types: string[]): React.ReactNode {
  const parts: React.ReactNode[] = []
  const regex = /(\s+)|("[^"]*"|'[^']*'|`[^`]*`)|(\b\d+\b)|(\b(?:function|const|let|var|if|else|return|import|export|from|class|interface|type|extends|implements|new|async|await|try|catch|throw|for|while|switch|case|break|continue|default|typeof|instanceof|in|of)\b)|(\b(?:number|string|boolean|any|void|null|undefined|never|unknown|object|Array|Record|Promise)\b)|([^\s"'`]+)/g

  let match
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    const [full, space, string, number, keyword, type, other] = match
    if (space) {
      parts.push(<span key={key++}>{space}</span>)
    } else if (string) {
      parts.push(<span key={key++} className="text-green-400">{string}</span>)
    } else if (number) {
      parts.push(<span key={key++} className="text-yellow-400">{number}</span>)
    } else if (keyword) {
      parts.push(<span key={key++} className="text-fuchsia-400 font-medium">{keyword}</span>)
    } else if (type) {
      parts.push(<span key={key++} className="text-cyan-400">{type}</span>)
    } else if (other) {
      parts.push(<span key={key++}>{other}</span>)
    }
  }
  return <>{parts}</>
}

function highlightPython(code: string): React.ReactNode {
  const keywords = ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return', 'import', 'from', 'as', 'try', 'except', 'finally', 'with', 'async', 'await', 'lambda', 'yield', 'raise', 'pass', 'break', 'continue', 'in', 'is', 'not', 'and', 'or', 'True', 'False', 'None', 'self']

  const lines = code.split('\n')
  return lines.map((line, i) => {
    const parts: React.ReactNode[] = []
    let key = 0

    const commentIndex = line.indexOf('#')
    if (commentIndex >= 0) {
      const before = line.slice(0, commentIndex)
      const comment = line.slice(commentIndex)
      parts.push(<span key={key++}>{highlightPyTokens(before, keywords)}</span>)
      parts.push(<span key={key++} className="text-foreground/40 italic">{comment}</span>)
    } else {
      parts.push(highlightPyTokens(line, keywords))
    }

    return <div key={i}>{parts}</div>
  })
}

function highlightPyTokens(text: string, keywords: string[]): React.ReactNode {
  const parts: React.ReactNode[] = []
  const regex = /(\s+)|("[^"]*"|'[^']*')|(\b\d+\b)|(\b(?:def|class|if|elif|else|for|while|return|import|from|as|try|except|finally|with|async|await|lambda|yield|raise|pass|break|continue|in|is|not|and|or|True|False|None|self)\b)|([^\s"'`]+)/g

  let match
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    const [full, space, string, number, keyword, other] = match
    if (space) {
      parts.push(<span key={key++}>{space}</span>)
    } else if (string) {
      parts.push(<span key={key++} className="text-green-400">{string}</span>)
    } else if (number) {
      parts.push(<span key={key++} className="text-yellow-400">{number}</span>)
    } else if (keyword) {
      parts.push(<span key={key++} className="text-fuchsia-400 font-medium">{keyword}</span>)
    } else if (other) {
      parts.push(<span key={key++}>{other}</span>)
    }
  }
  return <>{parts}</>
}

function highlightBash(code: string): React.ReactNode {
  const lines = code.split('\n')
  return lines.map((line, i) => {
    if (line.startsWith('$')) {
      return <div key={i}><span className="text-success">$</span>{line.slice(1)}</div>
    }
    if (line.startsWith('#')) {
      return <div key={i} className="text-foreground/40 italic">{line}</div>
    }
    return <div key={i}>{line}</div>
  })
}

function InlineCode({ children }: { children: string }) {
  return (
    <code className="px-1.5 py-0.5 rounded-md bg-surface text-sm font-mono text-brand bg-brand/10">
      {children}
    </code>
  )
}

export function MarkdownRenderer({ content, isStreaming }: MarkdownRendererProps) {
  const elements: React.ReactNode[] = []
  const lines = content.split('\n')
  let key = 0
  let inCodeBlock = false
  let codeBlockContent = ''
  let codeBlockLang = ''
  let inlineBuffer: string[] = []

  const flushInline = () => {
    if (inlineBuffer.length > 0) {
      elements.push(<p key={key++} className="leading-relaxed mb-2">{inlineBuffer.join(' ')}</p>)
      inlineBuffer = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 代码块开始/结束
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        flushInline()
        inCodeBlock = true
        codeBlockLang = line.slice(3).trim()
        codeBlockContent = ''
      } else {
        inCodeBlock = false
        elements.push(<CodeBlock key={key++} code={codeBlockContent.trim()} language={codeBlockLang} />)
      }
      continue
    }

    if (inCodeBlock) {
      codeBlockContent += line + '\n'
      continue
    }

    // 标题
    if (line.startsWith('### ')) {
      flushInline()
      elements.push(<h3 key={key++} className="text-base font-semibold text-foreground mt-4 mb-2">{line.slice(4)}</h3>)
      continue
    }
    if (line.startsWith('## ')) {
      flushInline()
      elements.push(<h2 key={key++} className="text-lg font-semibold text-foreground mt-4 mb-2">{line.slice(3)}</h2>)
      continue
    }
    if (line.startsWith('# ')) {
      flushInline()
      elements.push(<h1 key={key++} className="text-xl font-bold text-foreground mt-4 mb-2">{line.slice(2)}</h1>)
      continue
    }

    // 列表
    if (line.startsWith('- ') || line.startsWith('* ')) {
      flushInline()
      elements.push(
        <div key={key++} className="flex items-start gap-2 ml-2 mb-1">
          <span className="text-brand mt-1.5 w-1.5 h-1.5 rounded-full bg-current flex-shrink-0" />
          <span className="leading-relaxed">{renderInline(line.slice(2))}</span>
        </div>
      )
      continue
    }

    // 数字列表
    if (/^\d+\.\s/.test(line)) {
      flushInline()
      const match = line.match(/^(\d+)\.\s(.*)$/)
      if (match) {
        elements.push(
          <div key={key++} className="flex items-start gap-2 ml-2 mb-1">
            <span className="text-brand font-medium min-w-[20px]">{match[1]}.</span>
            <span className="leading-relaxed">{renderInline(match[2])}</span>
          </div>
        )
      }
      continue
    }

    // 空行
    if (line.trim() === '') {
      flushInline()
      continue
    }

    // 普通段落
    inlineBuffer.push(line)
  }

  flushInline()

  return (
    <div className="text-sm text-foreground">
      {elements}
      {isStreaming && (
        <span className="inline-block w-2.5 h-5 bg-brand animate-pulse ml-0.5 align-text-bottom rounded-sm" />
      )}
    </div>
  )
}

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|_([^_]+)_/g
  let lastIndex = 0
  let match
  let key = 0

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>)
    }
    if (match[1]) {
      parts.push(<InlineCode key={key++}>{match[1].slice(1, -1)}</InlineCode>)
    } else if (match[2]) {
      parts.push(<strong key={key++} className="font-semibold text-foreground">{match[2].slice(2, -2)}</strong>)
    } else if (match[3]) {
      parts.push(<em key={key++} className="italic">{match[3].slice(1, -1)}</em>)
    } else if (match[4]) {
      parts.push(<em key={key++} className="italic">{match[4]}</em>)
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIndex)}</span>)
  }

  return <>{parts}</>
}
