# @pattern Command, Template Method
"""Data collector for ML training data."""

from __future__ import annotations

import os
import sys
from datetime import datetime
from typing import Dict, List

import numpy as np
import pandas as pd

# Add parent directory to path for compatibility with existing scripts.
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class DataCollector:
    """Collects historical market data or generates fallback synthetic data."""

    def __init__(self, db_config: Dict[str, str] | None = None) -> None:
        self.db_config = db_config or self._get_default_db_config()

    def _get_default_db_config(self) -> Dict[str, str]:
        return {
            "host": "localhost",
            "port": 5432,
            "database": "khy_quant",
            "user": "postgres",
            # 登记:示范占位值,非真实凭据(本仓主路径用合成数据,DB 配置仅占位;
            # 真实部署应经 env 注入 PG_USER/PG_PASSWORD)。pragma: allowlist secret
            "password": "postgres",  # pragma: allowlist secret
        }

    def collect_historical_data(self, days: int = 365) -> pd.DataFrame:
        """Collect historical data for model training."""
        print(f"[DataCollector] collecting recent {days} days of data...")

        # Placeholder: use synthetic generation in this repository build.
        data = self._generate_sample_data(days)

        print(f"[DataCollector] collected rows={len(data)}")
        return data

    def _generate_sample_data(self, days: int) -> pd.DataFrame:
        """Generate coherent synthetic OHLCV and indicators for offline training."""
        rng = np.random.default_rng(42)

        end_date = pd.Timestamp(datetime.now().date())
        dates = pd.bdate_range(end=end_date, periods=max(days, 90))
        stock_codes = [f"sh{600000 + i:06d}" for i in range(100)]

        all_frames: List[pd.DataFrame] = []

        for code in stock_codes:
            n = len(dates)
            base_price = rng.uniform(10, 120)

            overnight = rng.normal(0.0, 0.008, n)
            intraday = rng.normal(0.0005, 0.02, n)

            close = np.zeros(n)
            open_ = np.zeros(n)
            high = np.zeros(n)
            low = np.zeros(n)
            volume = np.zeros(n)

            close_prev = base_price
            for i in range(n):
                open_i = max(1.0, close_prev * (1.0 + overnight[i]))
                close_i = max(1.0, open_i * (1.0 + intraday[i]))
                wick_up = abs(rng.normal(0.01, 0.01))
                wick_down = abs(rng.normal(0.01, 0.01))
                high_i = max(open_i, close_i) * (1.0 + wick_up)
                low_i = min(open_i, close_i) * (1.0 - wick_down)
                vol_i = max(100000.0, rng.lognormal(mean=15.0, sigma=0.55))

                open_[i] = open_i
                close[i] = close_i
                high[i] = max(high_i, open_i, close_i)
                low[i] = min(low_i, open_i, close_i)
                volume[i] = vol_i

                close_prev = close_i

            df = pd.DataFrame(
                {
                    "date": dates,
                    "stock_code": code,
                    "open": open_,
                    "high": high,
                    "low": low,
                    "close": close,
                    "volume": volume,
                }
            )

            df["amount"] = df["close"] * df["volume"]
            df["ma5"] = df["close"].rolling(5, min_periods=1).mean()
            df["ma10"] = df["close"].rolling(10, min_periods=1).mean()
            df["ma20"] = df["close"].rolling(20, min_periods=1).mean()
            df["ma60"] = df["close"].rolling(60, min_periods=1).mean()

            ema12 = df["close"].ewm(span=12, adjust=False).mean()
            ema26 = df["close"].ewm(span=26, adjust=False).mean()
            macd_line = ema12 - ema26
            macd_signal = macd_line.ewm(span=9, adjust=False).mean()
            df["macd"] = macd_line
            df["macd_signal"] = macd_signal
            df["macd_hist"] = macd_line - macd_signal

            delta = df["close"].diff()
            gain = delta.clip(lower=0).rolling(14, min_periods=2).mean()
            loss = (-delta.clip(upper=0)).rolling(14, min_periods=2).mean()
            rs = gain / loss.replace(0, np.nan)
            df["rsi"] = 100 - (100 / (1 + rs))
            df["rsi"] = df["rsi"].fillna(50)

            low14 = df["low"].rolling(9, min_periods=1).min()
            high14 = df["high"].rolling(9, min_periods=1).max()
            rsv = (df["close"] - low14) / (high14 - low14).replace(0, np.nan) * 100
            df["kdj_k"] = rsv.ewm(alpha=1 / 3, adjust=False).mean().fillna(50)
            df["kdj_d"] = df["kdj_k"].ewm(alpha=1 / 3, adjust=False).mean().fillna(50)
            df["kdj_j"] = 3 * df["kdj_k"] - 2 * df["kdj_d"]

            # Synthetic valuation factors with slight relationship to trend/volatility.
            trend = df["close"].pct_change(20).fillna(0)
            vol = df["close"].pct_change().rolling(20, min_periods=2).std().fillna(0)
            df["pe_ratio"] = (15 + trend * 30 + rng.normal(0, 4, n)).clip(2, 80)
            df["pb_ratio"] = (2 + trend * 4 + rng.normal(0, 0.8, n)).clip(0.2, 20)
            df["roe"] = (10 + trend * 15 - vol * 120 + rng.normal(0, 2.5, n)).clip(-10, 45)

            future_close_5 = df["close"].shift(-5)
            ret_5d = (future_close_5 - df["close"]) / df["close"]
            future_close_10 = df["close"].shift(-10)
            ret_10d = (future_close_10 - df["close"]) / df["close"]

            df["return_5d"] = (ret_5d * 100).fillna(0)
            df["label_5d"] = (ret_5d > 0).astype(int)
            df["label_10d"] = (ret_10d > 0).astype(int)

            all_frames.append(df)

        out = pd.concat(all_frames, ignore_index=True)
        out = out.sort_values(["stock_code", "date"]).reset_index(drop=True)
        return out

    def save_data(self, data: pd.DataFrame, filepath: str | os.PathLike[str]) -> None:
        os.makedirs(os.path.dirname(str(filepath)), exist_ok=True)
        data.to_csv(filepath, index=False)
        print(f"[DataCollector] data saved to: {filepath}")

    def load_data(self, filepath: str | os.PathLike[str]) -> pd.DataFrame:
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"data file not found: {filepath}")
        data = pd.read_csv(filepath)
        print(f"[DataCollector] loaded rows={len(data)}")
        return data


if __name__ == "__main__":
    collector = DataCollector()
    data = collector.collect_historical_data(days=365)
    collector.save_data(data, "./data/training_data.csv")

    print("\n[DataCollector] complete")
    print(f"shape={data.shape}")
    print(data.head())
