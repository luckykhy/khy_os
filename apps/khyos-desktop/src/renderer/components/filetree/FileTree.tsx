import { useState } from 'react'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  status?: 'modified' | 'added' | 'deleted' | 'untracked' | 'none'
}

const mockTree: FileNode = {
  name: 'khy-os',
  path: 'D:\\Portable\\khy-os',
  type: 'directory',
  children: [
    {
      name: 'apps',
      path: 'D:\\Portable\\khy-os\\apps',
      type: 'directory',
      children: [
        {
          name: 'khyos-desktop',
          path: 'D:\\Portable\\khy-os\\apps\\khyos-desktop',
          type: 'directory',
          children: [
            { name: 'package.json', path: 'D:\\Portable\\khy-os\\apps\\khyos-desktop\\package.json', type: 'file', status: 'modified' },
            { name: 'src', path: 'D:\\Portable\\khy-os\\apps\\khyos-desktop\\src', type: 'directory', children: [] },
            { name: 'README.md', path: 'D:\\Portable\\khy-os\\apps\\khyos-desktop\\README.md', type: 'file', status: 'added' },
          ],
        },
        {
          name: 'ai-frontend',
          path: 'D:\\Portable\\khy-os\\apps\\ai-frontend',
          type: 'directory',
          children: [
            { name: 'package.json', path: 'D:\\Portable\\khy-os\\apps\\ai-frontend\\package.json', type: 'file' },
            { name: 'src', path: 'D:\\Portable\\khy-os\\apps\\ai-frontend\\src', type: 'directory', children: [] },
          ],
        },
      ],
    },
    {
      name: 'docs',
      path: 'D:\\Portable\\khy-os\\docs',
      type: 'directory',
      children: [
        { name: 'DESIGN-ARCH-092.md', path: 'D:\\Portable\\khy-os\\docs\\DESIGN-ARCH-092.md', type: 'file', status: 'modified' },
      ],
    },
    { name: 'package.json', path: 'D:\\Portable\\khy-os\\package.json', type: 'file' },
    { name: 'README.md', path: 'D:\\Portable\\khy-os\\README.md', type: 'file', status: 'untracked' },
  ],
}

const STATUS_COLORS: Record<string, string> = {
  modified: 'var(--color-git-modified)',
  added: 'var(--color-git-added)',
  deleted: 'var(--color-git-deleted)',
  untracked: 'var(--color-git-untracked)',
  none: 'transparent',
}

const FILE_ICONS: Record<string, string> = {
  ts: '🔷',
  tsx: '🔷',
  js: '🟨',
  jsx: '🟨',
  vue: '🟢',
  json: '📋',
  md: '📝',
  css: '🎨',
  html: '🌐',
}

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return FILE_ICONS[ext] ?? '📄'
}

export function FileTree() {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null)

  return (
    <div className="text-sm text-foreground h-full flex flex-col">
      {/* 工具栏 */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
        <button className="p-1 rounded text-foreground/40 hover:text-foreground hover:bg-surface-hover text-xs" title="展开全部">
          ▾
        </button>
        <button className="p-1 rounded text-foreground/40 hover:text-foreground hover:bg-surface-hover text-xs" title="收起全部">
          ▸
        </button>
        <div className="flex-1" />
        <button className="p-1 rounded text-foreground/40 hover:text-foreground hover:bg-surface-hover text-xs" title="刷新">
          ↻
        </button>
      </div>

      {/* 文件树 */}
      <div className="flex-1 overflow-auto py-1">
        <FileNodeItem
          node={mockTree}
          depth={0}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          onContextMenu={setContextMenu}
        />
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="fixed bg-popover border border-popover-border rounded-lg shadow-xl py-1 z-50 animate-fade-in"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseLeave={() => setContextMenu(null)}
        >
          <button className="w-full text-left px-4 py-1.5 text-sm text-popover-foreground hover:bg-surface-hover">
            复制路径
          </button>
          <button className="w-full text-left px-4 py-1.5 text-sm text-popover-foreground hover:bg-surface-hover">
            在编辑器中打开
          </button>
          <button className="w-full text-left px-4 py-1.5 text-sm text-popover-foreground hover:bg-surface-hover">
            在文件管理器中打开
          </button>
          <div className="border-t border-popover-border my-1" />
          <button className="w-full text-left px-4 py-1.5 text-sm text-destructive hover:bg-surface-hover">
            删除
          </button>
        </div>
      )}
    </div>
  )
}

function FileNodeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  onContextMenu,
}: {
  node: FileNode
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
  onContextMenu: (pos: { x: number; y: number; path: string }) => void
}) {
  const [expanded, setExpanded] = useState(depth < 2)
  const isSelected = selectedPath === node.path
  const hasChildren = node.type === 'directory' && node.children && node.children.length > 0

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-1 cursor-pointer transition-colors rounded-md mx-1 ${
          isSelected ? 'bg-selected' : 'hover:bg-surface-hover'
        }`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={() => {
          onSelect(node.path)
          if (node.type === 'directory') setExpanded(!expanded)
        }}
        onContextMenu={e => {
          e.preventDefault()
          onContextMenu({ x: e.clientX, y: e.clientY, path: node.path })
        }}
      >
        {/* 展开图标 */}
        {node.type === 'directory' ? (
          <span
            className={`w-4 h-4 flex items-center justify-center text-xs text-foreground/40 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          >
            ▶
          </span>
        ) : (
          <span className="w-4" />
        )}

        {/* 文件图标 */}
        <span className="text-xs flex-shrink-0">
          {node.type === 'directory' ? (expanded ? '📂' : '📁') : getFileIcon(node.name)}
        </span>

        {/* 文件名 */}
        <span className={`truncate text-sm ${node.status && node.status !== 'none' ? 'font-medium' : ''}`}>
          {node.name}
        </span>

        {/* 状态指示 */}
        {node.status && node.status !== 'none' && (
          <span
            className="w-2 h-2 rounded-full flex-shrink-0 ml-auto"
            style={{ backgroundColor: STATUS_COLORS[node.status] }}
          />
        )}
      </div>

      {/* 子节点 */}
      {expanded && node.children?.map(child => (
        <FileNodeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  )
}
