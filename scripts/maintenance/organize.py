#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
khy-os 仓库整理器 —— [DESIGN-LAY-003] 仓库整理与巡检规范 (LAYOUT-004) 的执行者。

上级真源:
  - [DESIGN-LAY-002] 目录层级与文件归类规范 (LAYOUT-001)   ← 新文件放哪
  - [DESIGN-LAY-005] 仓库层级板块规范                     ← L0-L6 层级模型
  - [DESIGN-LAY-003] 仓库整理与巡检规范                    ← 存量杂物怎么清

红线实现: HK-1 git 已跟踪不动 / HK-2 运行时数据只读 / HK-3 只隔离不删除 /
          HK-4 html 孪生不当孤儿 / HK-5 不穿透软链 / HK-7 单批限流 /
          HK-8 不覆盖目标

用法:
    python scripts/maintenance/organize.py --report   # 只出报告（默认）
    python scripts/maintenance/organize.py --apply    # 额外隔离白名单内超期临时文件
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat as stat_mod
import subprocess
import sys
import datetime as dt
from pathlib import Path

# ------------------------------------------------------------------ 配置

# 本文件位于 <repo>/scripts/maintenance/organize.py
REPO = Path(__file__).resolve().parents[2]
# 隔离区落在 .khyos/housekeeping/（被 .gitignore 忽略，不污染 git 状态）
OUT_ROOT = REPO / ".khyos" / "housekeeping"

GUARD_DIRS = {
    ".git", ".khy", ".khyos", "node_modules", "khy_os.egg-info",
    ".venv", "venv", "__pycache__", "dist", "build", ".next",
}
GUARD_PREFIX = (".git-backup",)

RESEARCH_TMP = ".research-tmp"
ARTIFACTS = "_产物"
RESEARCH_MAX_AGE_DAYS = 7
BATCH_LIMIT = 10

MIRROR_SCAN_DIRS = [
    ".", ".ai", ".github", ".opencode", ".zcode",
    "docs", "kernel", "scripts", "tests", "apps", ARTIFACTS,
]
ALLOWED_DOT = {".ai", ".github", ".opencode", ".zcode"}
MIRROR_MAX_DEPTH = 4
MIRROR_SKIP = {
    "extensions", "platform", "services", "software", "tools",
    "electron", "packaging", "patches", "deploy", "node_modules",
    "coverage", "locale", "locales", "assets",
}

BAD_NAME_RE = re.compile(
    r"(对抗修复版|最终对抗版|最终版|最终稿|最新版|副本|拷贝|未命名|新建|"
    r"final|copy|backup|\(1\)|（1）)",
    re.IGNORECASE,
)
VERSION_SUFFIX_RE = re.compile(r"_(v\d+|\d{8}|对抗.*|最终.*)$")

BIG_FILE_MB = 500
MAX_DIRS_LISTED = 40


# ------------------------------------------------------------------ 工具


def now() -> dt.datetime:
    return dt.datetime.now()


def age_days(p: Path) -> float:
    try:
        return (now().timestamp() - p.stat().st_mtime) / 86400.0
    except OSError:
        return 0.0


def size_mb(p: Path) -> float:
    try:
        return p.stat().st_size / 1048576.0
    except OSError:
        return 0.0


def rel(p: Path) -> str:
    try:
        return str(p.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(p)


def is_guard(name: str) -> bool:
    return name in GUARD_DIRS or name.startswith(GUARD_PREFIX)


def is_link(p: Path) -> bool:
    """符号链接与 Windows junction 都算（HK-5）。"""
    try:
        st = os.lstat(p)
    except OSError:
        return False
    if stat_mod.S_ISLNK(st.st_mode):
        return True
    return bool(getattr(st, "st_file_attributes", 0) & 0x400)


def _norm_link(t: str) -> str:
    return t[4:] if t.startswith("\\\\?\\") else t


def link_target(p: Path) -> str:
    for fn in (lambda: os.readlink(p), lambda: os.path.realpath(p)):
        try:
            t = fn()
            if t:
                return _norm_link(t)
        except OSError:
            continue
    return "（目标读取失败）"


def link_scope(p: Path) -> str:
    raw = link_target(p)
    if raw.startswith("（"):
        return "目标未知"
    try:
        Path(raw).resolve().relative_to(REPO.resolve())
        return "仓库内"
    except ValueError:
        return "越界"


def git(*args: str) -> str:
    """一次性 safe.directory，不写全局配置（仓库属主与当前用户不同）。"""
    try:
        r = subprocess.run(
            ["git", "-c", f"safe.directory={REPO.as_posix()}", *args],
            cwd=str(REPO), capture_output=True, text=True, timeout=180,
            encoding="utf-8", errors="replace",
        )
        return r.stdout if r.returncode == 0 else ""
    except Exception:  # noqa: BLE001
        return ""


def unique_target(dst: Path) -> Path:
    """HK-8：绝不覆盖。"""
    if not dst.exists():
        return dst
    stem, suf = dst.stem, dst.suffix
    i = 1
    while True:
        c = dst.with_name(f"{stem}_{i}{suf}")
        if not c.exists():
            return c
        i += 1


def walk_bounded(base: Path, max_depth: int, allow_dot: bool = False):
    """限深遍历；不穿透软链/junction；点开头目录需白名单。"""
    base = base.resolve()
    stack: list[tuple[Path, int]] = [(base, 0)]
    while stack:
        cur, depth = stack.pop()
        try:
            entries = sorted(cur.iterdir())
        except OSError:
            continue
        dirs, files = [], []
        for e in entries:
            if e.is_dir():
                n = e.name
                if is_guard(n) or is_link(e):
                    continue
                if n.startswith(".") and n not in ALLOWED_DOT and not allow_dot:
                    continue
                if n in MIRROR_SKIP:
                    continue
                dirs.append(e)
            else:
                files.append(e)
        yield cur, files
        if depth < max_depth:
            for d in dirs:
                stack.append((d, depth + 1))


# ------------------------------------------------------------------ 主体


class Auditor:
    def __init__(self, apply: bool):
        self.apply = apply
        self.tracked: set[str] = set()
        self.moves: list[dict] = []
        self.errors: list[str] = []
        self.mirror_dirs: dict[str, int] = {}
        self.root_mirrors: list[str] = []
        self.sec: dict[str, list[str]] = {
            "orphan_html": [], "artifacts": [], "research": [],
            "symlinks": [], "badname": [], "bigfile": [], "tracked_hit": [],
        }
        self.quarantine: list[tuple[Path, str]] = []

    def load_tracked(self) -> None:
        out = git("ls-files", "-z")
        if out:
            self.tracked = {p.replace("\\", "/") for p in out.split("\0") if p}
        else:
            self.errors.append("git ls-files 无输出，已跟踪判定不可用")

    def is_tracked(self, p: Path) -> bool:
        return rel(p) in self.tracked

    # ---------- 生成物镜像

    def scan_mirrors(self) -> None:
        seen: set[str] = set()
        for d in MIRROR_SCAN_DIRS:
            base = REPO if d == "." else REPO / d
            if not base.is_dir():
                continue
            for cur, files in walk_bounded(base, MIRROR_MAX_DEPTH, allow_dot=(d == ".")):
                for f in files:
                    if not f.name.lower().endswith(".html"):
                        continue
                    r = rel(f)
                    if r in seen:
                        continue
                    seen.add(r)
                    if f.with_suffix(".md").exists():
                        parent = rel(cur)
                        self.mirror_dirs[parent] = self.mirror_dirs.get(parent, 0) + 1
                    else:
                        # HK-4：只报告，绝不据此删除
                        tag = " [git已跟踪]" if self.is_tracked(f) else " [疑似入口文件，勿删]"
                        self.sec["orphan_html"].append(f"{r}{tag}")
        self.root_mirrors = sorted(
            f.name for f in REPO.iterdir()
            if f.is_file() and f.suffix.lower() == ".html"
            and f.with_suffix(".md").exists()
        )

    # ---------- _产物

    def scan_artifacts(self) -> None:
        d = REPO / ARTIFACTS
        if not d.is_dir():
            return
        groups: dict[tuple[str, str], list[str]] = {}
        for p in sorted(d.iterdir()):
            if is_link(p):
                self.sec["symlinks"].append(
                    f"`{rel(p)}` → `{link_target(p)}` （{link_scope(p)}）")
                continue
            if p.is_dir():
                n = sum(1 for _ in p.rglob("*") if _.is_file())
                self.sec["artifacts"].append(f"`{rel(p)}/` 目录，{n} 个文件")
                continue
            if BAD_NAME_RE.search(p.name):
                self.sec["badname"].append(rel(p))
            base = VERSION_SUFFIX_RE.sub("", p.stem)
            groups.setdefault((base, p.suffix.lower()), []).append(p.name)
        for (base, suf), names in sorted(groups.items()):
            if len(names) > 1:
                self.sec["artifacts"].append(
                    f"**版本冗余 x{len(names)}** `{base}*{suf}` → " + " / ".join(sorted(names)))

    # ---------- .research-tmp

    def scan_research_tmp(self) -> None:
        d = REPO / RESEARCH_TMP
        if not d.is_dir():
            return
        for p in sorted(d.rglob("*")):
            if not p.is_file() or is_link(p):
                continue
            a = age_days(p)
            if a > RESEARCH_MAX_AGE_DAYS:
                self.sec["research"].append(f"{rel(p)} （{int(a)} 天）")
                self.quarantine.append((p, "G4-research-tmp"))

    # ---------- 根目录

    def scan_root(self) -> None:
        for p in sorted(REPO.iterdir()):
            if is_link(p):
                self.sec["symlinks"].append(
                    f"`{rel(p)}` → `{link_target(p)}` （{link_scope(p)}）")
                continue
            if p.is_dir():
                continue
            r = rel(p)
            if size_mb(p) > BIG_FILE_MB:
                self.sec["bigfile"].append(f"{r} （{size_mb(p):.0f} MB）")
            if BAD_NAME_RE.search(p.name):
                self.sec["badname"].append(r)

    # ---------- 隔离

    def do_quarantine(self) -> None:
        if not self.apply or not self.quarantine:
            return
        if not self.tracked:
            self.errors.append(
                f"git 跟踪基线为空，已拒绝执行隔离（{len(self.quarantine)} 个候选原地保留）")
            return
        dst_root = OUT_ROOT / now().strftime("%Y-%m-%d")
        for i, (src, rule) in enumerate(self.quarantine):
            if i >= BATCH_LIMIT:  # HK-7
                self.errors.append(f"达到单批上限 {BATCH_LIMIT}，剩余候选留待下次")
                break
            if self.is_tracked(src):  # HK-1
                self.sec["tracked_hit"].append(rel(src))
                continue
            try:
                dst_root.mkdir(parents=True, exist_ok=True)
                dst = unique_target(dst_root / src.name)
                shutil.move(str(src), str(dst))
                self.moves.append({"rule": rule, "from": str(src), "to": str(dst),
                                   "size_mb": round(size_mb(dst), 3)})
            except Exception as exc:  # noqa: BLE001
                self.errors.append(f"隔离失败 {src}: {exc}")

    # ---------- 产出

    def render(self) -> str:
        mode = "隔离执行" if self.apply else "只读报告（未改动任何文件）"
        dirty_n = len([l for l in git("status", "--porcelain").splitlines() if l.strip()])
        head = git("log", "-1", "--format=%h %ad %s", "--date=short").strip()
        total = sum(self.mirror_dirs.values())
        L = [
            f"# khy-os 整理报告 · {now().strftime('%Y-%m-%d %H:%M')}", "",
            f"- 模式：**{mode}**",
            f"- 目标仓库：`{REPO}`",
            f"- 最后提交：`{head or '（读取失败）'}`",
            f"- 未提交变更：**{dirty_n}** 处",
            f"- git 跟踪基线：{len(self.tracked)} 个文件", "",
            "> 规范依据：`docs/10_规范/DESIGN-LAY/[DESIGN-LAY-003] 仓库整理与巡检规范.md`（LAYOUT-004）",
        ]
        if dirty_n > 0:
            L += ["", f"> ⚠️ 仓库存在 {dirty_n} 处未提交变更，本次未对源码区做任何改动。"]

        if self.moves:
            L += ["", "## 一、本次已隔离", "", "| 规则 | 原位置 | 新位置 |", "|---|---|---|"]
            L += [f"| {m['rule']} | `{rel(Path(m['from']))}` | `{rel(Path(m['to']))}` |"
                  for m in self.moves]

        L += [
            "", "## 生成物镜像（.html ↔ .md 孪生）", "",
            f"全仓共 **{total}** 个，分布在 **{len(self.mirror_dirs)}** 个目录。", "",
            "**LAY-5 强制要求，属合法产出，不得清理（HK-4）。**", "",
            f"根目录镜像（{len(self.root_mirrors)} 个）："
            + ("、".join(f"`{n}`" for n in self.root_mirrors) if self.root_mirrors else "无"), "",
        ]
        if self.mirror_dirs:
            L += ["镜像最集中的目录：", ""]
            top = sorted(self.mirror_dirs.items(), key=lambda kv: -kv[1])[:MAX_DIRS_LISTED]
            L += [f"- `{d}/` — {n} 个" for d, n in top]
            if len(self.mirror_dirs) > MAX_DIRS_LISTED:
                L.append(f"- …（其余 {len(self.mirror_dirs) - MAX_DIRS_LISTED} 个目录略）")

        def sec(title: str, key: str) -> None:
            items = self.sec[key]
            L.extend(["", f"## {title}", ""])
            L.extend([f"- {i}" for i in items] if items else ["_无。_"])

        sec("孤立 .html（无同名 .md，仅报告不处理）", "orphan_html")
        sec("_产物 内容与版本冗余", "artifacts")
        sec("待隔离：.research-tmp 超期文件（>7 天）", "research")
        sec("软链 / 联接", "symlinks")
        sec("命名违规", "badname")
        sec("大文件（>500MB）", "bigfile")
        sec("命中 git 跟踪、已拒绝操作（HK-1）", "tracked_hit")

        L += [
            "", "## 处置建议", "",
            "1. **`.html` 孪生**：LAY-5 要求，保持现状。",
            "2. **`_产物/` 版本冗余**：保留最新一版，其余按 `_v1/_v2` 重命名或移入隔离区。",
            "3. **`.research-tmp/`**：超期文件隔离；若长期使用应改正式目录名并纳入版本控制。",
            "4. **越界软链**：`_产物/khy-Trajectory` 指向仓库外，建议删除或改仓库内相对路径。",
            "5. **L3 删除**：脚本永不执行（HK-3）。",
            "", "---", "",
            f"> 隔离区：`{OUT_ROOT}\\`（已被 .gitignore 忽略，HK-6）",
            "> 撤回：按 manifest 原路移回即可。",
        ]
        if self.errors:
            L += ["", "## 异常", ""] + [f"- {e}" for e in self.errors]
        return "\n".join(L)

    def manifest(self) -> dict:
        return {
            "run_at": now().isoformat(timespec="seconds"),
            "mode": "apply" if self.apply else "report",
            "repo": str(REPO),
            "move_count": len(self.moves),
            "moves": self.moves,
            "quarantine_candidates": len(self.quarantine),
            "mirror_total": sum(self.mirror_dirs.values()),
            "errors": self.errors,
        }

    def run(self) -> int:
        if not REPO.is_dir():
            print(f"[致命] 仓库不存在: {REPO}")
            return 2
        self.load_tracked()
        self.scan_mirrors()
        self.scan_artifacts()
        self.scan_research_tmp()
        self.scan_root()
        self.do_quarantine()

        report, mf = self.render(), self.manifest()
        date = now().strftime("%Y-%m-%d")
        try:
            (OUT_ROOT / "reports").mkdir(parents=True, exist_ok=True)
            (OUT_ROOT / "manifests").mkdir(parents=True, exist_ok=True)
            (OUT_ROOT / "reports" / f"khy-os-{date}.md").write_text(report, encoding="utf-8")
            (OUT_ROOT / "manifests" / f"khy-os-{date}-manifest.json").write_text(
                json.dumps(mf, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            print(f"[警告] 写报告失败: {exc}")

        print(f"模式: {'apply' if self.apply else 'report'}")
        print(f"仓库: {REPO}")
        print(f"git 跟踪基线: {len(self.tracked)} 文件")
        print(f"生成物镜像: {sum(self.mirror_dirs.values())} 个 / {len(self.mirror_dirs)} 目录")
        print(f"根目录镜像: {len(self.root_mirrors)}")
        for k, label in [("orphan_html", "孤立 .html"), ("artifacts", "_产物条目"),
                         ("research", "待隔离临时文件"), ("symlinks", "软链/联接"),
                         ("badname", "命名违规"), ("bigfile", "大文件")]:
            print(f"{label}: {len(self.sec[k])}")
        print(f"隔离候选 {len(self.quarantine)} / 实际隔离 {len(self.moves)}")
        for e in self.errors:
            print(f"错误: {e}")
        print(f"报告: {OUT_ROOT / 'reports' / f'khy-os-{date}.md'}")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="khy-os 仓库整理器 (LAYOUT-004)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--report", action="store_true", help="只出报告（默认）")
    g.add_argument("--apply", action="store_true", help="隔离白名单内超期临时文件")
    args = ap.parse_args()
    return Auditor(apply=bool(args.apply)).run()


if __name__ == "__main__":
    sys.exit(main())
