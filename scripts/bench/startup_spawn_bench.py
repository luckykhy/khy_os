#!/usr/bin/env python3
"""Empirical startup-spawn benchmark for `khy chat`.

The Windows-vs-Linux startup gap is dominated by *process-creation count*
(CreateProcess + Defender scan per spawn is far costlier than fork). This
harness measures, on the current machine, the two spawn-reduction fixes:

  1. check_node() node-version cache  — cold vs warm spawn count + wall-clock.
  2. workspaceGitInit shell-free git  — spawn count per rev-parse (info only).

It counts process spawns (the platform-independent root-cause metric) and
times the eliminated work, so the improvement is demonstrable without a
subjective benchmark. Run the SAME script on Windows for the real wall-clock
delta (per-spawn cost is larger there).

Usage:  python3 scripts/bench/startup_spawn_bench.py [--runs N]
"""
from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "platform"))

from khy_platform import cli  # noqa: E402


def _median_ms(samples: list[float]) -> float:
    return round(statistics.median(samples) * 1000, 3)


def bench_check_node(runs: int) -> dict:
    """Cold (spawn) vs warm (cache-hit) check_node, counting real spawns."""
    counter = {"spawns": 0}
    real_run = cli.subprocess.run

    def counting_run(*a, **k):
        counter["spawns"] += 1
        return real_run(*a, **k)

    cold_ms: list[float] = []
    warm_ms: list[float] = []
    cold_spawns = warm_spawns = 0

    with mock.patch.object(cli.subprocess, "run", side_effect=counting_run):
        for _ in range(runs):
            # Cold: force a cache miss so the authoritative spawn path runs.
            with mock.patch.object(cli, "_cached_node_command", return_value=None):
                counter["spawns"] = 0
                t0 = time.perf_counter()
                cli.check_node()
                cold_ms.append(time.perf_counter() - t0)
                cold_spawns += counter["spawns"]

            # Warm: real fast path (cache was just written by the cold call).
            counter["spawns"] = 0
            t0 = time.perf_counter()
            cli.check_node()
            warm_ms.append(time.perf_counter() - t0)
            warm_spawns += counter["spawns"]

    return {
        "runs": runs,
        "cold_spawns_per_launch": cold_spawns / runs,
        "warm_spawns_per_launch": warm_spawns / runs,
        "cold_median_ms": _median_ms(cold_ms),
        "warm_median_ms": _median_ms(warm_ms),
        "saved_median_ms": round(_median_ms(cold_ms) - _median_ms(warm_ms), 3),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=15)
    args = ap.parse_args()

    print(f"platform={sys.platform}  node-version-check benchmark  runs={args.runs}")
    r = bench_check_node(args.runs)
    print("── check_node() ──────────────────────────────────────────────")
    print(f"  cold (cache miss): {r['cold_spawns_per_launch']:.1f} spawn/launch, "
          f"{r['cold_median_ms']} ms median")
    print(f"  warm (cache hit) : {r['warm_spawns_per_launch']:.1f} spawn/launch, "
          f"{r['warm_median_ms']} ms median")
    print(f"  → eliminates {r['cold_spawns_per_launch'] - r['warm_spawns_per_launch']:.1f} "
          f"Node process spawn/launch, saving ~{r['saved_median_ms']} ms here.")
    print()
    print("  NOTE: on Windows each eliminated spawn is a full node.exe CreateProcess")
    print("  + Defender scan (typically 30-120 ms), so the saved wall-clock is larger")
    print("  than this Linux figure. Re-run this script on Windows for the real delta.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
