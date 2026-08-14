# @pattern Command, Template Method
"""Offline retraining pipeline for six ML agents.

Run:
    python3 backend/ml/retrain_distilled.py --skip-distill
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict

from data_collector import DataCollector
from trainer import AgentTrainer


def ensure_training_data(path: Path, days: int, force_collect: bool) -> None:
    collector = DataCollector()
    if force_collect or not path.exists():
        print(f"[pipeline] collecting training data (days={days})")
        data = collector.collect_historical_data(days=days)
        collector.save_data(data, path)
    else:
        print(f"[pipeline] using existing training data: {path}")


def train_baseline_and_offline_teacher(
    training_data_path: Path,
    models_dir: Path,
    distillation_rounds: int,
) -> Dict[str, Any]:
    print("[pipeline] training baseline models (hard labels)")
    baseline_trainer = AgentTrainer()
    baseline = baseline_trainer.train_from_files(
        data_path=training_data_path,
        save_dir=models_dir,
        save_suffix="latest",
        use_offline_teacher=False,
        distillation_rounds=1,
    )

    print("[pipeline] training smarter offline-teacher models")
    teacher_trainer = AgentTrainer()
    distilled = teacher_trainer.train_from_files(
        data_path=training_data_path,
        save_dir=models_dir,
        save_suffix="distilled_latest",
        use_offline_teacher=True,
        distillation_rounds=distillation_rounds,
    )

    return {
        "baseline": baseline,
        "distilled": distilled,
    }


def print_comparison(report: Dict[str, Any]) -> None:
    baseline = report["baseline"]
    distilled = report["distilled"]

    base_acc = baseline.get("average_accuracy", 0.0)
    dist_acc = distilled.get("average_accuracy", 0.0)
    delta = dist_acc - base_acc

    base_meta = baseline.get("meta_metrics", {}).get("accuracy", 0.0)
    dist_meta = distilled.get("meta_metrics", {}).get("accuracy", 0.0)

    print("\n" + "=" * 92)
    print("Offline Teacher Accuracy Comparison")
    print("=" * 92)
    print(f"baseline_average_accuracy   : {base_acc:.4f}")
    print(f"distilled_average_accuracy  : {dist_acc:.4f}")
    print(f"average_accuracy_delta      : {delta:+.4f}")
    print(f"baseline_meta_accuracy      : {base_meta:.4f}")
    print(f"distilled_meta_accuracy     : {dist_meta:.4f}")
    print(f"meta_accuracy_delta         : {dist_meta - base_meta:+.4f}")

    print("\nPer-agent metrics:")
    for agent in sorted(distilled.get("metrics", {}).keys()):
        b = baseline.get("metrics", {}).get(agent, {})
        d = distilled.get("metrics", {}).get(agent, {})
        b_acc = b.get("accuracy", 0.0)
        d_acc = d.get("accuracy", 0.0)
        print(f"- {agent}: baseline={b_acc:.4f}, distilled={d_acc:.4f}, delta={d_acc - b_acc:+.4f}")

    rounds = distilled.get("round_history", [])
    if rounds:
        print("\nDistillation rounds:")
        for row in rounds:
            r = int(row.get("round", 0))
            print(
                f"- round {r}: avg_accuracy={row.get('average_accuracy', 0.0):.4f}, "
                f"teacher_confidence={row.get('teacher_confidence', 0.0):.4f}"
            )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Retrain all 6 agents using offline ensemble teacher + temporal supervision"
    )
    parser.add_argument("--days", type=int, default=365, help="days to collect when data is missing")
    parser.add_argument("--force-collect", action="store_true", help="force data recollection")
    parser.add_argument(
        "--skip-distill",
        action="store_true",
        help="compatibility flag (offline pipeline always skips API distillation)",
    )
    parser.add_argument(
        "--distillation-rounds",
        type=int,
        default=3,
        help="iterative offline teacher rounds (recommended: 2-3)",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    training_data_path = root / "data" / "training_data.csv"
    models_dir = root / "models"

    ensure_training_data(training_data_path, days=args.days, force_collect=args.force_collect)

    if args.skip_distill:
        print("[pipeline] --skip-distill received: no API distillation will be performed")

    report = train_baseline_and_offline_teacher(
        training_data_path=training_data_path,
        models_dir=models_dir,
        distillation_rounds=max(1, int(args.distillation_rounds)),
    )

    output_path = models_dir / "distillation_report_latest.json"
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print_comparison(report)
    print(f"\nSaved report: {output_path}")
    print("Artifacts saved:")
    print("- 6 baseline models: *_latest.joblib")
    print("- 6 offline-teacher models: *_distilled_latest.joblib")
    print("- baseline meta model: ensemble_meta_latest.joblib")
    print("- distilled meta model: ensemble_meta_distilled_latest.joblib")


if __name__ == "__main__":
    main()
