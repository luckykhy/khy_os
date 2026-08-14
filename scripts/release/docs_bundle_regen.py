# @pattern Build Step (fail-soft)
"""构建时在 wheel 的 bundled 载荷内重新生成离线文档站。

为什么存在（本模块修复的根因）：
  文档站生成器 `scripts/docs/build_docs_site.js` 把每个 `.md` 渲染成同名 `.html`，
  并产出一份全站侧栏数据 `docs/_assets/nav-data.js`。这些产物若在**完整源码开发树**
  里生成、再被裁剪进 pip wheel 的 `khy_os/bundled/`，就会引用**不随包**的文档
  （`CLAUDE.html`、`.ai/*.html`、`矛盾点收齐清单.html` 等）——用户 pip 安装后点侧栏或
  首页卡片，浏览器打开一个不存在的 `khy_os/bundled/…​.html` → `ERR_FILE_NOT_FOUND`。

  生成器的 `ROOT` 自解析为「脚本自身所在目录的上两级」，即 bundle 根。因此在 bundle 内
  重跑它，就会产出与**实际随包内容**一致的站点：缺失目标由生成器的 `neutralizeDeadLinks`
  就地降级为纯文本，不再有跨包断链。

设计约束（对齐 setup.py 里 _run_obfuscate / _embed_source_snapshot 的构建时 node 步骤）：
  - fail-soft：node 缺失/脚本缺失/生成失败一律 WARN 而非中止，并清掉陈旧产物，
    保证「宁可无 html 也绝不发布断链」。
  - 外科手术式：清理只删生成器自己的产物（带模板签名且旁边有同名 `.md` 的 `.html`
    + `nav-data.js`/`dead-links.json`/`docs/index.html`），绝不碰前端应用页
    （`apps/ai-frontend/**`、`frontend/dist/**`、`software/khyquant/frontend/**` 等）。
  - 确定性：生成器无时间戳/随机数，可复现。

从 setup.py 抽出到 scripts/release/ 的原因：setup.py 在模块级调用 setup()，直接 import
会触发构建；抽成独立叶子后可被 tests/unit 干净单测（导入不触发任何构建副作用）。
这与 setup.py 已有的 `from pip_packaging_rules import ...` / `from render_manifest import ...`
同一 idiom。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

# 环境开关：本地快构建可显式跳过重生成。
SKIP_ENV_VAR = "KHY_SKIP_DOCS_REGEN"
# 生成器脚本在 bundle 内的相对位置。
GENERATOR_REL = ("scripts", "docs", "build_docs_site.js")
# 生成器统一模板的两处稳定签名（用于 fail-soft 清理时零歧义识别「是生成器产物」）。
# 前端应用页（ai-frontend / khyquant 前端 / vite dist）既不引用 docs-site.css，
# 也不含该品牌串，因此永不会被误删。
_TEMPLATE_SIGNATURES = ("docs-site.css", "Khy-OS 文档站")
# 生成器产出的、无同名 .md 的独立产物（侧栏数据 + 断链审计 + 首页）。
_STANDALONE_ARTIFACTS = (
    ("docs", "_assets", "nav-data.js"),
    ("docs", "_assets", "dead-links.json"),
    ("docs", "index.html"),
)


def _prune_dot_directories(bundled: Path) -> int:
    """在重生成前，从 bundle 内移除所有点目录（名字以 "." 开头的目录）。

    根因（本函数修复的第二类断链）：setuptools 的 `package_data` 收集在**打包阶段**
    无条件丢弃一切点目录（`.khy-runtime/`、`.githooks/` 等）——这是 setuptools 固有
    行为，任何 glob/配置都改不了。但重生成此刻的 bundle 仍带着这些点目录里的 `.md`，
    生成器会照常给它们建同名 `.html`、侧栏卡片与首页引用；随后打包又把那些 `.html`
    连同点目录一起扔掉 → 侧栏/首页留下指向「不随包的点目录 html」的**活死链**
    （不是被降级的纯文本，而是真断链卡片）。

    对策：让「重生成的输入」= 「实际随包的内容」。既然点目录注定不进 wheel，就在生成
    之前把它们从 bundle 里删掉，使生成器根本看不到这些 `.md`。任何**指向**点目录文档的
    交叉引用于是被生成器的 `neutralizeDeadLinks` 正确降级为纯文本，而非留下断链卡片。

    为什么放在叶子而非生成器：生成器 `build_docs_site.js` 是开发树 `npm run docs:build`
    共用的确定性组件——它在完整源码树里**应当**索引 `.ai/` 等点目录文档。这里的裁剪只针对
    「即将进 wheel 的 bundle 副本」，与打包行为一一对应，不改变开发树站点。

    非破坏性：bundle 是每次构建从源码树重新拷装的（`platform/khy_os/bundled/` 被
    gitignore），删的是这份临时副本；且这些点目录本就不会进 wheel。全程 fail-soft，
    绝不抛出。返回删除的点目录数。
    """
    removed = 0
    try:
        entries = list(bundled.rglob("*"))
    except Exception:
        return removed
    for entry in entries:
        try:
            if not entry.is_dir() or entry.is_symlink():
                continue
            if not entry.name.startswith("."):
                continue
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
        except Exception:
            pass
    return removed


def _is_truthy_env(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


def looks_like_doc_site_html(html_path: Path) -> bool:
    """判定某个 .html 是否为文档站生成器的产物（而非前端应用页）。

    只读文件头 ~2KB 做两处签名匹配即可零歧义分辨（见 _TEMPLATE_SIGNATURES）。这样
    `apps/ai-frontend/index.html`、`frontend/dist/index.html`、khyquant 前端页等
    「同名恰好也叫 *.html」的真实应用产物绝不会被误判（它们不含这两处签名）。
    读取失败一律返回 False（fail-soft：不确定就不删）。
    """
    try:
        with html_path.open("r", encoding="utf-8", errors="ignore") as fh:
            head = fh.read(2048)
    except Exception:
        return False
    return all(sig in head for sig in _TEMPLATE_SIGNATURES)


def strip_stale_docs_artifacts(bundled: Path) -> int:
    """删除陈旧的文档站产物，保证「宁可无 html 也绝不发布断链」。

    仅在 fail-soft 回退路径里调用（node 缺失/生成失败无法重生成时）。删除范围（外科手术式）：
      - docs/_assets/nav-data.js、docs/_assets/dead-links.json、docs/index.html（生成器独立产物）
      - 任意目录下带生成器模板签名（见 looks_like_doc_site_html）且旁边有同名 .md 的 *.html

    返回删除的文件数。全程 fail-soft，绝不抛出。
    """
    removed = 0

    for parts in _STANDALONE_ARTIFACTS:
        p = bundled.joinpath(*parts)
        try:
            if p.is_file():
                p.unlink()
                removed += 1
        except Exception:
            pass

    try:
        html_iter = list(bundled.rglob("*.html"))
    except Exception:
        html_iter = []
    for html_path in html_iter:
        try:
            sibling_md = html_path.with_suffix(".md")
            if not sibling_md.exists():
                continue  # 无同名 .md → 不是本生成器产物（应用页/参考页），保留
            if not looks_like_doc_site_html(html_path):
                continue  # 无模板签名 → 保留（双保险）
            html_path.unlink()
            removed += 1
        except Exception:
            pass

    return removed


def _warn(message: str) -> None:
    print(f"  [WARN] {message}", file=sys.stderr)


def _cleanup_after_failure(bundled: Path, reason: str) -> None:
    """重生成不可用时的统一收尾：清陈旧产物 + 报告。"""
    removed = strip_stale_docs_artifacts(bundled)
    if removed:
        print(f"  [docs-site] 已清理 {removed} 个陈旧文档站产物（{reason}，避免发布断链）")


def regenerate_docs_site(bundled: Path, node_cmd: str = "node") -> bool:
    """在 bundle 内重新生成离线文档站，使侧栏/首页跳转与「实际随包内容」一致。

    参数：
      bundled  —— wheel 载荷根（platform/khy_os/bundled）。
      node_cmd —— node 可执行名（默认 "node"；测试可注入）。

    返回：True 表示已成功重生成；False 表示走了 fail-soft 清理路径（跳过/缺失/失败）。
    全程 fail-soft，绝不抛出——发布构建不因文档站问题中止。
    """
    if _is_truthy_env(os.environ.get(SKIP_ENV_VAR, "")):
        print(f"  [SKIP] docs-site regen disabled via {SKIP_ENV_VAR}")
        _cleanup_after_failure(bundled, "跳过重生成")
        return False

    script = bundled.joinpath(*GENERATOR_REL)
    if not script.exists():
        _warn(f"docs-site generator missing in bundle: {script}")
        _cleanup_after_failure(bundled, "生成器缺失")
        return False

    # 先剪掉注定不进 wheel 的点目录，使「重生成输入」= 「实际随包内容」，
    # 避免生成器给 .khy-runtime/.githooks 等点目录文档建出随后被打包丢弃的断链卡片。
    pruned = _prune_dot_directories(bundled)
    if pruned:
        print(f"  [docs-site] 已剪除 {pruned} 个点目录（不随 wheel 发布，避免侧栏活死链）")

    try:
        result = subprocess.run(
            [node_cmd, str(script), "--quiet"],
            cwd=str(bundled),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
    except FileNotFoundError:
        _warn("node not found — 跳过文档站重生成")
        _cleanup_after_failure(bundled, "node 缺失")
        return False
    except Exception as e:  # 包含 TimeoutExpired 等
        _warn(f"docs-site regen failed: {e}")
        _cleanup_after_failure(bundled, "重生成异常")
        return False

    if result.stdout and result.stdout.strip():
        print(f"  {result.stdout.strip()}")
    if result.stderr and result.stderr.strip():
        print(f"  {result.stderr.strip()}", file=sys.stderr)
    if result.returncode != 0:
        _warn("docs-site regen exited non-zero")
        _cleanup_after_failure(bundled, "重生成非零退出")
        return False

    print("  [OK] docs-site: 已在 bundle 内重新生成，侧栏/首页跳转与随包内容一致")
    return True
