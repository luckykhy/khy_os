# @pattern Command, Template Method
"""Offline teacher training pipeline for six analyst agents + stacking meta-learner."""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
from sklearn.model_selection import TimeSeriesSplit, cross_val_score
from sklearn.naive_bayes import GaussianNB
from sklearn.neural_network import MLPClassifier

from feature_engineer import FeatureEngineer

warnings.filterwarnings("ignore")

AGENT_ORDER = [
    "market_analyst",
    "technical_analyst",
    "fundamental_analyst",
    "news_analyst",
    "risk_analyst",
    "strategy_analyst",
]


class RegimeAwareModel:
    """Wraps a default model with optional regime-specific submodels."""

    def __init__(
        self,
        default_model: Any,
        regime_models: Optional[Dict[int, Any]] = None,
        regime_feature: Optional[str] = None,
    ) -> None:
        self.default_model = default_model
        self.regime_models = regime_models or {}
        self.regime_feature = regime_feature
        self.classes_ = np.array([0, 1])

    @staticmethod
    def _positive_probability(model: Any, X: pd.DataFrame) -> np.ndarray:
        if len(X) == 0:
            return np.array([], dtype=float)

        if hasattr(model, "predict_proba"):
            probs = np.asarray(model.predict_proba(X))
            if probs.ndim == 1:
                return np.clip(probs.astype(float), 0.0, 1.0)
            classes = getattr(model, "classes_", np.arange(probs.shape[1]))
            if 1 in classes:
                idx = int(np.where(classes == 1)[0][0])
                return np.clip(probs[:, idx].astype(float), 0.0, 1.0)
            return np.clip(np.max(probs, axis=1).astype(float), 0.0, 1.0)

        if hasattr(model, "decision_function"):
            scores = np.asarray(model.decision_function(X)).ravel().astype(float)
            return np.clip(1.0 / (1.0 + np.exp(-scores)), 0.0, 1.0)

        pred = np.asarray(model.predict(X)).ravel().astype(float)
        return np.where(pred >= 0.5, 0.75, 0.25)

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        if not isinstance(X, pd.DataFrame):
            X = pd.DataFrame(X)

        p1 = np.zeros(len(X), dtype=float)
        assigned = np.zeros(len(X), dtype=bool)

        if self.regime_feature and self.regime_feature in X.columns and self.regime_models:
            regimes = pd.to_numeric(X[self.regime_feature], errors="coerce").fillna(0).round().astype(int)
            for regime_value, sub_model in self.regime_models.items():
                idx = np.where(regimes.values == int(regime_value))[0]
                if len(idx) == 0:
                    continue
                sub_X = X.iloc[idx]
                p1[idx] = self._positive_probability(sub_model, sub_X)
                assigned[idx] = True

        remaining = np.where(~assigned)[0]
        if len(remaining) > 0:
            sub_X = X.iloc[remaining]
            p1[remaining] = self._positive_probability(self.default_model, sub_X)

        p1 = np.clip(p1, 0.0, 1.0)
        p0 = 1.0 - p1
        return np.column_stack([p0, p1])

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        p1 = self.predict_proba(X)[:, 1]
        return (p1 >= 0.5).astype(int)

    def decision_function(self, X: pd.DataFrame) -> np.ndarray:
        p1 = np.clip(self.predict_proba(X)[:, 1], 1e-6, 1 - 1e-6)
        return np.log(p1 / (1.0 - p1))


@dataclass
class DatasetBundle:
    X: pd.DataFrame
    y_hard: pd.Series
    temporal_soft: pd.Series
    feature_columns: List[str]
    label_source: str
    data: pd.DataFrame


class AgentTrainer:
    """Trains and persists all six analyst models with offline distillation."""

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = config or self._get_default_config()
        self.models: Dict[str, Any] = {}
        self.training_history: Dict[str, Dict[str, float]] = {}
        self.round_history: List[Dict[str, float]] = []
        self.meta_payload: Optional[Dict[str, Any]] = None

    def _get_default_config(self) -> Dict[str, Any]:
        return {
            "models": {
                "market_analyst": {
                    "type": "random_forest",
                    "params": {
                        "n_estimators": 260,
                        "max_depth": 10,
                        "min_samples_leaf": 5,
                        "random_state": 42,
                        "n_jobs": -1,
                    },
                },
                "technical_analyst": {
                    "type": "xgboost",
                    "params": {
                        "n_estimators": 240,
                        "max_depth": 6,
                        "learning_rate": 0.05,
                        "subsample": 0.9,
                        "colsample_bytree": 0.9,
                        "random_state": 42,
                        "n_jobs": -1,
                    },
                },
                "fundamental_analyst": {
                    "type": "lightgbm",
                    "params": {
                        "n_estimators": 240,
                        "max_depth": 8,
                        "learning_rate": 0.05,
                        "subsample": 0.9,
                        "colsample_bytree": 0.9,
                        "random_state": 42,
                    },
                },
                "news_analyst": {
                    "type": "naive_bayes",
                    "params": {},
                },
                "risk_analyst": {
                    "type": "logistic_regression",
                    "params": {
                        "C": 1.0,
                        "max_iter": 2500,
                        "random_state": 42,
                        "n_jobs": -1,
                    },
                },
                "strategy_analyst": {
                    "type": "mlp",
                    "params": {
                        "hidden_layer_sizes": (128, 64, 32),
                        "max_iter": 800,
                        "random_state": 42,
                    },
                },
            }
        }

    def _create_model(self, model_type: str, params: Dict[str, Any]) -> Any:
        if model_type == "random_forest":
            return RandomForestClassifier(**params)
        if model_type == "xgboost":
            return xgb.XGBClassifier(**params, use_label_encoder=False, eval_metric="logloss")
        if model_type == "lightgbm":
            return lgb.LGBMClassifier(**params, verbose=-1)
        if model_type == "naive_bayes":
            return GaussianNB(**params)
        if model_type == "logistic_regression":
            return LogisticRegression(**params)
        if model_type == "mlp":
            return MLPClassifier(**params)
        raise ValueError(f"Unsupported model type: {model_type}")

    def _fit_model(
        self,
        model: Any,
        X: pd.DataFrame,
        y: pd.Series,
        sample_weight: Optional[np.ndarray] = None,
    ) -> Any:
        if sample_weight is not None:
            try:
                model.fit(X, y, sample_weight=sample_weight)
                return model
            except TypeError:
                pass
        model.fit(X, y)
        return model

    def _predict_positive_probability(self, model: Any, X: pd.DataFrame) -> np.ndarray:
        if hasattr(model, "predict_proba"):
            probs = np.asarray(model.predict_proba(X))
            if probs.ndim == 1:
                return np.clip(probs.astype(float), 0.0, 1.0)
            classes = getattr(model, "classes_", np.arange(probs.shape[1]))
            if 1 in classes:
                idx = int(np.where(classes == 1)[0][0])
                return np.clip(probs[:, idx].astype(float), 0.0, 1.0)
            return np.clip(np.max(probs, axis=1).astype(float), 0.0, 1.0)

        if hasattr(model, "decision_function"):
            scores = np.asarray(model.decision_function(X)).ravel().astype(float)
            return np.clip(1.0 / (1.0 + np.exp(-scores)), 0.0, 1.0)

        pred = np.asarray(model.predict(X)).ravel().astype(float)
        return np.where(pred >= 0.5, 0.75, 0.25)

    def _compute_temporal_soft_labels(self, df: pd.DataFrame, y_fallback: pd.Series) -> pd.Series:
        work = df.copy()

        if "stock_code" in work.columns and "close" in work.columns:
            close = work["close"]
            fut5 = work.groupby("stock_code")["close"].shift(-5)
            fut10 = work.groupby("stock_code")["close"].shift(-10)
            fut20 = work.groupby("stock_code")["close"].shift(-20)
        elif "close" in work.columns:
            close = work["close"]
            fut5 = close.shift(-5)
            fut10 = close.shift(-10)
            fut20 = close.shift(-20)
        else:
            return (0.35 + 0.3 * y_fallback).astype(float)

        ret5 = (fut5 - close) / close.replace(0, np.nan)
        ret10 = (fut10 - close) / close.replace(0, np.nan)
        ret20 = (fut20 - close) / close.replace(0, np.nan)

        work["return_5d"] = work.get("return_5d", ret5 * 100)
        work["return_10d"] = ret10 * 100
        work["return_20d"] = ret20 * 100

        buy_votes = (
            (ret5 > 0.02).astype(int)
            + (ret10 > 0.03).astype(int)
            + (ret20 > 0.04).astype(int)
        )
        sell_votes = (
            (ret5 < -0.02).astype(int)
            + (ret10 < -0.03).astype(int)
            + (ret20 < -0.04).astype(int)
        )

        soft = np.where(
            buy_votes >= 3,
            0.90,
            np.where(
                buy_votes == 2,
                0.75,
                np.where(
                    sell_votes >= 3,
                    0.10,
                    np.where(sell_votes == 2, 0.25, 0.50),
                ),
            ),
        )

        soft = pd.Series(soft, index=work.index, dtype=float)
        fallback_soft = 0.35 + 0.3 * y_fallback.astype(float)
        soft = soft.where(ret5.notna() & ret10.notna() & ret20.notna(), fallback_soft)
        return soft.clip(0.01, 0.99)

    def prepare_dataset(
        self,
        data_path: str | Path,
    ) -> DatasetBundle:
        data_path = Path(data_path)
        if not data_path.exists():
            raise FileNotFoundError(f"training data not found: {data_path}")

        raw = pd.read_csv(data_path)
        if "date" in raw.columns:
            raw["date"] = pd.to_datetime(raw["date"], errors="coerce")

        engineer = FeatureEngineer()
        feature_df = engineer.engineer_features(raw)

        if "label_5d" in feature_df.columns:
            y_hard = pd.to_numeric(feature_df["label_5d"], errors="coerce").fillna(0).astype(int)
            label_source = "original_label_5d"
        elif "return_5d" in feature_df.columns:
            y_hard = (pd.to_numeric(feature_df["return_5d"], errors="coerce").fillna(0) > 0).astype(int)
            label_source = "derived_from_return_5d"
        else:
            raise ValueError("No valid hard label column found (label_5d/return_5d).")

        temporal_soft = self._compute_temporal_soft_labels(feature_df, y_hard)
        feature_df["temporal_soft_label"] = temporal_soft

        if "date" in feature_df.columns:
            order = feature_df["date"].sort_values(kind="mergesort").index
            feature_df = feature_df.loc[order].reset_index(drop=True)
            y_hard = y_hard.loc[order].reset_index(drop=True)
            temporal_soft = temporal_soft.loc[order].reset_index(drop=True)
        else:
            y_hard = y_hard.reset_index(drop=True)
            temporal_soft = temporal_soft.reset_index(drop=True)

        X = engineer.select_features(feature_df).fillna(0)
        feature_columns = list(X.columns)

        return DatasetBundle(
            X=X,
            y_hard=y_hard.astype(int),
            temporal_soft=temporal_soft.astype(float),
            feature_columns=feature_columns,
            label_source=label_source,
            data=feature_df,
        )

    def _time_holdout_split(
        self,
        X: pd.DataFrame,
        y_hard: pd.Series,
        y_temporal_soft: pd.Series,
        test_ratio: float = 0.2,
    ) -> Tuple[pd.DataFrame, pd.DataFrame, pd.Series, pd.Series, pd.Series, pd.Series]:
        n = len(X)
        if n < 80:
            raise ValueError("Dataset too small for robust time-series training.")

        split_idx = max(int(n * (1 - test_ratio)), 60)
        split_idx = min(split_idx, n - 1)

        X_train = X.iloc[:split_idx].copy()
        X_test = X.iloc[split_idx:].copy()

        y_train = y_hard.iloc[:split_idx].copy()
        y_test = y_hard.iloc[split_idx:].copy()

        soft_train = y_temporal_soft.iloc[:split_idx].copy()
        soft_test = y_temporal_soft.iloc[split_idx:].copy()

        return X_train, X_test, y_train, y_test, soft_train, soft_test

    def _cross_validate_agent(
        self,
        agent_name: str,
        X_train: pd.DataFrame,
        y_train: pd.Series,
    ) -> Tuple[float, float]:
        cfg = self.config["models"][agent_name]
        base_model = self._create_model(cfg["type"], cfg["params"])

        n_splits = min(5, max(2, len(X_train) // 600))
        cv = TimeSeriesSplit(n_splits=n_splits)

        try:
            scores = cross_val_score(
                base_model,
                X_train,
                y_train,
                cv=cv,
                scoring="accuracy",
                error_score=np.nan,
            )
            return float(np.nanmean(scores)), float(np.nanstd(scores))
        except Exception:
            return float("nan"), float("nan")

    def _build_regime_aware_model(
        self,
        agent_name: str,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        sample_weight: Optional[np.ndarray] = None,
    ) -> RegimeAwareModel:
        cfg = self.config["models"][agent_name]
        default_model = self._create_model(cfg["type"], cfg["params"])
        default_model = self._fit_model(default_model, X_train, y_train, sample_weight=sample_weight)

        regime_feature = None
        if "market_regime_rule" in X_train.columns:
            regime_feature = "market_regime_rule"
        elif "market_regime" in X_train.columns:
            regime_feature = "market_regime"

        regime_models: Dict[int, Any] = {}
        if regime_feature is not None:
            regime_values = (
                pd.to_numeric(X_train[regime_feature], errors="coerce")
                .fillna(0)
                .round()
                .astype(int)
            )

            for regime in (-1, 0, 1):
                idx = np.where(regime_values.values == regime)[0]
                if len(idx) < 120:
                    continue

                X_sub = X_train.iloc[idx]
                y_sub = y_train.iloc[idx]
                if y_sub.nunique() < 2:
                    continue

                sw_sub = sample_weight[idx] if sample_weight is not None else None
                sub_model = self._create_model(cfg["type"], cfg["params"])
                sub_model = self._fit_model(sub_model, X_sub, y_sub, sample_weight=sw_sub)
                regime_models[int(regime)] = sub_model

        return RegimeAwareModel(
            default_model=default_model,
            regime_models=regime_models,
            regime_feature=regime_feature,
        )

    def train_single_agent(
        self,
        agent_name: str,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        X_test: pd.DataFrame,
        y_test: pd.Series,
        sample_weight: Optional[np.ndarray] = None,
    ) -> Tuple[Any, Dict[str, float]]:
        cv_mean, cv_std = self._cross_validate_agent(agent_name, X_train, y_train)
        model = self._build_regime_aware_model(
            agent_name=agent_name,
            X_train=X_train,
            y_train=y_train,
            sample_weight=sample_weight,
        )

        y_pred = model.predict(X_test)
        y_prob = model.predict_proba(X_test)[:, 1]

        metrics = {
            "accuracy": float(accuracy_score(y_test, y_pred)),
            "precision": float(precision_score(y_test, y_pred, average="weighted", zero_division=0)),
            "recall": float(recall_score(y_test, y_pred, average="weighted", zero_division=0)),
            "f1_score": float(f1_score(y_test, y_pred, average="weighted", zero_division=0)),
            "cv_accuracy_mean": float(cv_mean),
            "cv_accuracy_std": float(cv_std),
            "test_positive_rate": float(np.mean(y_prob >= 0.5)),
            "train_samples": float(len(X_train)),
            "test_samples": float(len(X_test)),
        }

        return model, metrics

    def train_all_agents(
        self,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        X_test: pd.DataFrame,
        y_test: pd.Series,
        sample_weight: Optional[np.ndarray] = None,
    ) -> Dict[str, Dict[str, float]]:
        history: Dict[str, Dict[str, float]] = {}

        for idx, agent_name in enumerate(AGENT_ORDER, start=1):
            print(f"[Trainer] ({idx}/6) Training {agent_name}...")
            model, metrics = self.train_single_agent(
                agent_name=agent_name,
                X_train=X_train,
                y_train=y_train,
                X_test=X_test,
                y_test=y_test,
                sample_weight=sample_weight,
            )
            self.models[agent_name] = model
            self.training_history[agent_name] = metrics
            history[agent_name] = metrics
            print(
                f"[Trainer] {agent_name}: acc={metrics['accuracy']:.4f}, "
                f"cv={metrics['cv_accuracy_mean']:.4f}±{metrics['cv_accuracy_std']:.4f}"
            )

        return history

    def train_with_ensemble_teacher(
        self,
        X_train: pd.DataFrame,
        y_train_hard: pd.Series,
        y_temporal_soft: pd.Series,
        X_test: pd.DataFrame,
        y_test_hard: pd.Series,
        rounds: int = 3,
    ) -> List[Dict[str, float]]:
        y_soft = np.clip(0.55 * y_temporal_soft.values + 0.45 * y_train_hard.values, 0.01, 0.99)
        round_history: List[Dict[str, float]] = []

        for round_idx in range(1, rounds + 1):
            print(f"[Teacher] Distillation round {round_idx}/{rounds}")

            y_round = pd.Series((y_soft >= 0.5).astype(int), index=y_train_hard.index)
            if y_round.nunique() < 2:
                y_round = y_train_hard.copy()

            sample_weight = 0.5 + 2.0 * np.abs(y_soft - 0.5)
            self.train_all_agents(
                X_train=X_train,
                y_train=y_round,
                X_test=X_test,
                y_test=y_test_hard,
                sample_weight=sample_weight,
            )

            probs = []
            for agent_name in AGENT_ORDER:
                p_agent = self._predict_positive_probability(self.models[agent_name], X_train)
                probs.append(p_agent)
            ensemble_prob = np.mean(np.vstack(probs), axis=0)

            y_soft = np.clip(
                0.20 * y_soft + 0.55 * ensemble_prob + 0.25 * y_temporal_soft.values,
                0.01,
                0.99,
            )

            avg_acc = float(np.mean([m["accuracy"] for m in self.training_history.values()]))
            avg_conf = float(np.mean(np.abs(ensemble_prob - 0.5) * 2.0))
            entry = {
                "round": float(round_idx),
                "average_accuracy": avg_acc,
                "teacher_confidence": avg_conf,
            }
            round_history.append(entry)
            print(
                f"[Teacher] round={round_idx} avg_accuracy={avg_acc:.4f} "
                f"teacher_confidence={avg_conf:.4f}"
            )

        self.round_history = round_history
        return round_history

    def _build_meta_features(self, X: pd.DataFrame) -> pd.DataFrame:
        data: Dict[str, np.ndarray] = {}

        for agent_name in AGENT_ORDER:
            p = self._predict_positive_probability(self.models[agent_name], X)
            data[f"{agent_name}_proba"] = p

        if "market_regime_rule" in X.columns:
            regime = pd.to_numeric(X["market_regime_rule"], errors="coerce").fillna(0).values
        elif "market_regime" in X.columns:
            regime = pd.to_numeric(X["market_regime"], errors="coerce").fillna(0).values
        else:
            regime = np.zeros(len(X), dtype=float)

        if "volatility_regime_pct" in X.columns:
            vol = pd.to_numeric(X["volatility_regime_pct"], errors="coerce").fillna(0.5).values
        elif "volatility_regime" in X.columns:
            vol = pd.to_numeric(X["volatility_regime"], errors="coerce").fillna(0.0).values
        else:
            vol = np.zeros(len(X), dtype=float)

        data["regime_feature"] = regime.astype(float)
        data["volatility_feature"] = vol.astype(float)

        return pd.DataFrame(data, index=X.index)

    def train_meta_learner(
        self,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        X_test: pd.DataFrame,
        y_test: pd.Series,
    ) -> Tuple[Dict[str, Any], Dict[str, float]]:
        meta_X_train = self._build_meta_features(X_train)
        meta_X_test = self._build_meta_features(X_test)

        meta_model = LogisticRegression(max_iter=2500, random_state=42)
        meta_model.fit(meta_X_train, y_train)

        p_test = np.asarray(meta_model.predict_proba(meta_X_test))[:, 1]
        y_pred = (p_test >= 0.5).astype(int)

        metrics = {
            "accuracy": float(accuracy_score(y_test, y_pred)),
            "precision": float(precision_score(y_test, y_pred, average="weighted", zero_division=0)),
            "recall": float(recall_score(y_test, y_pred, average="weighted", zero_division=0)),
            "f1_score": float(f1_score(y_test, y_pred, average="weighted", zero_division=0)),
            "mean_probability": float(np.mean(p_test)),
        }

        payload = {
            "model": meta_model,
            "agent_order": AGENT_ORDER,
            "meta_features": list(meta_X_train.columns),
            "confidence_threshold": 0.70,
            "trained_at": datetime.now().isoformat(),
        }

        self.meta_payload = payload
        return payload, metrics

    def save_models(
        self,
        save_dir: str | Path,
        suffix: str,
        feature_columns: List[str],
        label_source: str,
        meta_payload: Optional[Dict[str, Any]] = None,
        meta_metrics: Optional[Dict[str, float]] = None,
        extra_history: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, str]:
        save_dir = Path(save_dir)
        save_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        saved: Dict[str, str] = {}

        for agent_name, model in self.models.items():
            latest_path = save_dir / f"{agent_name}_{suffix}.joblib"
            ts_path = save_dir / f"{agent_name}_{suffix}_{timestamp}.joblib"
            joblib.dump(model, latest_path)
            joblib.dump(model, ts_path)
            saved[agent_name] = str(latest_path)

        feature_path_latest = save_dir / f"feature_columns_{suffix}.joblib"
        feature_path_ts = save_dir / f"feature_columns_{suffix}_{timestamp}.joblib"
        joblib.dump(feature_columns, feature_path_latest)
        joblib.dump(feature_columns, feature_path_ts)

        if meta_payload is not None:
            meta_latest = save_dir / f"ensemble_meta_{suffix}.joblib"
            meta_ts = save_dir / f"ensemble_meta_{suffix}_{timestamp}.joblib"
            joblib.dump(meta_payload, meta_latest)
            joblib.dump(meta_payload, meta_ts)

        history_payload: Dict[str, Any] = {
            "timestamp": timestamp,
            "label_source": label_source,
            "feature_count": len(feature_columns),
            "feature_columns": feature_columns,
            "metrics": self.training_history,
            "round_history": self.round_history,
            "meta_metrics": meta_metrics or {},
        }
        if extra_history:
            history_payload.update(extra_history)

        history_latest = save_dir / f"training_history_{suffix}.joblib"
        history_ts = save_dir / f"training_history_{suffix}_{timestamp}.joblib"
        joblib.dump(history_payload, history_latest)
        joblib.dump(history_payload, history_ts)

        print(f"[Trainer] Saved models to {save_dir}")
        return saved

    def train_from_files(
        self,
        data_path: str | Path,
        save_dir: str | Path,
        save_suffix: str = "distilled_latest",
        use_offline_teacher: bool = True,
        distillation_rounds: int = 3,
    ) -> Dict[str, Any]:
        dataset = self.prepare_dataset(data_path=data_path)

        X_train, X_test, y_train, y_test, soft_train, _soft_test = self._time_holdout_split(
            dataset.X,
            dataset.y_hard,
            dataset.temporal_soft,
        )

        self.round_history = []
        if use_offline_teacher:
            self.train_with_ensemble_teacher(
                X_train=X_train,
                y_train_hard=y_train,
                y_temporal_soft=soft_train,
                X_test=X_test,
                y_test_hard=y_test,
                rounds=max(1, int(distillation_rounds)),
            )
            label_source = "offline_teacher:ensemble+temporal_consensus"
        else:
            self.train_all_agents(X_train, y_train, X_test, y_test)
            label_source = dataset.label_source

        meta_payload, meta_metrics = self.train_meta_learner(
            X_train=X_train,
            y_train=y_train,
            X_test=X_test,
            y_test=y_test,
        )

        self.save_models(
            save_dir=save_dir,
            suffix=save_suffix,
            feature_columns=dataset.feature_columns,
            label_source=label_source,
            meta_payload=meta_payload,
            meta_metrics=meta_metrics,
        )

        avg_accuracy = (
            float(np.mean([v["accuracy"] for v in self.training_history.values()]))
            if self.training_history
            else 0.0
        )

        return {
            "label_source": label_source,
            "feature_count": len(dataset.feature_columns),
            "feature_columns": dataset.feature_columns,
            "metrics": self.training_history,
            "meta_metrics": meta_metrics,
            "round_history": self.round_history,
            "average_accuracy": avg_accuracy,
            "train_samples": len(X_train),
            "test_samples": len(X_test),
            "save_suffix": save_suffix,
            "teacher_mode": "offline" if use_offline_teacher else "baseline",
        }


def main() -> None:
    root = Path(__file__).resolve().parent
    data_path = root / "data" / "training_data.csv"
    models_dir = root / "models"

    trainer = AgentTrainer()
    summary = trainer.train_from_files(
        data_path=data_path,
        save_dir=models_dir,
        save_suffix="distilled_latest",
        use_offline_teacher=True,
        distillation_rounds=3,
    )

    print("\n[Trainer] Training summary")
    print("=" * 72)
    print(f"label_source={summary['label_source']}")
    print(f"feature_count={summary['feature_count']}")
    print(f"train_samples={summary['train_samples']} test_samples={summary['test_samples']}")
    print(f"average_accuracy={summary['average_accuracy']:.4f}")
    print(f"meta_accuracy={summary['meta_metrics'].get('accuracy', float('nan')):.4f}")


if __name__ == "__main__":
    main()
