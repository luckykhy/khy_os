import { useState } from 'react'

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged' | 'header'
  content: string
  oldLineNum?: number
  newLineNum?: number
}

interface DiffFile {
  path: string
  status: 'modified' | 'added' | 'deleted'
  additions: number
  deletions: number
  lines: DiffLine[]
}

const mockDiff: DiffFile = {
  path: 'src/sort/quicksort.ts',
  status: 'modified',
  additions: 8,
  deletions: 2,
  lines: [
    { type: 'header', content: '@@ -1,5 +1,11 @@' },
    { type: 'unchanged', content: ' function quicksort(arr: number[]): number[] {', oldLineNum: 1, newLineNum: 1 },
    { type: 'removed', content: '   if (arr.length === 0) return [];', oldLineNum: 2 },
    { type: 'added', content: '   if (arr.length <= 1) return arr;', newLineNum: 2 },
    { type: 'unchanged', content: '   const pivot = arr[Math.floor(arr.length / 2)];', oldLineNum: 3, newLineNum: 3 },
    { type: 'removed', content: '   const left = arr.filter(x => x < pivot);', oldLineNum: 4 },
    { type: 'added', content: '   const left = arr.filter(x => x < pivot);', newLineNum: 4 },
    { type: 'added', content: '   const middle = arr.filter(x => x === pivot);', newLineNum: 5 },
    { type: 'unchanged', content: '   const right = arr.filter(x => x > pivot);', oldLineNum: 5, newLineNum: 6 },
    { type: 'unchanged', content: '   return [...quicksort(left), ...middle, ...quicksort(right)];', oldLineNum: 6, newLineNum: 7 },
    { type: 'unchanged', content: ' }', oldLineNum: 7, newLineNum: 8 },
  ],
}

export function DiffViewer({ file = mockDiff, onClose }: { file?: DiffFile; onClose?: () => void }) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="my-3 rounded-xl border border-card-border overflow-hidden bg-card">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-surface border-b border-card-border">
        <span className={`w-2.5 h-2.5 rounded-full ${
          file.status === 'added' ? 'bg-success' : file.status === 'deleted' ? 'bg-destructive' : 'bg-warning'
        }`} />
        <span className="text-sm font-medium text-foreground flex-1 truncate">{file.path}</span>
        <span className="text-xs text-success font-medium">+{file.additions}</span>
        <span className="text-xs text-destructive font-medium">-{file.deletions}</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="p-1 rounded text-foreground/40 hover:text-foreground hover:bg-surface-hover text-xs ml-2"
        >
          {expanded ? '收起' : '展开'}
        </button>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded text-foreground/40 hover:text-foreground hover:bg-surface-hover text-xs"
          >
            ✕
          </button>
        )}
      </div>

      {/* Diff 内容 */}
      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <tbody>
              {file.lines.map((line, i) => (
                <tr key={i} className={
                  line.type === 'added' ? 'bg-success/10' :
                  line.type === 'removed' ? 'bg-destructive/10' :
                  line.type === 'header' ? 'bg-accent' : ''
                }>
                  <td className="px-2 py-0.5 text-right text-foreground/30 select-none w-10 border-r border-card-border/50">
                    {line.oldLineNum || ''}
                  </td>
                  <td className="px-2 py-0.5 text-right text-foreground/30 select-none w-10 border-r border-card-border/50">
                    {line.newLineNum || ''}
                  </td>
                  <td className="px-3 py-0.5 whitespace-pre text-foreground/80">
                    {line.type === 'added' && <span className="text-success mr-2">+</span>}
                    {line.type === 'removed' && <span className="text-destructive mr-2">-</span>}
                    {line.type === 'header' && <span className="text-brand mr-2">@@</span>}
                    {line.content}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function DiffSummary({ files, onViewDiff, onUndo }: { files: { path: string; status: string; additions: number; deletions: number }[]; onViewDiff?: (path: string) => void; onUndo?: () => void }) {
  const [expanded, setExpanded] = useState(true)
  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0)
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0)

  return (
    <div className="my-3 bg-card border border-card-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-card-border">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-sm text-foreground/70 hover:text-foreground transition-colors flex-1"
        >
          <span className={`transition-transform duration-200 text-xs ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="font-medium">已更改文件</span>
          <span className="text-xs text-foreground/40">{files.length} 个文件</span>
          <span className="text-xs text-success">+{totalAdditions}</span>
          <span className="text-xs text-destructive">-{totalDeletions}</span>
        </button>
        {onUndo && (
          <button
            onClick={onUndo}
            className="px-3 py-1 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover border border-card-border transition-colors"
          >
            撤销文件改动
          </button>
        )}
      </div>

      {expanded && (
        <div className="py-1">
          {files.map((file, i) => (
            <div
              key={i}
              className="flex items-center gap-2 px-4 py-2 hover:bg-surface-hover cursor-pointer transition-colors"
              onClick={() => onViewDiff?.(file.path)}
            >
              <span className={`w-2 h-2 rounded-full ${
                file.status === 'added' ? 'bg-success' : file.status === 'deleted' ? 'bg-destructive' : 'bg-warning'
              }`} />
              <span className="text-sm text-foreground flex-1 truncate">{file.path}</span>
              {file.additions > 0 && <span className="text-xs text-success">+{file.additions}</span>}
              {file.deletions > 0 && <span className="text-xs text-destructive">-{file.deletions}</span>}
              <button className="text-xs text-brand hover:underline ml-2">查看</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
