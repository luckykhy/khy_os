# @pattern Template Method
"""Feature engineering utilities for training and online inference."""

from __future__ import annotations

import warnings
from typing import List

import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")


class FeatureEngineer:
    """Builds model-ready features from raw stock snapshots."""

    def __init__(self) -> None:
        self.scaler = StandardScaler()

    def engineer_features(self, data: pd.DataFrame) -> pd.DataFrame:
        """Main feature engineering pipeline."""
        print("[FeatureEngineer] Starting feature engineering...")
        df = data.copy()

        if "date" in df.columns:
            df["date"] = pd.to_datetime(df["date"], errors="coerce")

        df = self._ensure_base_columns(df)
        df = self._sort_for_timeseries(df)

        df = self._add_price_features(df)
        df = self._add_technical_features(df)
        df = self._add_trend_features(df)
        df = self._add_volatility_features(df)
        df = self._add_volume_features(df)
        df = self._add_time_features(df)
        df = self._add_cross_features(df)
        df = self._add_advanced_regime_features(df)

        df = df.replace([np.inf, -np.inf], np.nan)

        print(f"[FeatureEngineer] Done. total_columns={len(df.columns)}")
        return df

    def _sort_for_timeseries(self, df: pd.DataFrame) -> pd.DataFrame:
        if "date" in df.columns and "stock_code" in df.columns:
            return df.sort_values(["stock_code", "date"]).reset_index(drop=True)
        if "date" in df.columns:
            return df.sort_values("date").reset_index(drop=True)
        return df.reset_index(drop=True)

    def _ensure_base_columns(self, df: pd.DataFrame) -> pd.DataFrame:
        if "price" not in df.columns and "close" in df.columns:
            df["price"] = df["close"]

        if "amount" not in df.columns:
            if "close" in df.columns and "volume" in df.columns:
                df["amount"] = df["close"].fillna(0) * df["volume"].fillna(0)
            else:
                df["amount"] = 0.0

        numeric_like_cols = [
            "open",
            "high",
            "low",
            "close",
            "price",
            "volume",
            "amount",
            "ma5",
            "ma10",
            "ma20",
            "ma60",
            "macd",
            "macd_signal",
            "macd_hist",
            "rsi",
            "kdj_k",
            "kdj_d",
            "kdj_j",
            "pe_ratio",
            "pb_ratio",
            "roe",
        ]
        for col in numeric_like_cols:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")

        return df

    def _add_price_features(self, df: pd.DataFrame) -> pd.DataFrame:
        if "close" in df.columns and "open" in df.columns:
            open_safe = df["open"].replace(0, np.nan)
            df["price_change"] = (df["close"] - df["open"]) / open_safe * 100

            if "high" in df.columns and "low" in df.columns:
                df["amplitude"] = (df["high"] - df["low"]) / open_safe * 100

            if "high" in df.columns:
                body_top = df[["open", "close"]].max(axis=1)
                df["upper_shadow"] = (df["high"] - body_top) / open_safe * 100

            if "low" in df.columns:
                body_bottom = df[["open", "close"]].min(axis=1)
                df["lower_shadow"] = (body_bottom - df["low"]) / open_safe * 100

        return df

    def _add_technical_features(self, df: pd.DataFrame) -> pd.DataFrame:
        if "macd" in df.columns and "macd_signal" in df.columns:
            df["macd_diff"] = df["macd"] - df["macd_signal"]
            df["macd_cross"] = (df["macd"] > df["macd_signal"]).astype(int)

        if "rsi" in df.columns:
            df["rsi_overbought"] = (df["rsi"] > 70).astype(int)
            df["rsi_oversold"] = (df["rsi"] < 30).astype(int)
            df["rsi_neutral"] = ((df["rsi"] >= 30) & (df["rsi"] <= 70)).astype(int)

        if all(col in df.columns for col in ["kdj_k", "kdj_d", "kdj_j"]):
            df["kdj_cross"] = (df["kdj_k"] > df["kdj_d"]).astype(int)
            df["kdj_overbought"] = (df["kdj_j"] > 100).astype(int)
            df["kdj_oversold"] = (df["kdj_j"] < 0).astype(int)

        return df

    def _add_trend_features(self, df: pd.DataFrame) -> pd.DataFrame:
        if all(col in df.columns for col in ["ma5", "ma10", "ma20"]):
            df["ma_trend_short"] = (df["ma5"] > df["ma10"]).astype(int)
            df["ma_trend_medium"] = (df["ma10"] > df["ma20"]).astype(int)
            df["ma_golden_cross"] = (
                (df["ma5"] > df["ma10"]) & (df["ma10"] > df["ma20"])
            ).astype(int)
            df["ma_death_cross"] = (
                (df["ma5"] < df["ma10"]) & (df["ma10"] < df["ma20"])
            ).astype(int)

        if "close" in df.columns and "ma20" in df.columns:
            ma20_safe = df["ma20"].replace(0, np.nan)
            df["price_to_ma20"] = (df["close"] - df["ma20"]) / ma20_safe * 100

        return df

    def _add_volatility_features(self, df: pd.DataFrame) -> pd.DataFrame:
        if "close" in df.columns:
            if "stock_code" in df.columns:
                df["volatility_5d"] = df.groupby("stock_code")["close"].transform(
                    lambda x: x.pct_change().rolling(5, min_periods=2).std() * 100
                )
                df["volatility_20d"] = df.groupby("stock_code")["close"].transform(
                    lambda x: x.pct_change().rolling(20, min_periods=5).std() * 100
                )
            else:
                returns = df["close"].pct_change()
                df["volatility_5d"] = returns.rolling(5, min_periods=2).std() * 100
                df["volatility_20d"] = returns.rolling(20, min_periods=5).std() * 100

        return df

    def _add_volume_features(self, df: pd.DataFrame) -> pd.DataFrame:
        if "volume" in df.columns:
            if "stock_code" in df.columns:
                df["volume_change"] = df.groupby("stock_code")["volume"].pct_change() * 100
                df["volume_ratio_5d"] = df.groupby("stock_code")["volume"].transform(
                    lambda x: x / x.rolling(5, min_periods=1).mean().replace(0, np.nan)
                )
                df["volume_ratio_20d"] = df.groupby("stock_code")["volume"].transform(
                    lambda x: x / x.rolling(20, min_periods=1).mean().replace(0, np.nan)
                )
            else:
                df["volume_change"] = df["volume"].pct_change() * 100
                df["volume_ratio_5d"] = (
                    df["volume"]
                    / df["volume"].rolling(5, min_periods=1).mean().replace(0, np.nan)
                )
                df["volume_ratio_20d"] = (
                    df["volume"]
                    / df["volume"].rolling(20, min_periods=1).mean().replace(0, np.nan)
                )

        return df

    def _add_time_features(self, df: pd.DataFrame) -> pd.DataFrame:
        if "date" in df.columns:
            df["day_of_week"] = df["date"].dt.dayofweek
            df["day_of_month"] = df["date"].dt.day
            df["month"] = df["date"].dt.month
            df["quarter"] = df["date"].dt.quarter
            df["is_month_start"] = df["date"].dt.is_month_start.astype(int)
            df["is_month_end"] = df["date"].dt.is_month_end.astype(int)

        return df

    def _add_cross_features(self, df: pd.DataFrame) -> pd.DataFrame:
        if "close" in df.columns and "volume" in df.columns:
            df["price_volume"] = df["close"] * df["volume"]

        if "rsi" in df.columns and "macd" in df.columns:
            df["rsi_macd"] = df["rsi"] * df["macd"]

        return df

    def _compute_atr(self, group: pd.DataFrame, period: int = 14) -> pd.Series:
        high = group["high"]
        low = group["low"]
        close = group["close"]
        prev_close = close.shift(1)

        tr = pd.concat(
            [
                (high - low).abs(),
                (high - prev_close).abs(),
                (low - prev_close).abs(),
            ],
            axis=1,
        ).max(axis=1)

        return tr.rolling(period, min_periods=2).mean()

    def _compute_adx(self, group: pd.DataFrame, period: int = 14) -> pd.Series:
        high = group["high"]
        low = group["low"]
        close = group["close"]

        up_move = high.diff()
        down_move = -low.diff()

        plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
        minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

        prev_close = close.shift(1)
        tr = pd.concat(
            [
                (high - low).abs(),
                (high - prev_close).abs(),
                (low - prev_close).abs(),
            ],
            axis=1,
        ).max(axis=1)

        tr_smooth = tr.rolling(period, min_periods=2).mean().replace(0, np.nan)
        plus_di = (
            100
            * pd.Series(plus_dm, index=group.index)
            .rolling(period, min_periods=2)
            .mean()
            / tr_smooth
        )
        minus_di = (
            100
            * pd.Series(minus_dm, index=group.index)
            .rolling(period, min_periods=2)
            .mean()
            / tr_smooth
        )

        dx = (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan) * 100
        return dx.rolling(period, min_periods=2).mean()

    @staticmethod
    def _katz_fractal_dimension(values: np.ndarray) -> float:
        x = np.asarray(values, dtype=float)
        x = x[~np.isnan(x)]
        n = len(x)
        if n < 3:
            return np.nan

        length = np.sum(np.abs(np.diff(x)))
        distance = np.max(np.abs(x - x[0]))
        if length <= 1e-12 or distance <= 1e-12:
            return 1.0

        fd = np.log10(n) / (np.log10(n) + np.log10(distance / length))
        return float(np.clip(fd, 1.0, 2.0))

    @staticmethod
    def _hurst_exponent(values: np.ndarray) -> float:
        x = np.asarray(values, dtype=float)
        x = x[~np.isnan(x)]
        n = len(x)
        if n < 20:
            return np.nan

        lags = [2, 4, 8, 16]
        lags = [lag for lag in lags if lag < n // 2]
        if len(lags) < 2:
            return np.nan

        tau = []
        valid_lags = []
        for lag in lags:
            diff = x[lag:] - x[:-lag]
            std = np.std(diff)
            if std > 0:
                tau.append(std)
                valid_lags.append(lag)

        if len(tau) < 2:
            return np.nan

        slope = np.polyfit(np.log(valid_lags), np.log(tau), 1)[0]
        return float(np.clip(slope, 0.0, 1.2))

    def _add_market_relative_features(self, df: pd.DataFrame) -> pd.DataFrame:
        if "date" not in df.columns or "close" not in df.columns:
            return df

        market_close_by_date = df.groupby("date")["close"].mean().sort_index()
        market_return_20 = market_close_by_date.pct_change(20)

        df["market_close_mean"] = df["date"].map(market_close_by_date)
        df["market_return_20d"] = df["date"].map(market_return_20)

        if "stock_code" in df.columns:
            stock_return_20 = df.groupby("stock_code")["close"].transform(
                lambda x: x.pct_change(20)
            )
        else:
            stock_return_20 = df["close"].pct_change(20)

        df["relative_strength_20d"] = stock_return_20 - df["market_return_20d"]
        df["relative_strength_ratio"] = df["close"] / df["market_close_mean"].replace(0, np.nan)

        return df

    def _add_candlestick_patterns(self, df: pd.DataFrame) -> pd.DataFrame:
        if not all(col in df.columns for col in ["open", "high", "low", "close"]):
            return df

        body = (df["close"] - df["open"]).abs()
        full_range = (df["high"] - df["low"]).replace(0, np.nan)
        upper_shadow = df["high"] - df[["open", "close"]].max(axis=1)
        lower_shadow = df[["open", "close"]].min(axis=1) - df["low"]

        df["pattern_doji"] = ((body / full_range) <= 0.10).astype(int)
        df["pattern_hammer"] = (
            (lower_shadow >= 2.0 * body)
            & (upper_shadow <= body + 1e-9)
            & ((df["close"] - df["open"]) > 0)
        ).astype(int)

        if "stock_code" in df.columns:
            prev_open = df.groupby("stock_code")["open"].shift(1)
            prev_close = df.groupby("stock_code")["close"].shift(1)
        else:
            prev_open = df["open"].shift(1)
            prev_close = df["close"].shift(1)

        bullish_engulf = (
            (df["close"] > df["open"])
            & (prev_close < prev_open)
            & (df["close"] >= prev_open)
            & (df["open"] <= prev_close)
        )
        bearish_engulf = (
            (df["close"] < df["open"])
            & (prev_close > prev_open)
            & (df["open"] >= prev_close)
            & (df["close"] <= prev_open)
        )

        df["pattern_bullish_engulfing"] = bullish_engulf.astype(int)
        df["pattern_bearish_engulfing"] = bearish_engulf.astype(int)
        df["pattern_engulfing"] = (bullish_engulf | bearish_engulf).astype(int)

        return df

    def _add_advanced_regime_features(self, df: pd.DataFrame) -> pd.DataFrame:
        required_ohlc = {"high", "low", "close"}
        has_ohlc = all(col in df.columns for col in required_ohlc)

        if has_ohlc:
            if "stock_code" in df.columns:
                df["atr_14"] = df.groupby("stock_code", group_keys=False).apply(
                    lambda g: self._compute_atr(g, 14)
                ).squeeze()
                df["adx_14"] = df.groupby("stock_code", group_keys=False).apply(
                    lambda g: self._compute_adx(g, 14)
                ).squeeze()
            else:
                df["atr_14"] = self._compute_atr(df, 14)
                df["adx_14"] = self._compute_adx(df, 14)

            close_safe = df["close"].replace(0, np.nan)
            df["volatility_regime"] = df["atr_14"] / close_safe

            if "stock_code" in df.columns:
                rolling_high_52w = df.groupby("stock_code")["high"].transform(
                    lambda x: x.rolling(252, min_periods=1).max()
                )
                rolling_low_52w = df.groupby("stock_code")["low"].transform(
                    lambda x: x.rolling(252, min_periods=1).min()
                )
            else:
                rolling_high_52w = df["high"].rolling(252, min_periods=1).max()
                rolling_low_52w = df["low"].rolling(252, min_periods=1).min()

            range_52w = (rolling_high_52w - rolling_low_52w).replace(0, np.nan)
            df["price_position_52w"] = (df["close"] - rolling_low_52w) / range_52w

        if "volume" in df.columns:
            if "stock_code" in df.columns:
                avg_volume_20 = df.groupby("stock_code")["volume"].transform(
                    lambda x: x.rolling(20, min_periods=1).mean()
                )
            else:
                avg_volume_20 = df["volume"].rolling(20, min_periods=1).mean()
            df["volume_anomaly"] = df["volume"] / avg_volume_20.replace(0, np.nan)

        if "close" in df.columns and "rsi" in df.columns:
            if "stock_code" in df.columns:
                price_trend = df.groupby("stock_code")["close"].transform(
                    lambda x: x.pct_change(14)
                )
                rsi_trend = df.groupby("stock_code")["rsi"].transform(
                    lambda x: x.diff(14)
                )
            else:
                price_trend = df["close"].pct_change(14)
                rsi_trend = df["rsi"].diff(14)

            df["rsi_price_divergence"] = (
                ((price_trend > 0) & (rsi_trend < 0))
                | ((price_trend < 0) & (rsi_trend > 0))
            ).astype(int)

        if "close" in df.columns:
            round_step = 5.0
            nearest_round = np.round(df["close"] / round_step) * round_step
            close_safe = df["close"].replace(0, np.nan)
            df["round_level_distance"] = (df["close"] - nearest_round).abs() / close_safe

        if "close" in df.columns:
            if "stock_code" in df.columns:
                trend_60d = df.groupby("stock_code")["close"].transform(
                    lambda x: x.pct_change(60)
                )
            else:
                trend_60d = df["close"].pct_change(60)

            df["trend_60d"] = trend_60d
            df["market_regime"] = np.select(
                [trend_60d > 0.1, trend_60d < -0.1],
                [1, -1],
                default=0,
            )
            df["market_regime_bull"] = (df["market_regime"] == 1).astype(int)
            df["market_regime_bear"] = (df["market_regime"] == -1).astype(int)
            df["market_regime_sideways"] = (df["market_regime"] == 0).astype(int)

        if "close" in df.columns:
            if "stock_code" in df.columns:
                df["fractal_dimension_60"] = df.groupby("stock_code")["close"].transform(
                    lambda x: x.rolling(60, min_periods=20).apply(
                        self._katz_fractal_dimension, raw=True
                    )
                )
                df["hurst_exponent_60"] = df.groupby("stock_code")["close"].transform(
                    lambda x: x.rolling(60, min_periods=20).apply(
                        self._hurst_exponent, raw=True
                    )
                )
            else:
                df["fractal_dimension_60"] = df["close"].rolling(60, min_periods=20).apply(
                    self._katz_fractal_dimension, raw=True
                )
                df["hurst_exponent_60"] = df["close"].rolling(60, min_periods=20).apply(
                    self._hurst_exponent, raw=True
                )

        if all(col in df.columns for col in ["close", "volume", "volume_anomaly"]):
            if "stock_code" in df.columns:
                ret_10 = df.groupby("stock_code")["close"].transform(lambda x: x.pct_change(10))
                pv = df["close"] * df["volume"]
                vwap_num = pv.groupby(df["stock_code"]).transform(
                    lambda x: x.rolling(20, min_periods=5).sum()
                )
                vwap_den = df.groupby("stock_code")["volume"].transform(
                    lambda x: x.rolling(20, min_periods=5).sum()
                )
                vwap_20 = vwap_num / vwap_den.replace(0, np.nan)
            else:
                ret_10 = df["close"].pct_change(10)
                vwap_num = (df["close"] * df["volume"]).rolling(20, min_periods=5).sum()
                vwap_den = df["volume"].rolling(20, min_periods=5).sum()
                vwap_20 = vwap_num / vwap_den.replace(0, np.nan)

            df["vwap_20"] = vwap_20
            df["volume_weighted_momentum"] = ret_10 * df["volume_anomaly"].fillna(1.0)
            df["price_vs_vwap_20"] = df["close"] / vwap_20.replace(0, np.nan) - 1.0

        df = self._add_market_relative_features(df)
        df = self._add_candlestick_patterns(df)

        if "volatility_regime" in df.columns:
            if "stock_code" in df.columns:
                vol_pct = df.groupby("stock_code")["volatility_regime"].transform(
                    lambda x: x.rolling(252, min_periods=30).rank(pct=True)
                )
            else:
                vol_pct = df["volatility_regime"].rolling(252, min_periods=30).rank(pct=True)

            df["volatility_regime_pct"] = vol_pct
            df["volatility_regime_bucket"] = np.select(
                [vol_pct < 0.33, vol_pct < 0.66],
                [0, 1],
                default=2,
            )
            df["volatility_low"] = (df["volatility_regime_bucket"] == 0).astype(int)
            df["volatility_medium"] = (df["volatility_regime_bucket"] == 1).astype(int)
            df["volatility_high"] = (df["volatility_regime_bucket"] == 2).astype(int)

        if all(col in df.columns for col in ["close", "ma60"]):
            if "stock_code" in df.columns:
                ma60_slope = df.groupby("stock_code")["ma60"].transform(lambda x: x.diff(5))
            else:
                ma60_slope = df["ma60"].diff(5)

            bull_rule = (df["close"] > df["ma60"]) & (ma60_slope > 0)
            bear_rule = (df["close"] < df["ma60"]) & (ma60_slope < 0)
            df["market_regime_rule"] = np.select(
                [bull_rule, bear_rule],
                [1, -1],
                default=0,
            )
            df["market_regime_rule_bull"] = (df["market_regime_rule"] == 1).astype(int)
            df["market_regime_rule_bear"] = (df["market_regime_rule"] == -1).astype(int)
            df["market_regime_rule_sideways"] = (
                df["market_regime_rule"] == 0
            ).astype(int)

        return df

    def select_features(self, df: pd.DataFrame, feature_list: List[str] | None = None) -> pd.DataFrame:
        if feature_list is None:
            numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
            exclude_cols = {
                "label_5d",
                "label_10d",
                "return_5d",
                "return_10d",
                "return_20d",
                "distilled_label",
                "temporal_soft_label",
                "teacher_soft_label",
            }
            feature_list = [col for col in numeric_cols if col not in exclude_cols]

        available_features = [col for col in feature_list if col in df.columns]
        missing = set(feature_list) - set(available_features)
        if missing:
            print(f"[FeatureEngineer] Missing requested features: {sorted(missing)}")

        return df[available_features]

    def normalize_features(
        self,
        X_train: pd.DataFrame,
        X_test: pd.DataFrame | None = None,
    ) -> pd.DataFrame | tuple[pd.DataFrame, pd.DataFrame]:
        X_train = X_train.fillna(0)
        X_train_scaled = self.scaler.fit_transform(X_train)
        X_train_scaled = pd.DataFrame(
            X_train_scaled,
            columns=X_train.columns,
            index=X_train.index,
        )

        if X_test is None:
            return X_train_scaled

        X_test = X_test.fillna(0)
        X_test_scaled = self.scaler.transform(X_test)
        X_test_scaled = pd.DataFrame(
            X_test_scaled,
            columns=X_test.columns,
            index=X_test.index,
        )
        return X_train_scaled, X_test_scaled


if __name__ == "__main__":
    from data_collector import DataCollector

    collector = DataCollector()
    data = collector.load_data("./data/training_data.csv")

    engineer = FeatureEngineer()
    features = engineer.engineer_features(data)

    print("\n[FeatureEngineer] Completed")
    print(f"original_columns={len(data.columns)}")
    print(f"engineered_columns={len(features.columns)}")

    new_features = sorted(set(features.columns) - set(data.columns))
    print("new_feature_preview=")
    for feat in new_features[:80]:
        print(f"  - {feat}")
