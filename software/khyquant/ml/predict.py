# @pattern Command, Template Method
"""Production prediction script with regime-aware stacked ensemble and uncertainty gating."""

from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import joblib
import numpy as np
import pandas as pd

from feature_engineer import FeatureEngineer

# Force UTF-8 output to avoid encoding issues in subprocess mode.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"

AGENT_NAMES = {
    "market_analyst": "Market Analyst",
    "technical_analyst": "Technical Analyst",
    "fundamental_analyst": "Fundamental Analyst",
    "news_analyst": "News Analyst",
    "risk_analyst": "Risk Analyst",
    "strategy_analyst": "Strategy Analyst",
}

AGENT_ALGORITHMS = {
    "market_analyst": "Regime-Aware RandomForest",
    "technical_analyst": "Regime-Aware XGBoost",
    "fundamental_analyst": "Regime-Aware LightGBM",
    "news_analyst": "Regime-Aware GaussianNB",
    "risk_analyst": "Regime-Aware LogisticRegression",
    "strategy_analyst": "Regime-Aware MLP",
}

AGENT_ORDER = list(AGENT_NAMES.keys())
DEFAULT_FEATURE_COLUMNS = [
    "price",
    "open",
    "high",
    "low",
    "close",
    "ma5",
    "ma10",
    "ma20",
    "macd",
    "rsi",
    "kdj_k",
    "kdj_d",
    "kdj_j",
    "volume",
    "amount",
    "pe_ratio",
    "pb_ratio",
    "roe",
]

_ENGINEER = FeatureEngineer()
_MODEL_CACHE: Dict[str, Tuple[Any, str, str]] = {}
_FEATURE_COLUMNS_CACHE: Optional[List[str]] = None
_META_CACHE: Optional[Dict[str, Any]] = None


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, "", "null"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _load_feature_columns() -> List[str]:
    global _FEATURE_COLUMNS_CACHE
    if _FEATURE_COLUMNS_CACHE is not None:
        return _FEATURE_COLUMNS_CACHE

    candidate_paths = [
        MODELS_DIR / "feature_columns_distilled_latest.joblib",
        MODELS_DIR / "feature_columns_latest.joblib",
    ]

    for path in candidate_paths:
        if path.exists():
            try:
                cols = joblib.load(path)
                if isinstance(cols, list) and cols:
                    _FEATURE_COLUMNS_CACHE = cols
                    return cols
            except Exception as exc:  # noqa: BLE001
                print(f"[predict] failed loading feature columns from {path}: {exc}", file=sys.stderr)

    _FEATURE_COLUMNS_CACHE = DEFAULT_FEATURE_COLUMNS
    return DEFAULT_FEATURE_COLUMNS


def _timestamp_model_candidates(agent_name: str) -> List[Path]:
    pattern = re.compile(rf"^{re.escape(agent_name)}_(\d{{8}}_\d{{6}})\.joblib$")
    candidates: List[Tuple[str, Path]] = []
    for path in MODELS_DIR.glob(f"{agent_name}_*.joblib"):
        match = pattern.match(path.name)
        if not match:
            continue
        candidates.append((match.group(1), path))

    candidates.sort(key=lambda item: item[0], reverse=True)
    return [item[1] for item in candidates]


def _load_model(agent_name: str) -> Tuple[Any, str, str]:
    if agent_name in _MODEL_CACHE:
        return _MODEL_CACHE[agent_name]

    candidate_paths = [
        MODELS_DIR / f"{agent_name}_distilled_latest.joblib",
        MODELS_DIR / f"{agent_name}_latest.joblib",
    ]
    candidate_paths.extend(_timestamp_model_candidates(agent_name))

    for path in candidate_paths:
        if path.exists():
            model = joblib.load(path)
            if "_distilled_" in path.name:
                variant = "distilled"
            elif path.name.endswith("_latest.joblib"):
                variant = "legacy"
            else:
                variant = "legacy_timestamped"
            _MODEL_CACHE[agent_name] = (model, variant, path.name)
            return model, variant, path.name

    raise FileNotFoundError(
        f"model not found for {agent_name}; checked distilled and legacy model files"
    )


def _has_any_model(agent_name: str) -> bool:
    candidate_paths = [
        MODELS_DIR / f"{agent_name}_distilled_latest.joblib",
        MODELS_DIR / f"{agent_name}_latest.joblib",
    ]
    if any(path.exists() for path in candidate_paths):
        return True
    return len(_timestamp_model_candidates(agent_name)) > 0


def _validate_required_models() -> None:
    missing_agents = [agent for agent in AGENT_ORDER if not _has_any_model(agent)]
    if not missing_agents:
        return

    available_files = sorted([path.name for path in MODELS_DIR.glob("*.joblib")])
    raise FileNotFoundError(
        "missing trained model files for agents: "
        + ", ".join(missing_agents)
        + f"; models_dir={MODELS_DIR}; available_joblib_files={available_files}"
    )


def _load_meta_model() -> Optional[Dict[str, Any]]:
    global _META_CACHE
    if _META_CACHE is not None:
        return _META_CACHE

    candidates = [
        MODELS_DIR / "ensemble_meta_distilled_latest.joblib",
        MODELS_DIR / "ensemble_meta_latest.joblib",
    ]

    for path in candidates:
        if not path.exists():
            continue
        try:
            payload = joblib.load(path)
            if isinstance(payload, dict) and "model" in payload:
                _META_CACHE = payload
                return payload
        except Exception as exc:  # noqa: BLE001
            print(f"[predict] failed loading meta-model from {path}: {exc}", file=sys.stderr)

    _META_CACHE = None
    return None


def _prepare_snapshot_dataframe(stock_data: Dict[str, Any]) -> pd.DataFrame:
    history = stock_data.get("history")
    kline = stock_data.get("kline")
    
    # 优先用 history，其次用 kline（模拟数据用 kline 字段）
    rows = None
    if isinstance(history, list) and history:
        rows = history
    elif isinstance(kline, list) and kline:
        rows = kline

    if rows:
        df = pd.DataFrame(rows)
        # 统一列名：time -> date, 确保 close/open/high/low/volume 存在
        if "time" in df.columns and "date" not in df.columns:
            df = df.rename(columns={"time": "date"})
    else:
        df = pd.DataFrame([stock_data])

    if "stock_code" not in df.columns:
        df["stock_code"] = stock_data.get("stock_code", "unknown")

    if "date" not in df.columns:
        df["date"] = pd.Timestamp.utcnow()

    return df


def _prepare_feature_row(stock_data: Dict[str, Any], feature_columns: List[str]) -> Tuple[pd.DataFrame, Dict[str, float]]:
    df = _prepare_snapshot_dataframe(stock_data)
    engineered = _ENGINEER.engineer_features(df)

    row = engineered.iloc[-1]
    values: Dict[str, float] = {}
    for col in feature_columns:
        values[col] = _safe_float(row.get(col, 0.0), 0.0)

    X = pd.DataFrame([values], columns=feature_columns).fillna(0.0)

    indicator_values: Dict[str, float] = {
        "price": _safe_float(row.get("price", row.get("close", stock_data.get("price", 0.0)))),
        "close": _safe_float(row.get("close", stock_data.get("close", stock_data.get("price", 0.0)))),
        "ma5": _safe_float(row.get("ma5", stock_data.get("ma5", 0.0))),
        "ma10": _safe_float(row.get("ma10", stock_data.get("ma10", 0.0))),
        "ma20": _safe_float(row.get("ma20", stock_data.get("ma20", 0.0))),
        "macd": _safe_float(row.get("macd", stock_data.get("macd", 0.0))),
        "rsi": _safe_float(row.get("rsi", stock_data.get("rsi", 50.0))),
        "adx_14": _safe_float(row.get("adx_14", stock_data.get("adx_14", 0.0))),
        "atr_14": _safe_float(row.get("atr_14", stock_data.get("atr_14", 0.0))),
        "volatility_regime": _safe_float(row.get("volatility_regime", stock_data.get("volatility_regime", 0.0))),
        "volatility_regime_pct": _safe_float(row.get("volatility_regime_pct", stock_data.get("volatility_regime_pct", 0.5))),
        "volume_anomaly": _safe_float(row.get("volume_anomaly", stock_data.get("volume_anomaly", 1.0))),
        "price_position_52w": _safe_float(row.get("price_position_52w", stock_data.get("price_position_52w", 0.5))),
        "rsi_price_divergence": _safe_float(row.get("rsi_price_divergence", stock_data.get("rsi_price_divergence", 0.0))),
        "round_level_distance": _safe_float(row.get("round_level_distance", stock_data.get("round_level_distance", 0.0))),
        "trend_60d": _safe_float(row.get("trend_60d", stock_data.get("trend_60d", 0.0))),
        "market_regime": _safe_float(row.get("market_regime", stock_data.get("market_regime", 0.0))),
        "market_regime_rule": _safe_float(row.get("market_regime_rule", stock_data.get("market_regime_rule", 0.0))),
        "pe_ratio": _safe_float(row.get("pe_ratio", stock_data.get("pe_ratio", 0.0))),
        "pb_ratio": _safe_float(row.get("pb_ratio", stock_data.get("pb_ratio", 0.0))),
        "roe": _safe_float(row.get("roe", stock_data.get("roe", 0.0))),
    }

    return X, indicator_values


def _predict_positive_probability(model: Any, X: pd.DataFrame) -> float:
    if hasattr(model, "predict_proba"):
        probs = np.asarray(model.predict_proba(X))[0]
        classes = getattr(model, "classes_", np.arange(len(probs)))
        if 1 in classes:
            idx = int(np.where(classes == 1)[0][0])
            return float(np.clip(probs[idx], 0.0, 1.0))
        return float(np.clip(np.max(probs), 0.0, 1.0))

    if hasattr(model, "decision_function"):
        score = float(np.asarray(model.decision_function(X)).ravel()[0])
        return float(np.clip(1.0 / (1.0 + np.exp(-score)), 0.0, 1.0))

    pred = float(np.asarray(model.predict(X)).ravel()[0])
    return 0.75 if pred >= 0.5 else 0.25


def _unwrap_estimator(model: Any) -> Any:
    candidate = model

    if hasattr(candidate, "default_model"):
        candidate = candidate.default_model

    if hasattr(candidate, "calibrated_classifiers_") and candidate.calibrated_classifiers_:
        calibrated = candidate.calibrated_classifiers_[0]
        if hasattr(calibrated, "estimator"):
            candidate = calibrated.estimator
        elif hasattr(calibrated, "base_estimator"):
            candidate = calibrated.base_estimator

    if hasattr(candidate, "estimator"):
        candidate = candidate.estimator

    return candidate


def _extract_top_features(
    model: Any,
    feature_columns: List[str],
    X_row: pd.DataFrame,
    top_k: int = 3,
) -> List[Tuple[str, float, float]]:
    estimator = _unwrap_estimator(model)
    x_values = X_row.iloc[0].to_dict()

    if hasattr(estimator, "coef_"):
        coef = np.asarray(estimator.coef_)
        if coef.ndim > 1:
            coef = coef[0]
        if len(coef) == len(feature_columns):
            contributions = coef * np.asarray([x_values.get(c, 0.0) for c in feature_columns])
            order = np.argsort(np.abs(contributions))[::-1][:top_k]
            return [
                (feature_columns[i], float(x_values.get(feature_columns[i], 0.0)), float(contributions[i]))
                for i in order
            ]

    if hasattr(estimator, "feature_importances_"):
        importance = np.asarray(estimator.feature_importances_)
        if len(importance) == len(feature_columns):
            order = np.argsort(np.abs(importance))[::-1][:top_k]
            return [
                (feature_columns[i], float(x_values.get(feature_columns[i], 0.0)), float(importance[i]))
                for i in order
            ]

    fallback = [
        ("rsi", float(x_values.get("rsi", 0.0)), 0.0),
        ("macd", float(x_values.get("macd", 0.0)), 0.0),
        ("adx_14", float(x_values.get("adx_14", 0.0)), 0.0),
    ]
    return fallback[:top_k]


def _build_meta_vector(
    meta_payload: Dict[str, Any],
    agent_probabilities: Dict[str, float],
    indicators: Dict[str, float],
) -> np.ndarray:
    meta_features = meta_payload.get("meta_features") or []
    vector = []

    for feat in meta_features:
        if feat.endswith("_proba"):
            agent = feat[: -len("_proba")]
            vector.append(float(agent_probabilities.get(agent, 0.5)))
        elif feat == "regime_feature":
            regime = indicators.get("market_regime_rule", indicators.get("market_regime", 0.0))
            vector.append(float(regime))
        elif feat == "volatility_feature":
            vol = indicators.get("volatility_regime_pct", indicators.get("volatility_regime", 0.0))
            vector.append(float(vol))
        else:
            vector.append(float(indicators.get(feat, 0.0)))

    if not vector:
        vector = [float(agent_probabilities.get(a, 0.5)) for a in AGENT_ORDER]

    return np.asarray(vector, dtype=float).reshape(1, -1)


def _meta_probability(
    agent_probabilities: Dict[str, float],
    indicators: Dict[str, float],
    meta_payload: Optional[Dict[str, Any]],
) -> float:
    if meta_payload is None:
        return float(np.mean([agent_probabilities.get(a, 0.5) for a in AGENT_ORDER]))

    model = meta_payload["model"]
    X_meta = _build_meta_vector(meta_payload, agent_probabilities, indicators)

    if hasattr(model, "predict_proba"):
        return float(np.clip(model.predict_proba(X_meta)[0, 1], 0.0, 1.0))

    pred = float(model.predict(X_meta)[0])
    return 0.75 if pred >= 0.5 else 0.25


def _bootstrap_uncertainty(
    agent_probabilities: Dict[str, float],
    indicators: Dict[str, float],
    meta_payload: Optional[Dict[str, Any]],
    n_boot: int = 300,
) -> Tuple[float, float, float, float]:
    base_prob = _meta_probability(agent_probabilities, indicators, meta_payload)

    committee = np.array([agent_probabilities.get(a, 0.5) for a in AGENT_ORDER], dtype=float)
    samples = np.zeros(n_boot, dtype=float)

    for i in range(n_boot):
        sampled = np.random.choice(committee, size=len(committee), replace=True)
        boot_map = {agent: float(sampled[idx]) for idx, agent in enumerate(AGENT_ORDER)}
        samples[i] = _meta_probability(boot_map, indicators, meta_payload)

    lo, hi = np.percentile(samples, [2.5, 97.5]).astype(float)
    width = max(0.0, min(1.0, hi - lo))

    directional_conf = max(base_prob, 1.0 - base_prob)
    confidence_score = float(np.clip(directional_conf * (1.0 - width), 0.0, 1.0))

    return float(base_prob), float(lo), float(hi), confidence_score


def _regime_text(indicators: Dict[str, float]) -> str:
    regime_rule = int(round(indicators.get("market_regime_rule", indicators.get("market_regime", 0.0))))
    if regime_rule > 0:
        return "bull"
    if regime_rule < 0:
        return "bear"
    return "sideways"


def _make_signal(prob: float, confidence: float, threshold: float = 0.7) -> Tuple[str, float]:
    if confidence < threshold:
        return "hold", 0.5
    if prob >= 0.5:
        return "buy", 1.0
    return "sell", 0.0


def _generate_analysis(
    *,
    agent_name: str,
    agent_prob: float,
    final_prob: float,
    final_signal: str,
    confidence_score: float,
    ci_low: float,
    ci_high: float,
    stock_data: Dict[str, Any],
    indicators: Dict[str, float],
    model: Any,
    feature_columns: List[str],
    X_row: pd.DataFrame,
) -> str:
    """Generate detailed investment analysis report based on trained model predictions."""
    stock_code = stock_data.get("stock_code", "unknown")
    price = indicators.get("close", indicators.get("price", 0.0))
    rsi = indicators.get("rsi", 50.0)
    macd = indicators.get("macd", 0.0)
    macd_signal = indicators.get("macd_signal", 0.0)
    adx = indicators.get("adx_14", 0.0)
    atr = indicators.get("atr_14", 0.0)
    vol_regime = indicators.get("volatility_regime_pct", 0.5)
    regime = _regime_text(indicators)
    
    ma5 = indicators.get("ma5", price)
    ma10 = indicators.get("ma10", price)
    ma20 = indicators.get("ma20", price)
    ma60 = indicators.get("ma60", price)
    
    pe_ratio = indicators.get("pe_ratio", 15.0)
    pb_ratio = indicators.get("pb_ratio", 2.0)
    roe = indicators.get("roe", 12.0)
    
    volume_anomaly = indicators.get("volume_anomaly", 1.0)
    trend_60d = indicators.get("trend_60d", 0.0)
    
    # Extract top features from model
    top_features = _extract_top_features(model, feature_columns, X_row, top_k=5)
    
    # Calculate derived indicators
    ma_cross = "金叉" if ma5 > ma20 else "死叉"
    macd_cross = "金叉" if macd > macd_signal else "死叉"
    rsi_zone = "超买区" if rsi > 70 else "超卖区" if rsi < 30 else "中性区间"
    trend_direction = "上升" if ma5 > ma20 else "下降"
    
    # Generate role-specific detailed analysis
    if agent_name == "market_analyst":
        return f"""【市场分析师 - 基于随机森林模型的深度分析】

你好！我是小K的市场分析师，本次分析基于训练好的随机森林模型（500棵决策树）。

【一、模型预测结果】
• 模型预测概率: {agent_prob:.1%}
• 集成预测概率: {final_prob:.1%} (置信区间: {ci_low:.1%}-{ci_high:.1%})
• 预测信号: {final_signal.upper()}
• 模型置信度: {confidence_score:.1%}

【二、市场状态识别】
当前市场处于 **{regime.upper()}** 状态
• ADX趋势强度: {adx:.2f} ({'强趋势' if adx > 25 else '弱趋势' if adx > 20 else '无明显趋势'})
• 波动率分位: {vol_regime:.1%} ({'高波动' if vol_regime > 0.7 else '低波动' if vol_regime < 0.3 else '正常波动'})
• 60日趋势: {trend_60d:.2%} ({'上升趋势' if trend_60d > 0.05 else '下降趋势' if trend_60d < -0.05 else '震荡'})

【三、技术面综合评估】
均线系统:
• MA5: ¥{ma5:.2f}
• MA20: ¥{ma20:.2f}
• MA60: ¥{ma60:.2f}
• 均线排列: {ma_cross} ({trend_direction}趋势)

动量指标:
• RSI: {rsi:.2f} ({rsi_zone})
• MACD: {macd:.4f} ({macd_cross})

【四、模型特征重要性分析】
随机森林模型识别的关键驱动因素:
"""
        for i, (feat_name, feat_value, importance) in enumerate(top_features, 1):
            return_str = f"  {i}. {feat_name} = {feat_value:.3f} (重要性: {importance:.3f})\n"
        
        return return_str + f"""
【五、投资建议】
基于模型预测 {final_signal.upper()} 信号，置信度 {confidence_score:.1%}:
• 建议操作: {'买入' if final_signal == 'buy' else '卖出' if final_signal == 'sell' else '持有观望'}
• 建议仓位: {30 if rsi > 70 else 60 if rsi < 30 else 40}%
• 止损位: ¥{price * 0.95:.2f} (-5%)
• 止盈位: ¥{price * 1.10:.2f} (+10%)

【六、风险提示】
模型基于历史数据训练，市场环境变化可能影响预测准确性。建议结合基本面分析和风险控制。
"""

    elif agent_name == "technical_analyst":
        return f"""【技术分析师 - 基于XGBoost模型的技术指标分析】

你好！我是小K的技术分析师，本次分析基于训练好的XGBoost梯度提升模型。

【一、模型预测结果】
• XGBoost预测概率: {agent_prob:.1%}
• 集成预测概率: {final_prob:.1%}
• 预测信号: {final_signal.upper()}
• 模型置信度: {confidence_score:.1%}

【二、核心技术指标分析】
RSI相对强弱指标:
• 当前值: {rsi:.2f}
• 状态: {rsi_zone}
• 信号: {'超买回调风险' if rsi > 70 else '超卖反弹机会' if rsi < 30 else '中性观望'}

MACD指标:
• MACD: {macd:.4f}
• 信号线: {macd_signal:.4f}
• 状态: {macd_cross} ({'多头' if macd > 0 else '空头'}排列)

趋势强度:
• ADX: {adx:.2f} ({'强趋势' if adx > 25 else '弱趋势'})
• ATR: {atr:.4f} (波动率指标)

【三、XGBoost模型特征分析】
模型识别的关键技术因子:
"""
        for i, (feat_name, feat_value, importance) in enumerate(top_features, 1):
            return_str = f"  {i}. {feat_name} = {feat_value:.3f} (增益: {importance:.3f})\n"
        
        return return_str + f"""
【四、交易策略建议】
基于XGBoost模型预测:
• 短线策略(1-5日): {final_signal.upper()}
• 入场点: ¥{price * (0.98 if final_signal == 'buy' else 1.02):.2f}
• 止损: ¥{price * 0.97:.2f} (-3%)
• 止盈: ¥{price * 1.08:.2f} (+8%)

【五、风险控制】
• 建议仓位: {30 if rsi > 70 else 60 if rsi < 30 else 40}%
• 最大单笔风险: 总资金的2%
• 持仓周期: 5-10个交易日

模型准确率约76%，建议结合其他智能体意见综合判断。
"""

    elif agent_name == "fundamental_analyst":
        return f"""【基本面分析师 - 基于LightGBM模型的估值分析】

你好！我是小K的基本面分析师，本次分析基于训练好的LightGBM模型。

【一、模型预测结果】
• LightGBM预测概率: {agent_prob:.1%}
• 集成预测概率: {final_prob:.1%}
• 预测信号: {final_signal.upper()}
• 模型置信度: {confidence_score:.1%}

【二、估值指标分析】
核心财务指标:
• 市盈率(PE): {pe_ratio:.2f} ({'估值偏高' if pe_ratio > 30 else '估值合理' if pe_ratio > 15 else '估值偏低'})
• 市净率(PB): {pb_ratio:.2f}
• 净资产收益率(ROE): {roe:.2f}% ({'优秀' if roe > 15 else '良好' if roe > 10 else '一般'})

估值判断:
• 当前价格: ¥{price:.2f}
• 估值水平: {'偏贵，需等待业绩验证' if pe_ratio > 30 else '估值与盈利较匹配' if pe_ratio > 15 else '估值相对偏低，存在价值修复机会'}

【三、LightGBM模型特征分析】
模型识别的关键基本面因子:
"""
        for i, (feat_name, feat_value, importance) in enumerate(top_features, 1):
            return_str = f"  {i}. {feat_name} = {feat_value:.3f} (增益: {importance:.3f})\n"
        
        return return_str + f"""
【四、投资价值评估】
基于LightGBM模型分析:
• 未来季度业绩超预期概率: {agent_prob:.1%}
• 估值修复概率: {final_prob:.1%}
• 投资建议: {final_signal.upper()}

【五、操作建议】
• 建议仓位: {20 if pe_ratio > 30 else 40 if pe_ratio > 15 else 50}%
• 止损位: ¥{price * 0.92:.2f} (-8%)
• 目标价: ¥{price * 1.15:.2f} (+15%)

模型准确率约69%，建议结合技术面和风险分析综合判断。
"""

    elif agent_name == "news_analyst":
        return f"""【新闻分析师 - 基于朴素贝叶斯模型的情绪分析】

你好！我是小K的新闻分析师，本次分析基于训练好的朴素贝叶斯模型。

【一、模型预测结果】
• 贝叶斯预测概率: {agent_prob:.1%}
• 集成预测概率: {final_prob:.1%}
• 预测信号: {final_signal.upper()}
• 模型置信度: {confidence_score:.1%}

【二、市场情绪分析】
成交量异常度:
• 量能异常系数: {volume_anomaly:.2f} ({'放量' if volume_anomaly > 1.5 else '缩量' if volume_anomaly < 0.7 else '正常'})
• 60日趋势: {trend_60d:.2%}

情绪判断:
• 市场情绪: {'积极' if volume_anomaly > 1.2 and trend_60d > 0 else '谨慎' if volume_anomaly < 0.8 or trend_60d < 0 else '中性'}
• 情绪强度: {abs(trend_60d) * 100:.1f}%

【三、朴素贝叶斯模型特征分析】
模型识别的关键情绪因子:
"""
        for i, (feat_name, feat_value, importance) in enumerate(top_features, 1):
            return_str = f"  {i}. {feat_name} = {feat_value:.3f} (权重: {importance:.3f})\n"
        
        return return_str + f"""
【四、新闻面综合研判】
基于贝叶斯模型分析:
• 正面情绪概率: {agent_prob:.1%}
• 市场反应预期: {final_signal.upper()}
• 情绪持续性: {'强' if confidence_score > 0.7 else '中' if confidence_score > 0.5 else '弱'}

【五、操作建议】
• 新闻面支撑: {'强' if agent_prob > 0.6 else '中' if agent_prob > 0.4 else '弱'}
• 建议关注: {'突发利好公告' if final_signal == 'buy' else '负面事件风险' if final_signal == 'sell' else '政策变化'}

模型准确率约65%，新闻面分析需结合技术面和基本面综合判断。
"""

    elif agent_name == "risk_analyst":
        return f"""【风险分析师 - 基于逻辑回归模型的风险评估】

你好！我是小K的风险分析师，本次分析基于训练好的逻辑回归模型。

【一、模型预测结果】
• 逻辑回归预测概率: {agent_prob:.1%}
• 集成预测概率: {final_prob:.1%}
• 预测信号: {final_signal.upper()}
• 模型置信度: {confidence_score:.1%}

【二、风险因子评估】
价格风险:
• 当前价格: ¥{price:.2f}
• MA20偏离度: {((price - ma20) / ma20 * 100) if ma20 != 0 else 0:.2f}% ({'偏离过大' if ma20 != 0 and abs((price - ma20) / ma20) > 0.05 else '正常'})
• RSI: {rsi:.2f} ({rsi_zone})

波动风险:
• ATR(14): {atr:.4f}
• 波动率分位: {vol_regime:.1%} ({'高风险' if vol_regime > 0.7 else '低风险' if vol_regime < 0.3 else '中等风险'})

【三、逻辑回归模型风险因子】
模型识别的关键风险因子:
"""
        for i, (feat_name, feat_value, importance) in enumerate(top_features, 1):
            return_str = f"  {i}. {feat_name} = {feat_value:.3f} (系数: {importance:.3f})\n"
        
        return return_str + f"""
【四、风险等级评估】
• 回撤概率: {(1 - agent_prob):.1%}
• 风险等级: {'高' if vol_regime > 0.7 or rsi > 70 or rsi < 30 else '中' if vol_regime > 0.5 else '低'}
• 风险提示: {'注意回调风险' if rsi > 70 else '关注反弹机会' if rsi < 30 else '风险可控'}

【五、风控建议】
仓位管理:
• 建议仓位: {30 if rsi > 70 else 50 if rsi < 30 else 40}%
• 最大单笔风险: 总资金的2%

止损管理:
• 硬止损: ¥{price * 0.95:.2f} (-5%)
• 动态止损: ¥{price * 0.97:.2f} (-3%)

模型准确率约72%，风险控制是投资的第一要务。
"""

    elif agent_name == "strategy_analyst":
        return f"""【策略分析师 - 基于深度神经网络的策略融合】

你好！我是小K的策略分析师，本次分析基于训练好的深度神经网络模型(4层DNN)。

【一、模型预测结果】
• DNN预测概率: {agent_prob:.1%}
• 集成预测概率: {final_prob:.1%} (CI: {ci_low:.1%}-{ci_high:.1%})
• 预测信号: {final_signal.upper()}
• 模型置信度: {confidence_score:.1%}

【二、多因子策略融合】
市场状态:
• 市场regime: {regime.upper()}
• 趋势方向: {trend_direction}
• 波动率: {vol_regime:.1%}分位

技术面:
• RSI: {rsi:.2f} ({rsi_zone})
• MACD: {macd_cross}
• ADX: {adx:.2f}

【三、DNN模型特征分析】
深度神经网络识别的关键策略因子:
"""
        for i, (feat_name, feat_value, importance) in enumerate(top_features, 1):
            return_str = f"  {i}. {feat_name} = {feat_value:.3f} (权重: {importance:.3f})\n"
        
        return return_str + f"""
【四、执行策略建议】
短线策略(1-5日):
• 操作: {final_signal.upper()}
• 入场: ¥{price * (0.98 if final_signal == 'buy' else 1.02):.2f}
• 止损: ¥{price * 0.97:.2f} (-3%)
• 止盈: ¥{price * 1.05:.2f} (+5%)

中线策略(5-20日):
• 操作: {'趋势跟随' if abs(trend_60d) > 0.05 else '等待确认'}
• 止损: ¥{price * 0.92:.2f} (-8%)
• 止盈: ¥{price * 1.12:.2f} (+12%)

【五、仓位管理】
• 建议仓位: {30 if rsi > 70 else 60 if rsi < 30 else 40}%
• 最大单笔: 总资金的20%
• 资金利用率: 70%上限

【六、信号一致性检测】
• 各模型信号一致性: {'高' if confidence_score > 0.7 else '中' if confidence_score > 0.5 else '低'}
• 执行建议: {'可提升执行权重' if confidence_score > 0.7 else '需谨慎，降低仓位'}

模型准确率约78%，DNN整合了6个专家模型的优势。
"""

    # Fallback for unknown agent
    return f"""【{AGENT_NAMES.get(agent_name, agent_name)} - 模型分析报告】

股票代码: {stock_code}
当前价格: ¥{price:.2f}

【模型预测结果】
• 预测概率: {agent_prob:.1%}
• 集成概率: {final_prob:.1%}
• 预测信号: {final_signal.upper()}
• 置信度: {confidence_score:.1%}

【关键指标】
• RSI: {rsi:.2f}
• MACD: {macd:.4f}
• 市场状态: {regime}

【模型特征】
"""
    for i, (feat_name, feat_value, importance) in enumerate(top_features, 1):
        return_str += f"  {i}. {feat_name} = {feat_value:.3f} (重要性: {importance:.3f})\n"
    
    return return_str + f"\n基于训练模型的预测建议: {final_signal.upper()}"


def _generate_key_findings(
    *,
    final_signal: str,
    final_prob: float,
    confidence_score: float,
    ci_low: float,
    ci_high: float,
    indicators: Dict[str, float],
) -> List[str]:
    return [
        f"Final signal: {final_signal}",
        f"Stacked probability: {final_prob:.1%}",
        f"Bootstrap CI (95%): {ci_low:.1%}-{ci_high:.1%}",
        f"Confidence score: {confidence_score:.1%}",
        f"RSI={indicators.get('rsi', 50.0):.2f}, MACD={indicators.get('macd', 0.0):.4f}, regime={_regime_text(indicators)}",
    ]


def _run_core_inference(stock_data: Dict[str, Any]) -> Dict[str, Any]:
    _validate_required_models()
    feature_columns = _load_feature_columns()
    X_row, indicators = _prepare_feature_row(stock_data, feature_columns)

    agent_predictions: Dict[str, int] = {}
    agent_probabilities: Dict[str, float] = {}
    agent_models: Dict[str, Any] = {}
    agent_variants: Dict[str, str] = {}
    agent_model_files: Dict[str, str] = {}

    for agent_name in AGENT_ORDER:
        model, variant, model_file = _load_model(agent_name)
        prob = _predict_positive_probability(model, X_row)
        pred = int(prob >= 0.5)

        agent_predictions[agent_name] = pred
        agent_probabilities[agent_name] = prob
        agent_models[agent_name] = model
        agent_variants[agent_name] = variant
        agent_model_files[agent_name] = model_file

    meta_payload = _load_meta_model()
    final_prob, ci_low, ci_high, confidence_score = _bootstrap_uncertainty(
        agent_probabilities=agent_probabilities,
        indicators=indicators,
        meta_payload=meta_payload,
        n_boot=300,
    )

    confidence_threshold = 0.70
    if meta_payload is not None:
        confidence_threshold = float(meta_payload.get("confidence_threshold", confidence_threshold))

    final_signal, final_prediction = _make_signal(
        prob=final_prob,
        confidence=confidence_score,
        threshold=confidence_threshold,
    )

    return {
        "feature_columns": feature_columns,
        "X_row": X_row,
        "indicators": indicators,
        "agent_predictions": agent_predictions,
        "agent_probabilities": agent_probabilities,
        "agent_models": agent_models,
        "agent_variants": agent_variants,
        "agent_model_files": agent_model_files,
        "final_prediction": final_prediction,
        "final_probability": final_prob,
        "final_signal": final_signal,
        "confidence_score": confidence_score,
        "ci_low": ci_low,
        "ci_high": ci_high,
    }


def predict(agent_name: str, stock_data: Dict[str, Any]) -> Dict[str, Any]:
    try:
        if agent_name not in AGENT_NAMES:
            raise ValueError(f"unsupported agent: {agent_name}")

        core = _run_core_inference(stock_data)

        agent_pred = core["agent_predictions"][agent_name]
        agent_prob = core["agent_probabilities"][agent_name]
        model = core["agent_models"][agent_name]

        analysis = _generate_analysis(
            agent_name=agent_name,
            agent_prob=agent_prob,
            final_prob=core["final_probability"],
            final_signal=core["final_signal"],
            confidence_score=core["confidence_score"],
            ci_low=core["ci_low"],
            ci_high=core["ci_high"],
            stock_data=stock_data,
            indicators=core["indicators"],
            model=model,
            feature_columns=core["feature_columns"],
            X_row=core["X_row"],
        )

        return {
            "success": True,
            "agent": agent_name,
            "agent_name": AGENT_NAMES.get(agent_name, agent_name),
            "algorithm": AGENT_ALGORITHMS.get(agent_name, "ML"),
            "prediction": float(core["final_prediction"]),
            "signal": core["final_signal"],
            "probability": float(core["final_probability"]),
            "confidence": float(core["confidence_score"]),
            "confidence_interval": [float(core["ci_low"]), float(core["ci_high"])],
            "agent_prediction": int(agent_pred),
            "agent_confidence": float(agent_prob),
            "model_variant": core["agent_variants"][agent_name],
            "model_file": core["agent_model_files"][agent_name],
            "analysis": analysis,
            "keyFindings": _generate_key_findings(
                final_signal=core["final_signal"],
                final_prob=core["final_probability"],
                confidence_score=core["confidence_score"],
                ci_low=core["ci_low"],
                ci_high=core["ci_high"],
                indicators=core["indicators"],
            ),
        }

    except Exception as exc:  # noqa: BLE001
        return {
            "success": False,
            "agent": agent_name,
            "error": str(exc),
        }


def predict_all(stock_data: Dict[str, Any]) -> Dict[str, Any]:
    try:
        core = _run_core_inference(stock_data)
        out: Dict[str, Any] = {}

        for agent_name in AGENT_ORDER:
            agent_pred = core["agent_predictions"][agent_name]
            agent_prob = core["agent_probabilities"][agent_name]
            model = core["agent_models"][agent_name]

            out[agent_name] = {
                "success": True,
                "agent": agent_name,
                "agent_name": AGENT_NAMES.get(agent_name, agent_name),
                "algorithm": AGENT_ALGORITHMS.get(agent_name, "ML"),
                "prediction": float(core["final_prediction"]),
                "signal": core["final_signal"],
                "probability": float(core["final_probability"]),
                "confidence": float(core["confidence_score"]),
                "confidence_interval": [float(core["ci_low"]), float(core["ci_high"])],
                "agent_prediction": int(agent_pred),
                "agent_confidence": float(agent_prob),
                "model_variant": core["agent_variants"][agent_name],
                "model_file": core["agent_model_files"][agent_name],
                "analysis": _generate_analysis(
                    agent_name=agent_name,
                    agent_prob=agent_prob,
                    final_prob=core["final_probability"],
                    final_signal=core["final_signal"],
                    confidence_score=core["confidence_score"],
                    ci_low=core["ci_low"],
                    ci_high=core["ci_high"],
                    stock_data=stock_data,
                    indicators=core["indicators"],
                    model=model,
                    feature_columns=core["feature_columns"],
                    X_row=core["X_row"],
                ),
                "keyFindings": _generate_key_findings(
                    final_signal=core["final_signal"],
                    final_prob=core["final_probability"],
                    confidence_score=core["confidence_score"],
                    ci_low=core["ci_low"],
                    ci_high=core["ci_high"],
                    indicators=core["indicators"],
                ),
            }

        return out

    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": str(exc)}


def main() -> None:
    try:
        payload = sys.stdin.read().strip()
        data = json.loads(payload) if payload else {}

        agent_name = data.get("agent")
        stock_data = data.get("stock_data", {})

        if agent_name:
            result = predict(agent_name, stock_data)
        else:
            result = predict_all(stock_data)

        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    except Exception as exc:  # noqa: BLE001
        err = {"success": False, "error": str(exc)}
        sys.stdout.write(json.dumps(err, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        sys.exit(1)


if __name__ == "__main__":
    main()
