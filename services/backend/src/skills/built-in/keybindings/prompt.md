# Keybindings — Keyboard Shortcut Reference

## Purpose
Display all available keyboard shortcuts and keybindings for the CLI interface.

## Output Format
Present keybindings in organized groups using a clean table format.

## Keybinding Groups

### General
| Key | Action |
|-----|--------|
| `Enter` | Submit input |
| `Ctrl+C` | Cancel current operation / clear input |
| `Ctrl+D` | Exit the CLI |
| `Ctrl+L` | Clear screen |
| `Tab` | Autocomplete commands and file paths |
| `Up/Down` | Navigate command history |

### Vim Mode (when enabled)
| Key | Action |
|-----|--------|
| `Escape` | Enter normal mode |
| `i` | Enter insert mode |
| `v` | Enter visual mode |
| `dd` | Delete line |
| `yy` | Yank (copy) line |
| `p` | Paste |
| `/` | Search |
| `u` | Undo |

### Navigation
| Key | Action |
|-----|--------|
| `Ctrl+A` | Move cursor to beginning of line |
| `Ctrl+E` | Move cursor to end of line |
| `Ctrl+W` | Delete word before cursor |
| `Ctrl+U` | Delete from cursor to beginning of line |
| `Ctrl+K` | Delete from cursor to end of line |
| `Alt+B` | Move back one word |
| `Alt+F` | Move forward one word |

### Special
| Key | Action |
|-----|--------|
| `Ctrl+R` | Reverse search history |
| `Ctrl+Z` | Suspend process |
| `Ctrl+\\` | Force quit |

## Guidelines
- Display all groups by default.
- If the user asks about a specific key, show just that binding.
- Note platform differences (e.g., Alt key behavior on macOS vs Linux).
