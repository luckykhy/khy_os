"""khy docs build — 在安装目录内重新生成离线文档站（供用户机器随时刷新）。

用途：pip / npm 安装后，用户想把文档站 HTML 重新生成到与本机实际随包内容一致的状态时，
运行 `khy docs build`（别名 `docs site` / `docs rebuild` / `docs regenerate` / `docs generate`）。
这是「构建时预生成」（见 scripts/release/docs_bundle_regen.py）之外的第二条腿：即使发行版里
文档站已就绪，用户改了随包 .md、或想在断链治理后重跑，也能一键刷新。

设计要点：
  - 只拦截 `docs build|site|rebuild|regenerate|generate`，绝不遮蔽 Node 端已有的
    `docs quickstart|ai-fastlane|maintainer|claude|gateway|strategy|faq|subscribe|check`
    ——这些子命令仍原样落到 Node CLI。maybe_run_docs_build 对不匹配的输入返回 None。
  - 定位生成器优先用调用方传入的 bundled_root（cli._find_bundled_root() 的规范解析），
    再回退到路径启发式（源码开发树 / 安装目录相邻的 khy_os/bundled），便于独立单测。
  - 生成器是确定性、离线、无新增依赖的 Node 脚本；本模块只负责找到它、跑起来、把结果
    翻成人话，并可选跟跑 verify_docs_site.js。
  - fail-soft：node 缺失/脚本缺失/生成失败都返回非零退出码 + 明确的解决提示，绝不抛栈。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

# 触发文档站重建的子命令别名（第二个位置参数）。
_BUILD_SUBCOMMANDS = {"build", "site", "rebuild", "regenerate", "generate"}
# 生成器与验证器在「站点根」下的相对位置。
_GENERATOR_REL = ("scripts", "docs", "build_docs_site.js")
_VERIFIER_REL = ("scripts", "docs", "verify_docs_site.js")


def maybe_run_docs_build(raw_args):
    """把 `docs build|site|rebuild|regenerate|generate ...` 归一为「剩余参数 argv」。

    返回：
      - list —— 命中重建子命令，返回其后的剩余参数（可为空 []）。调用方据此拦截。
      - None —— 不是文档站重建命令（例如裸 `docs`、`docs quickstart`、非 docs 命令），
        交回 Node CLI 处理，绝不遮蔽既有子命令。
    """
    if not raw_args:
        return None
    argv = [str(a).strip() for a in raw_args if str(a).strip()]
    if len(argv) < 2:
        return None  # 裸 `docs` → 交给 Node（默认走 quickstart）
    if argv[0].lower() != "docs":
        return None
    if argv[1].lower() in _BUILD_SUBCOMMANDS:
        return argv[2:]
    return None


def _candidate_site_roots(bundled_root: Path | None):
    """产出可能的「文档站根」候选（内含 scripts/docs/build_docs_site.js）。

    顺序 = 可信度：调用方注入的 bundled_root（规范解析）> 安装布局相邻的 khy_os/bundled
    > 源码开发树仓库根。返回去重后的存在候选路径列表。
    """
    cands = []
    if bundled_root is not None:
        cands.append(Path(bundled_root))

    here = Path(__file__).resolve()
    # 安装布局：site-packages/khy_platform/docs_site.py 与 site-packages/khy_os/bundled/ 平级。
    # parents[0]=khy_platform, parents[1]=site-packages。
    if len(here.parents) >= 2:
        cands.append(here.parents[1] / "khy_os" / "bundled")
    # 源码开发树：platform/khy_platform/docs_site.py → parents[2]=仓库根。
    if len(here.parents) >= 3:
        cands.append(here.parents[2])

    seen = set()
    out = []
    for c in cands:
        try:
            key = str(c.resolve())
        except Exception:
            key = str(c)
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def _resolve_generator(bundled_root: Path | None):
    """在候选站点根里找到第一个存在的 build_docs_site.js，返回其 Path 或 None。"""
    for root in _candidate_site_roots(bundled_root):
        script = root.joinpath(*_GENERATOR_REL)
        try:
            if script.is_file():
                return script
        except Exception:
            continue
    return None


def _resolve_node(node_cmd: str | None):
    """确定可用的 node 可执行名。

    优先复用 cli.check_node()（含便携版自动置备），懒加载以避免模块级循环依赖；
    失败再回退到 PATH 查找。返回可执行名或 None。测试可直接注入 node_cmd。
    """
    if node_cmd:
        return node_cmd
    try:
        from khy_platform.cli import check_node  # 懒加载：cli 此时已完成初始化
        resolved = check_node()
        if resolved:
            return resolved
    except SystemExit:
        # check_node 在版本过低时会 sys.exit(1)；此处交由回退查找，仍给出人话提示。
        pass
    except Exception:
        pass
    for cmd in ("node", "node.exe"):
        if shutil.which(cmd):
            return cmd
    return None


def _print_node_missing_hint():
    print("错误：未找到 Node.js，无法重新生成文档站。", file=sys.stderr)
    print("真实原因：文档站生成器是 Node 脚本（离线、无新增依赖），需要 Node.js >= 20。", file=sys.stderr)
    print("解决方法：", file=sys.stderr)
    print("  1. 安装 Node.js >= 20（https://nodejs.org），或运行 `khy doctor` 自动置备便携版。", file=sys.stderr)
    print("  2. 重新运行：khy docs build", file=sys.stderr)


def run_docs_build_cli(args, bundled_root: Path | None = None, node_cmd: str | None = None) -> int:
    """重新生成安装目录内的离线文档站。

    参数：
      args         —— `docs build` 之后的剩余参数（支持 --verify 跟跑验证门、-h/--help）。
      bundled_root —— 站点根（通常由 cli._find_bundled_root() 传入）；None 则路径启发式回退。
      node_cmd     —— node 可执行名（测试注入用）；None 则自动解析。

    返回进程退出码：0 成功，非 0 失败。全程 fail-soft，绝不抛栈。
    """
    args = list(args or [])
    if any(a in ("-h", "--help", "help") for a in args):
        print("用法：khy docs build [--verify]")
        print("  在安装目录内重新生成离线文档站（把每个 .md 渲染成同名 .html + 侧栏数据），")
        print("  使侧栏/首页跳转与本机实际随包内容一致。--verify 额外跟跑站点校验门。")
        return 0

    script = _resolve_generator(bundled_root)
    if script is None:
        print("错误：找不到文档站生成器 scripts/docs/build_docs_site.js。", file=sys.stderr)
        print("真实原因：安装目录不完整，或未定位到 bundled 载荷。", file=sys.stderr)
        print("解决方法：pip install --force-reinstall --no-cache-dir khy-os", file=sys.stderr)
        return 1

    node = _resolve_node(node_cmd)
    if node is None:
        _print_node_missing_hint()
        return 1

    # 生成器 ROOT 自解析为 script 的上两级（站点根）；cwd 设为该根，与构建时行为一致。
    site_root = script.resolve().parents[2]

    print(f"[docs build] 正在重新生成文档站（站点根：{site_root}）…")
    try:
        result = subprocess.run(
            [node, str(script), "--quiet"],
            cwd=str(site_root),
            timeout=600,
        )
    except FileNotFoundError:
        _print_node_missing_hint()
        return 1
    except Exception as e:
        print(f"错误：文档站生成失败：{e}", file=sys.stderr)
        return 1

    if result.returncode != 0:
        print(f"错误：文档站生成器退出码非零（{result.returncode}）。", file=sys.stderr)
        return result.returncode

    print("[docs build] 完成：文档站已重新生成，侧栏/首页跳转与本机内容一致。")

    if "--verify" in args:
        verifier = site_root.joinpath(*_VERIFIER_REL)
        if not verifier.is_file():
            print(f"  [WARN] 跳过校验：未找到 {verifier}", file=sys.stderr)
            return 0
        print("[docs build] 正在校验文档站…")
        try:
            vres = subprocess.run([node, str(verifier)], cwd=str(site_root), timeout=600)
        except Exception as e:
            print(f"  [WARN] 校验执行失败：{e}", file=sys.stderr)
            return 0
        if vres.returncode != 0:
            print(f"错误：文档站校验未通过（退出码 {vres.returncode}）。", file=sys.stderr)
            return vres.returncode
        print("[docs build] 校验通过。")

    return 0
