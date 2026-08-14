#!/usr/bin/env python3
# @pattern Template Method, Visitor

from __future__ import annotations

import os
import py_compile
import sys
from pathlib import Path

ROOT = Path.cwd()
DEFAULT_TARGETS = ['platform/khy_platform', 'software/khyquant', 'services/backend', 'services/ai-backend', 'scripts']
IGNORE_DIRS = {
    '.git',
    'node_modules',
    'dist',
    'build',
    '.cache',
    '.tmp',
    'coverage',
    '__pycache__',
    'khy_os.egg-info',
    'android',
    'android-sdk',
}


def should_ignore(path: Path) -> bool:
    return any(part in IGNORE_DIRS for part in path.parts)


def collect_python_files(targets: list[str]) -> list[Path]:
    out: list[Path] = []
    for target in targets:
        target_path = (ROOT / target).resolve()
        if not target_path.exists():
            continue

        if target_path.is_file() and target_path.suffix == '.py':
            rel = target_path.relative_to(ROOT)
            if not should_ignore(rel):
                out.append(rel)
            continue

        for dirpath, dirnames, filenames in os.walk(target_path):
            rel_dir = Path(dirpath).resolve().relative_to(ROOT)
            dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
            if should_ignore(rel_dir):
                continue

            for filename in filenames:
                if not filename.endswith('.py'):
                    continue
                rel_file = rel_dir / filename
                if should_ignore(rel_file):
                    continue
                out.append(rel_file)

    deduped = sorted(set(out))
    return deduped


def is_placeholder_template(rel_file: Path) -> bool:
    lower_parts = [part.lower() for part in rel_file.parts]
    if not any('template' in part for part in lower_parts):
        return False

    abs_file = ROOT / rel_file
    try:
        text = abs_file.read_text(encoding='utf-8')
    except OSError:
        return False

    return '{{' in text and '}}' in text


def main() -> int:
    targets = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_TARGETS
    raw_files = collect_python_files(targets)
    skipped_templates = [rel_file for rel_file in raw_files if is_placeholder_template(rel_file)]
    files = [rel_file for rel_file in raw_files if rel_file not in skipped_templates]

    if not files:
        print('No Python files found for syntax check.')
        return 0

    failed = 0
    for rel_file in files:
        abs_file = ROOT / rel_file
        try:
            py_compile.compile(str(abs_file), doraise=True)
        except py_compile.PyCompileError as error:
            failed += 1
            print(f'\n[python-syntax-error] {rel_file}', file=sys.stderr)
            print(str(error), file=sys.stderr)

    print(f'Checked {len(files)} Python files.')
    if skipped_templates:
        print(
            f'Skipped {len(skipped_templates)} placeholder template file(s): '
            + ', '.join(str(item) for item in skipped_templates)
        )
    if failed > 0:
        print(
            f'Python syntax check failed: {failed} file(s) contain syntax errors.',
            file=sys.stderr,
        )
        return 1

    print('Python syntax check passed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
