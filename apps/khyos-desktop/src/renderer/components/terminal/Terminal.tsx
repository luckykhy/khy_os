import { useEffect, useRef } from 'react'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerminal | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const term = new XTerminal({
      theme: {
        background: 'var(--color-terminal-bg)', foreground: 'var(--color-terminal-fg)',
        cursor: 'var(--color-terminal-cursor)', cursorAccent: 'var(--color-terminal-cursor-accent)',
        black: 'var(--color-terminal-black)', red: 'var(--color-terminal-red)',
        green: 'var(--color-terminal-green)', yellow: 'var(--color-terminal-yellow)',
        blue: 'var(--color-terminal-blue)', magenta: 'var(--color-terminal-magenta)',
        cyan: 'var(--color-terminal-cyan)', white: 'var(--color-terminal-white)',
        brightBlack: 'var(--color-terminal-bright-black)', brightRed: 'var(--color-terminal-bright-red)',
        brightGreen: 'var(--color-terminal-bright-green)', brightYellow: 'var(--color-terminal-bright-yellow)',
        brightBlue: 'var(--color-terminal-bright-blue)', brightMagenta: 'var(--color-terminal-bright-magenta)',
        brightCyan: 'var(--color-terminal-bright-cyan)', brightWhite: 'var(--color-terminal-bright-white)'
      },
      fontFamily: 'var(--font-mono)', fontSize: 14
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon); term.loadAddon(new WebLinksAddon()); term.loadAddon(new SearchAddon())
    try { term.loadAddon(new WebglAddon()) } catch (e) { /* WebGL not available */ }
    term.open(containerRef.current); fitAddon.fit()
    term.writeln('KhyOS Terminal'); term.writeln('输入命令开始...'); term.write('\$ ')
    term.onData(data => { term.write(data); if (data === '\r') { term.writeln(''); term.writeln('命令执行结果（stub）'); term.write('\$ ') } })
    termRef.current = term
    return () => { term.dispose() }
  }, [])
  return <div ref={containerRef} className="h-full bg-terminal-bg" />
}
