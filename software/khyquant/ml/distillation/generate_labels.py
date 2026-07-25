# @pattern Template Method
"""Generate distilled labels for stock samples using an LLM teacher."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple
from urllib import error, request

DEFAULT_BASE_URL = "https://ai.mindflow.com.cn/v1"
DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_TIMEOUT_SECONDS = 30
MAX_REASONING_LEN = 1000


def _load_env_file(env_path: Path) -> None:
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def bootstrap_env() -> None:
    current = Path(__file__).resolve()
    backend_dir = current.parents[2]
    _load_env_file(backend_dir / ".env")
    _load_env_file(backend_dir / ".env.ml-config")


def resolve_api_key() -> Optional[str]:
    candidate_keys = [
        "MINDFLOW_API_KEY",
        "MINDFLOW_TOKEN",
        "MIND_FLOW_API_KEY",
        "OPENAI_API_KEY",
        "LLM_API_KEY",
        "AI_API_KEY",
    ]
    for key in candidate_keys:
        value = os.getenv(key)
        if value:
            return value
    return None


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, "", "null"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def build_sample_prompt(sample: Dict[str, Any]) -> str:
    open_price = _safe_float(sample.get("open"))
    high = _safe_float(sample.get("high"))
    low = _safe_float(sample.get("low"))
    close = _safe_float(sample.get("close"))
    ma5 = _safe_float(sample.get("ma5"))
    ma10 = _safe_float(sample.get("ma10"))
    ma20 = _safe_float(sample.get("ma20"))
    ma60 = _safe_float(sample.get("ma60"))
    macd = _safe_float(sample.get("macd"))
    macd_signal = _safe_float(sample.get("macd_signal"))
    macd_hist = _safe_float(sample.get("macd_hist"))
    rsi = _safe_float(sample.get("rsi"), default=50.0)
    kdj_k = _safe_float(sample.get("kdj_k"), default=50.0)
    kdj_d = _safe_float(sample.get("kdj_d"), default=50.0)
    kdj_j = _safe_float(sample.get("kdj_j"), default=50.0)
    volume = _safe_float(sample.get("volume"))
    pe_ratio = _safe_float(sample.get("pe_ratio"))
    pb_ratio = _safe_float(sample.get("pb_ratio"))
    roe = _safe_float(sample.get("roe"))

    return f"""
Analyze this stock snapshot and output a trading signal for the next 3-5 trading days.

Sample:
- date: {_safe_text(sample.get('date'), 'unknown')}
- stock_code: {_safe_text(sample.get('stock_code'), 'unknown')}
- OHLC: open={open_price:.4f}, high={high:.4f}, low={low:.4f}, close={close:.4f}
- Moving averages: ma5={ma5:.4f}, ma10={ma10:.4f}, ma20={ma20:.4f}, ma60={ma60:.4f}
- MACD: macd={macd:.5f}, macd_signal={macd_signal:.5f}, macd_hist={macd_hist:.5f}
- RSI: {rsi:.2f}
- KDJ: K={kdj_k:.2f}, D={kdj_d:.2f}, J={kdj_j:.2f}
- volume: {volume:.2f}
- valuation: pe_ratio={pe_ratio:.3f}, pb_ratio={pb_ratio:.3f}, roe={roe:.3f}

Rules:
1) signal must be one of: buy, sell, hold.
2) confidence must be a float in [0, 1].
3) reasoning should be concise and evidence-based.
4) Return STRICT JSON only with keys: signal, confidence, reasoning.
""".strip()


def _extract_text_payload(response_json: Dict[str, Any]) -> str:
    choices = response_json.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""

    message = choices[0].get("message", {})
    content = message.get("content", "")
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text", "")))
            else:
                parts.append(str(item))
        return "".join(parts).strip()
    return str(content).strip()


def _extract_json_block(text: str) -> Dict[str, Any]:
    if not text:
        raise ValueError("empty LLM response")

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        raise ValueError(f"could not parse JSON from LLM output: {text[:160]}")

    return json.loads(match.group(0))


def _normalize_signal(raw: Any) -> str:
    signal = _safe_text(raw, "hold").lower()
    aliases = {
        "bullish": "buy",
        "long": "buy",
        "buy": "buy",
        "bearish": "sell",
        "short": "sell",
        "sell": "sell",
        "neutral": "hold",
        "wait": "hold",
        "hold": "hold",
    }
    return aliases.get(signal, "hold")


def _to_binary_label(signal: str) -> int:
    return 1 if signal == "buy" else 0


def heuristic_teacher_label(sample: Dict[str, Any]) -> Tuple[str, float, str]:
    ma5 = _safe_float(sample.get("ma5"))
    ma20 = _safe_float(sample.get("ma20"))
    macd = _safe_float(sample.get("macd"))
    rsi = _safe_float(sample.get("rsi"), default=50.0)

    bullish = ma5 > ma20 and macd > 0 and rsi < 70
    bearish = ma5 < ma20 and macd < 0 and rsi > 30

    if bullish:
        return (
            "buy",
            0.62,
            "Heuristic fallback: short MA above long MA with positive momentum and non-extreme RSI.",
        )
    if bearish:
        return (
            "sell",
            0.62,
            "Heuristic fallback: short MA below long MA with negative momentum and no oversold rebound signal.",
        )
    return (
        "hold",
        0.55,
        "Heuristic fallback: mixed technical signals without a clear directional edge.",
    )


def call_teacher_api(
    *,
    sample: Dict[str, Any],
    api_key: str,
    base_url: str,
    model: str,
    timeout_seconds: int,
    retries: int,
) -> Tuple[str, float, str]:
    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    prompt = build_sample_prompt(sample)

    system_prompt = (
        "You are a disciplined quant research teacher model for label distillation. "
        "Always return strict JSON with keys signal, confidence, reasoning."
    )

    payload: Dict[str, Any] = {
        "model": model,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "response_format": {"type": "json_object"},
    }

    last_error: Optional[str] = None

    for attempt in range(1, retries + 1):
        body = json.dumps(payload).encode("utf-8")
        req = request.Request(
            endpoint,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )

        try:
            with request.urlopen(req, timeout=timeout_seconds) as response:
                response_json = json.loads(response.read().decode("utf-8"))

            content = _extract_text_payload(response_json)
            parsed = _extract_json_block(content)
            signal = _normalize_signal(parsed.get("signal"))
            confidence = max(0.0, min(1.0, _safe_float(parsed.get("confidence"), 0.5)))
            reasoning = _safe_text(parsed.get("reasoning"), "")[:MAX_REASONING_LEN]

            if not reasoning:
                reasoning = "Model provided a valid signal without additional rationale."

            return signal, confidence, reasoning

        except error.HTTPError as exc:
            error_body = ""
            try:
                error_body = exc.read().decode("utf-8")
            except Exception:
                error_body = "<unreadable error body>"

            last_error = f"HTTP {exc.code}: {error_body[:300]}"
            if exc.code == 400 and "response_format" in error_body:
                # Some compatible endpoints do not support response_format.
                payload.pop("response_format", None)
            time.sleep(min(2.0, attempt * 0.3))
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            time.sleep(min(2.0, attempt * 0.3))

    raise RuntimeError(last_error or "LLM request failed with unknown error")


def iter_csv_rows(path: Path) -> Iterable[Dict[str, Any]]:
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            yield row


def load_completed_sample_ids(output_path: Path) -> set[int]:
    if not output_path.exists():
        return set()

    completed_ids: set[int] = set()
    with output_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                completed_ids.add(int(row.get("sample_id", "")))
            except ValueError:
                continue
    return completed_ids


def generate_labels(
    *,
    input_csv: Path,
    output_csv: Path,
    base_url: str,
    model: str,
    timeout_seconds: int,
    retries: int,
    sleep_seconds: float,
    max_samples: Optional[int],
    resume: bool,
    fallback_on_error: bool,
) -> None:
    api_key = resolve_api_key()
    if not api_key:
        if not fallback_on_error:
            raise RuntimeError(
                "No API key found. Set MINDFLOW_API_KEY (or OPENAI_API_KEY) in environment."
            )
        print("[generate_labels] API key missing. Falling back to heuristic teacher labels.")

    output_csv.parent.mkdir(parents=True, exist_ok=True)
    completed_ids = load_completed_sample_ids(output_csv) if resume else set()

    fieldnames = [
        "sample_id",
        "date",
        "stock_code",
        "teacher_signal",
        "teacher_confidence",
        "teacher_reasoning",
        "distilled_label",
        "source",
    ]

    should_write_header = not output_csv.exists() or not resume
    mode = "a" if resume and output_csv.exists() else "w"

    processed = 0
    skipped = 0

    with output_csv.open(mode, encoding="utf-8", newline="") as out_f:
        writer = csv.DictWriter(out_f, fieldnames=fieldnames)
        if should_write_header:
            writer.writeheader()

        for sample_id, sample in enumerate(iter_csv_rows(input_csv)):
            if sample_id in completed_ids:
                skipped += 1
                continue

            if max_samples is not None and processed >= max_samples:
                break

            if api_key:
                try:
                    signal, confidence, reasoning = call_teacher_api(
                        sample=sample,
                        api_key=api_key,
                        base_url=base_url,
                        model=model,
                        timeout_seconds=timeout_seconds,
                        retries=retries,
                    )
                    source = "llm"
                except Exception as exc:  # noqa: BLE001
                    if not fallback_on_error:
                        raise
                    signal, confidence, reasoning = heuristic_teacher_label(sample)
                    source = f"heuristic_fallback_after_llm_error:{str(exc)[:120]}"
            else:
                signal, confidence, reasoning = heuristic_teacher_label(sample)
                source = "heuristic"

            writer.writerow(
                {
                    "sample_id": sample_id,
                    "date": _safe_text(sample.get("date")),
                    "stock_code": _safe_text(sample.get("stock_code")),
                    "teacher_signal": signal,
                    "teacher_confidence": round(confidence, 6),
                    "teacher_reasoning": reasoning,
                    "distilled_label": _to_binary_label(signal),
                    "source": source,
                }
            )
            out_f.flush()

            processed += 1
            if processed % 50 == 0:
                print(f"[generate_labels] processed={processed}, skipped={skipped}")

            if sleep_seconds > 0:
                time.sleep(sleep_seconds)

    print(
        f"[generate_labels] done. output={output_csv} processed={processed} skipped={skipped}"
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate distilled labels with an LLM teacher")
    parser.add_argument(
        "--input",
        dest="input_csv",
        default=str(Path(__file__).resolve().parents[1] / "data" / "training_data.csv"),
        help="Path to source training_data.csv",
    )
    parser.add_argument(
        "--output",
        dest="output_csv",
        default=str(Path(__file__).resolve().parents[1] / "data" / "distilled_labels.csv"),
        help="Path to output distilled_labels.csv",
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("MINDFLOW_BASE_URL", DEFAULT_BASE_URL),
        help="LLM API base URL",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("MINDFLOW_MODEL", DEFAULT_MODEL),
        help="LLM model name",
    )
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--sleep", type=float, default=0.0)
    parser.add_argument("--max-samples", type=int, default=None)
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from existing output file and skip existing sample_id rows",
    )
    parser.add_argument(
        "--no-fallback",
        action="store_true",
        help="Disable heuristic fallback and fail on API/key errors",
    )
    return parser


def main() -> None:
    bootstrap_env()
    parser = build_arg_parser()
    args = parser.parse_args()

    generate_labels(
        input_csv=Path(args.input_csv),
        output_csv=Path(args.output_csv),
        base_url=args.base_url,
        model=args.model,
        timeout_seconds=args.timeout,
        retries=args.retries,
        sleep_seconds=args.sleep,
        max_samples=args.max_samples,
        resume=args.resume,
        fallback_on_error=not args.no_fallback,
    )


if __name__ == "__main__":
    main()
