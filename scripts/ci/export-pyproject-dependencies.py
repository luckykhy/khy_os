#!/usr/bin/env python3
# @pattern Template Method

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import tomllib


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Export base project dependencies from pyproject.toml to requirements format.'
    )
    parser.add_argument(
        '--pyproject',
        default='pyproject.toml',
        help='Path to pyproject.toml (default: pyproject.toml).',
    )
    parser.add_argument(
        '--output',
        default='-',
        help='Output requirements file path, or - for stdout (default: -).',
    )
    return parser.parse_args()


def load_dependencies(pyproject_path: Path) -> list[str]:
    if not pyproject_path.exists():
        raise FileNotFoundError(f'pyproject file not found: {pyproject_path}')

    data = tomllib.loads(pyproject_path.read_text(encoding='utf-8'))
    project = data.get('project') or {}
    deps = project.get('dependencies') or []

    if not isinstance(deps, list):
        raise ValueError('project.dependencies must be a list')

    normalized = [str(dep).strip() for dep in deps if str(dep).strip()]
    return normalized


def write_output(dependencies: list[str], output_path: str) -> None:
    content = '\n'.join(dependencies) + ('\n' if dependencies else '')

    if output_path == '-':
        sys.stdout.write(content)
        return

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(content, encoding='utf-8')


def main() -> int:
    args = parse_args()
    pyproject = Path(args.pyproject)

    try:
        dependencies = load_dependencies(pyproject)
    except Exception as exc:  # noqa: BLE001
        print(f'[export-pyproject-dependencies] {exc}', file=sys.stderr)
        return 1

    if not dependencies:
        print('[export-pyproject-dependencies] No dependencies found in project.dependencies.', file=sys.stderr)
        return 1

    write_output(dependencies, args.output)
    print(f'Exported {len(dependencies)} dependency entries from {pyproject}.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
