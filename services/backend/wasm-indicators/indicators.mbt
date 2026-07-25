/// @pattern Strategy
// Core technical indicator algorithms for quantitative trading.
// Pure computation — no IO, no side effects.

/// Simple Moving Average (SMA)
/// Returns array of same length as input; first (period-1) values are NaN.
pub fn sma(data : Array[Double], period : Int) -> Array[Double] {
  let n = data.length()
  let result : Array[Double] = Array::make(n, @double.not_a_number)
  if period <= 0 || period > n {
    return result
  }
  let mut sum = 0.0
  for i = 0; i < period; i = i + 1 {
    sum = sum + data[i]
  }
  result[period - 1] = sum / period.to_double()
  for i = period; i < n; i = i + 1 {
    sum = sum + data[i] - data[i - period]
    result[i] = sum / period.to_double()
  }
  result
}

/// Exponential Moving Average (EMA)
/// Uses smoothing factor k = 2 / (period + 1).
pub fn ema(data : Array[Double], period : Int) -> Array[Double] {
  let n = data.length()
  let result : Array[Double] = Array::make(n, @double.not_a_number)
  if period <= 0 || period > n {
    return result
  }
  // Seed with SMA of first `period` values
  let mut sum = 0.0
  for i = 0; i < period; i = i + 1 {
    sum = sum + data[i]
  }
  let seed = sum / period.to_double()
  result[period - 1] = seed
  let k = 2.0 / (period.to_double() + 1.0)
  let mut prev = seed
  for i = period; i < n; i = i + 1 {
    let val = data[i] * k + prev * (1.0 - k)
    result[i] = val
    prev = val
  }
  result
}

/// MACD (Moving Average Convergence Divergence)
/// Returns (macd_line, signal_line, histogram).
pub fn macd(
  data : Array[Double],
  fast_period : Int,
  slow_period : Int,
  signal_period : Int
) -> (Array[Double], Array[Double], Array[Double]) {
  let n = data.length()
  let ema_fast = ema(data, fast_period)
  let ema_slow = ema(data, slow_period)
  let macd_line : Array[Double] = Array::make(n, @double.not_a_number)
  // MACD line = EMA_fast - EMA_slow
  for i = 0; i < n; i = i + 1 {
    if !ema_fast[i].is_nan() && !ema_slow[i].is_nan() {
      macd_line[i] = ema_fast[i] - ema_slow[i]
    }
  }
  // Signal line = EMA of MACD line
  // Collect valid MACD values for EMA calculation
  let valid_start = slow_period - 1 // first valid MACD index
  let valid_data : Array[Double] = []
  for i = valid_start; i < n; i = i + 1 {
    valid_data.push(macd_line[i])
  }
  let signal_raw = ema(valid_data, signal_period)
  let signal_line : Array[Double] = Array::make(n, @double.not_a_number)
  let histogram : Array[Double] = Array::make(n, @double.not_a_number)
  for i = 0; i < valid_data.length(); i = i + 1 {
    let idx = i + valid_start
    signal_line[idx] = signal_raw[i]
    if !signal_raw[i].is_nan() && !macd_line[idx].is_nan() {
      histogram[idx] = macd_line[idx] - signal_raw[i]
    }
  }
  (macd_line, signal_line, histogram)
}

/// Relative Strength Index (RSI)
/// Uses Wilder's smoothing method.
pub fn rsi(data : Array[Double], period : Int) -> Array[Double] {
  let n = data.length()
  let result : Array[Double] = Array::make(n, @double.not_a_number)
  if period <= 0 || period >= n {
    return result
  }
  // Calculate initial average gain/loss
  let mut avg_gain = 0.0
  let mut avg_loss = 0.0
  for i = 1; i <= period; i = i + 1 {
    let change = data[i] - data[i - 1]
    if change > 0.0 {
      avg_gain = avg_gain + change
    } else {
      avg_loss = avg_loss - change // make positive
    }
  }
  avg_gain = avg_gain / period.to_double()
  avg_loss = avg_loss / period.to_double()
  if avg_loss == 0.0 {
    result[period] = 100.0
  } else {
    result[period] = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
  }
  // Subsequent values: Wilder's smoothing
  let period_f = period.to_double()
  for i = period + 1; i < n; i = i + 1 {
    let change = data[i] - data[i - 1]
    let gain = if change > 0.0 { change } else { 0.0 }
    let loss = if change < 0.0 { -change } else { 0.0 }
    avg_gain = (avg_gain * (period_f - 1.0) + gain) / period_f
    avg_loss = (avg_loss * (period_f - 1.0) + loss) / period_f
    if avg_loss == 0.0 {
      result[i] = 100.0
    } else {
      result[i] = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    }
  }
  result
}

/// Bollinger Bands
/// Returns (upper, middle, lower).
pub fn bollinger_bands(
  data : Array[Double],
  period : Int,
  num_std : Double
) -> (Array[Double], Array[Double], Array[Double]) {
  let n = data.length()
  let middle = sma(data, period)
  let upper : Array[Double] = Array::make(n, @double.not_a_number)
  let lower : Array[Double] = Array::make(n, @double.not_a_number)
  for i = period - 1; i < n; i = i + 1 {
    // Calculate standard deviation over window
    let mut sum_sq = 0.0
    let mean = middle[i]
    for j = i - period + 1; j <= i; j = j + 1 {
      let diff = data[j] - mean
      sum_sq = sum_sq + diff * diff
    }
    let std = (sum_sq / period.to_double()).sqrt()
    upper[i] = mean + num_std * std
    lower[i] = mean - num_std * std
  }
  (upper, middle, lower)
}
