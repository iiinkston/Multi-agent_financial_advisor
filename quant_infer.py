#!/usr/bin/env python3
"""
Quant inference wrapper for PPO models.
Reads JSON from stdin and returns JSON to stdout.
"""

import json
import math
import sys
from pathlib import Path

import numpy as np


STATE_FEATURES = [
    "return_1d",
    "return_5d",
    "return_10d",
    "MA_gap",
    "volatility_10",
    "volume_change",
    "RSI_14",
    "MACD",
    "trend_strength",
    "regime_volatility",
    "bull_flag",
    "downside_volatility",
    "rolling_downside_mean",
    "rolling_skewness",
    "trend_persistence",
    "recent_drawdown",
    "ma_slope",
    "bear_market_flag",
    "market_id",
]

SCALE_COLS = [
    "return_1d",
    "return_5d",
    "return_10d",
    "MA_gap",
    "volatility_10",
    "volume_change",
    "RSI_14",
    "MACD",
    "trend_strength",
    "regime_volatility",
    "bull_flag",
    "downside_volatility",
    "rolling_downside_mean",
    "rolling_skewness",
    "trend_persistence",
    "recent_drawdown",
    "ma_slope",
    "bear_market_flag",
]

DATASET_PATH = Path(__file__).resolve().parent / "knowledge" / "global_trading_dataset.csv"
MARKET_ID_FALLBACK = ["CN", "HK", "SG", "UK", "US"]
_scaler_cache = {}
_market_id_map = None


def clamp(value, min_value, max_value):
    return min(max_value, max(min_value, value))


def to_float(value):
    if value is None:
        return None
    try:
        v = float(value)
        if math.isfinite(v):
            return v
        return None
    except Exception:
        return None

def normalize_market(market):
    if not market:
        return market
    m = str(market).strip().lower()
    alias_map = {
        "sgx": "SG",
        "singapore": "SG",
        "hong kong": "HK",
        "hkex": "HK",
        "china": "CN",
        "a-share": "CN",
        "a share": "CN",
        "mainland china": "CN",
        "london": "UK",
        "lse": "UK",
        "united states": "US",
        "us market": "US",
        "nasdaq": "US",
        "nyse": "US",
    }
    if m in alias_map:
        return alias_map[m]
    upper = m.upper()
    if upper in ["US", "UK", "CN", "SG", "HK"]:
        return upper
    return market


def load_model_with_fallback(model_path):
    errors = []
    try:
        from stable_baselines3 import PPO

        return PPO.load(model_path), "PPO"
    except Exception as exc:
        errors.append(f"PPO.load failed: {exc}")

    try:
        from sb3_contrib import RecurrentPPO

        return RecurrentPPO.load(model_path), "RecurrentPPO"
    except Exception as exc:
        errors.append(f"RecurrentPPO.load failed: {exc}")

    raise RuntimeError("; ".join(errors))


def resolve_model_path(market):
    base_dir = Path(__file__).resolve().parent
    knowledge_dir = base_dir / "knowledge"

    if market == "US":
        primary = knowledge_dir / "ppo_trading_model_US.zip"
        fallback = knowledge_dir / "ppo_us_train_model.zip"
        return primary if primary.exists() else fallback

    alt = knowledge_dir / f"ppo_trading_model_{market}.zip"
    if alt.exists():
        return alt

    return knowledge_dir / "ppo_us_train_model.zip"


def get_market_id_map(notes):
    global _market_id_map
    if _market_id_map is not None:
        return _market_id_map

    if DATASET_PATH.exists():
        try:
            import pandas as pd

            df = pd.read_csv(DATASET_PATH)
            if "market" in df.columns:
                markets = sorted(m for m in df["market"].dropna().unique().tolist() if m)
                _market_id_map = {m: i for i, m in enumerate(markets)}
                notes.append(f"market_id_map=dataset_sorted:{_market_id_map}")
                return _market_id_map
        except Exception as exc:
            notes.append(f"market_id_map_dataset_error:{exc}")

    _market_id_map = {m: i for i, m in enumerate(sorted(MARKET_ID_FALLBACK))}
    notes.append(f"market_id_map=fallback_sorted:{_market_id_map}")
    return _market_id_map


def build_features(features, market, notes):
    data = dict(features or {})

    if "market_id" not in data:
        market_id_map = get_market_id_map(notes)
        if market in market_id_map:
            data["market_id"] = market_id_map[market]
        else:
            data["market_id"] = -1
            notes.append("market_id_missing: defaulted to -1")

    if "trend_strength" not in data and "MA_gap" in data:
        data["trend_strength"] = data.get("MA_gap")
        notes.append("trend_strength_derived_from_MA_gap")

    if "regime_volatility" not in data and "regime_volatility_raw" in data:
        data["regime_volatility"] = data.get("regime_volatility_raw")
        notes.append("regime_volatility_derived_from_regime_volatility_raw")

    if "volatility_10" not in data and "volatility_10_raw" in data:
        data["volatility_10"] = data.get("volatility_10_raw")
        notes.append("volatility_10_derived_from_volatility_10_raw")

    if "MA_gap" not in data and "MA_5" in data and "MA_20" in data:
        ma_5 = to_float(data.get("MA_5"))
        ma_20 = to_float(data.get("MA_20"))
        if ma_5 is not None and ma_20 not in (None, 0):
            data["MA_gap"] = (ma_5 / ma_20) - 1
            notes.append("MA_gap_derived_from_MA_5_MA_20")

    if "bull_flag" not in data and "MA_5" in data and "MA_20" in data:
        ma_5 = to_float(data.get("MA_5"))
        ma_20 = to_float(data.get("MA_20"))
        if ma_5 is not None and ma_20 is not None:
            data["bull_flag"] = int(ma_5 > ma_20)
            notes.append("bull_flag_derived_from_MA_5_MA_20")

    if "bear_market_flag" not in data and "close" in data and "MA_50" in data:
        close = to_float(data.get("close"))
        ma_50 = to_float(data.get("MA_50"))
        if close is not None and ma_50 is not None:
            data["bear_market_flag"] = int(close < ma_50)
            notes.append("bear_market_flag_derived_from_close_MA_50")

    return data


def build_observation(features, position, notes):
    missing = [f for f in STATE_FEATURES if f not in features]
    if missing:
        raise ValueError(f"missing_features: {missing}")

    observation = []
    for name in STATE_FEATURES:
        val = to_float(features.get(name))
        if val is None:
            raise ValueError(f"invalid_feature_value: {name}")
        observation.append(val)

    position_val = to_float(position)
    if position_val is None:
        position_val = 0.0
        notes.append("position_defaulted_to_0")

    observation.append(position_val)
    return np.array(observation, dtype=np.float32)


def map_signal(raw_action):
    if raw_action > 0.1:
        return "BUY"
    if raw_action < -0.1:
        return "SELL"
    return "HOLD"


def predict_with_model(model, observation, loader, notes):
    try:
        if loader == "RecurrentPPO":
            action, _state = model.predict(
                observation, state=None, episode_start=np.array([True]), deterministic=True
            )
        else:
            action, _state = model.predict(observation, deterministic=True)
        raw_action = float(np.asarray(action).item())
        raw_action = float(clamp(raw_action, -1.0, 1.0))
        return raw_action
    except Exception as exc:
        notes.append(f"predict_error: {exc}")
        raise


def compute_scaler_stats(market, notes):
    cache_key = market
    if cache_key in _scaler_cache:
        return _scaler_cache[cache_key]

    if not DATASET_PATH.exists():
        notes.append("scaler_mode=none:dataset_missing")
        _scaler_cache[cache_key] = None
        return None

    try:
        import pandas as pd
    except Exception as exc:
        notes.append(f"scaler_mode=none:pandas_missing:{exc}")
        _scaler_cache[cache_key] = None
        return None

    df_all = pd.read_csv(DATASET_PATH)
    if "date" in df_all.columns:
        df_all["date"] = pd.to_datetime(df_all["date"])

    df_all = df_all.sort_values(["market", "date"]).reset_index(drop=True)

    df_all["raw_return_1d"] = df_all.groupby("market")["close"].pct_change()
    df_all["return_5d"] = df_all.groupby("market")["close"].pct_change(5)
    df_all["return_10d"] = df_all.groupby("market")["close"].pct_change(10)

    df_all["MA_5"] = df_all.groupby("market")["close"].transform(lambda x: x.rolling(5).mean())
    df_all["MA_20"] = df_all.groupby("market")["close"].transform(lambda x: x.rolling(20).mean())
    df_all["MA_gap"] = (df_all["MA_5"] / df_all["MA_20"]) - 1
    df_all["trend_strength"] = df_all["MA_gap"]
    df_all["MA_gap_raw"] = df_all["MA_gap"]
    df_all["trend_strength_raw"] = df_all["trend_strength"]

    df_all["bull_flag"] = (df_all["MA_5"] > df_all["MA_20"]).astype(int)
    df_all["MA_50"] = df_all.groupby("market")["close"].transform(lambda x: x.rolling(50).mean())
    df_all["bear_market_flag"] = (df_all["close"] < df_all["MA_50"]).astype(int)

    def rolling_downside_mean(series, window=20):
        neg = series.copy()
        neg[neg > 0] = 0.0
        return neg.rolling(window).mean()

    df_all["rolling_downside_mean"] = (
        df_all.groupby("market")["raw_return_1d"].transform(lambda x: rolling_downside_mean(x, 20))
    )

    def trend_persistence(series, window=20):
        return np.sign(series).rolling(window).mean()

    df_all["trend_persistence"] = (
        df_all.groupby("market")["raw_return_1d"].transform(lambda x: trend_persistence(x, 20))
    )

    df_all["regime_volatility_raw"] = (
        df_all.groupby("market")["raw_return_1d"].transform(lambda x: x.rolling(20).std())
    )
    df_all["regime_volatility"] = df_all["regime_volatility_raw"]

    df_all["volatility_10"] = (
        df_all.groupby("market")["raw_return_1d"].transform(lambda x: x.rolling(10).std())
    )
    df_all["volatility_10_raw"] = df_all["volatility_10"]

    def downside_volatility(series, window=20):
        neg = series.copy()
        neg[neg > 0] = 0.0
        return neg.rolling(window).std()

    df_all["downside_volatility"] = (
        df_all.groupby("market")["raw_return_1d"].transform(lambda x: downside_volatility(x, 20))
    )

    df_all["rolling_skewness"] = (
        df_all.groupby("market")["raw_return_1d"].transform(lambda x: x.rolling(20).skew())
    )

    def rolling_drawdown(close_series, window=60):
        rolling_max = close_series.rolling(window).max()
        return (close_series / (rolling_max + 1e-8)) - 1.0

    df_all["recent_drawdown"] = (
        df_all.groupby("market")["close"].transform(lambda x: rolling_drawdown(x, 60))
    )

    df_all["ma_slope"] = df_all.groupby("market")["MA_20"].transform(lambda x: x.diff(5) / 5.0)

    df_all["volume_change"] = df_all.groupby("market")["volume"].pct_change()

    def compute_rsi(series, window=14):
        delta = series.diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        avg_gain = gain.rolling(window).mean()
        avg_loss = loss.rolling(window).mean()
        rs = avg_gain / (avg_loss + 1e-8)
        return 100 - (100 / (1 + rs))

    df_all["RSI_14"] = df_all.groupby("market")["close"].transform(lambda x: compute_rsi(x, 14))

    ema12 = df_all.groupby("market")["close"].transform(lambda x: x.ewm(span=12).mean())
    ema26 = df_all.groupby("market")["close"].transform(lambda x: x.ewm(span=26).mean())
    df_all["MACD"] = ema12 - ema26

    market_id_map = {m: i for i, m in enumerate(sorted(df_all["market"].dropna().unique().tolist()))}
    df_all["market_id"] = df_all["market"].map(market_id_map).astype(int)

    df_all = df_all.replace([np.inf, -np.inf], np.nan)

    dropna_cols = [
        "raw_return_1d",
        "return_5d",
        "return_10d",
        "MA_5",
        "MA_20",
        "MA_50",
        "MA_gap",
        "volatility_10",
        "volume_change",
        "RSI_14",
        "MACD",
        "trend_strength",
        "bull_flag",
        "bear_market_flag",
        "regime_volatility_raw",
        "regime_volatility",
        "downside_volatility",
        "rolling_downside_mean",
        "rolling_skewness",
        "trend_persistence",
        "recent_drawdown",
        "ma_slope",
    ]
    df_all = df_all.dropna(subset=dropna_cols).reset_index(drop=True)

    df_market = df_all[df_all["market"] == market].sort_values("date").reset_index(drop=True)
    if df_market.empty:
        notes.append("scaler_mode=none:market_not_found_in_dataset")
        _scaler_cache[cache_key] = None
        return None

    n = len(df_market)
    train_end = int(n * 0.6)
    df_train = df_market.iloc[:train_end].copy()

    means = df_train[SCALE_COLS].mean().to_dict()
    stds = df_train[SCALE_COLS].std(ddof=0).to_dict()

    stats = {"means": means, "stds": stds}
    _scaler_cache[cache_key] = stats
    notes.append("scaler_mode=dataset_train_split")
    return stats


def apply_scaling(features, market, notes):
    stats = compute_scaler_stats(market, notes)
    if not stats:
        notes.append("scaler_applied=false")
        return features

    means = stats["means"]
    stds = stats["stds"]
    scaled = dict(features)
    for col in SCALE_COLS:
        if col in scaled:
            mean = means.get(col, 0.0)
            std = stds.get(col, 0.0)
            val = to_float(scaled.get(col))
            if val is None:
                continue
            if std == 0 or std is None:
                scaled[col] = 0.0
            else:
                scaled[col] = (val - mean) / std
            scaled[col] = float(clamp(scaled[col], -5.0, 5.0))

    notes.append("scaler_applied=true")
    return scaled


def validate_observation(observation, expected_len):
    if len(observation) != expected_len:
        raise ValueError(f"observation_length_mismatch:{len(observation)}!=expected:{expected_len}")
    if np.isnan(observation).any():
        raise ValueError("observation_contains_nan")
    if np.isinf(observation).any():
        raise ValueError("observation_contains_inf")


def main():
    raw_input = sys.stdin.read().strip()
    if not raw_input:
        print(json.dumps({"error": "Missing input payload"}))
        return

    try:
        payload = json.loads(raw_input)
    except Exception as exc:
        print(json.dumps({"error": f"Invalid JSON input: {exc}"}))
        return

    market = payload.get("market")
    ticker = payload.get("ticker")
    features = payload.get("features", {})
    position = payload.get("position", 0.0)

    notes = []
    model_path = None
    loader_used = None

    try:
        if not market:
            raise ValueError("missing_market")

        normalized_market = normalize_market(market)
        if normalized_market != market:
            notes.append(f"market_input={market}")
            notes.append(f"market_normalized={normalized_market}")
        market = normalized_market

        if not ticker:
            raise ValueError("missing_ticker")

        model_path = resolve_model_path(market)
        if not model_path.exists():
            raise FileNotFoundError(f"model_not_found: {model_path}")

        model, loader_used = load_model_with_fallback(str(model_path))

        features = build_features(features, market, notes)
        features = apply_scaling(features, market, notes)

        observation = build_observation(features, position, notes)
        validate_observation(observation, len(STATE_FEATURES) + 1)

        raw_action = predict_with_model(model, observation, loader_used, notes)

        signal = map_signal(raw_action)
        confidence = float(clamp(abs(raw_action), 0.2, 0.95))

        result = {
            "signal": signal,
            "position": raw_action,
            "confidence": confidence,
            "raw_action": raw_action,
            "model_name": model_path.name,
            "market": market,
            "ticker": ticker,
            "feature_snapshot": {k: features.get(k) for k in STATE_FEATURES},
            "notes": notes
            + [
                f"model_path={model_path}",
                f"loader={loader_used}",
                f"observation_len={len(observation)}",
            ],
        }
        print(json.dumps(result))
    except Exception as exc:
        error_payload = {
            "error": str(exc),
            "market": market,
            "ticker": ticker,
            "notes": notes
            + [
                f"model_path={model_path}" if model_path else "model_path=None",
                f"loader={loader_used}" if loader_used else "loader=None",
            ],
        }
        print(json.dumps(error_payload))


if __name__ == "__main__":
    main()
