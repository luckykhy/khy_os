# @pattern Template Method
"""Support for python -m khy_platform."""
import sys

try:
    from khy_platform.cli import main
except ImportError as e:
    print(f"\nError: {e}", file=sys.stderr)
    print("\nThe khy OS package appears to be installed incorrectly.", file=sys.stderr)
    print("This usually happens when pip cannot download build dependencies.", file=sys.stderr)
    print("\nFix: Run these two commands first, then reinstall:", file=sys.stderr)
    print("  pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/", file=sys.stderr)
    print("  pip config set global.trusted-host mirrors.aliyun.com", file=sys.stderr)
    print("\nThen reinstall:", file=sys.stderr)
    print("  pip install --force-reinstall khy-os", file=sys.stderr)
    print("  Fallback: pip install --force-reinstall khy-quant", file=sys.stderr)
    sys.exit(1)

main()
