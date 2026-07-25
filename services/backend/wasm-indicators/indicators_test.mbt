/// @pattern Strategy, Template Method
// Blackbox tests run against the package's public API.
// Run `moon test` to execute.

test "sma basic" {
  let data = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
  let result = @indicators.sma(data, 3)
  // First 2 should be NaN
  assert_true(result[0].is_nan())
  assert_true(result[1].is_nan())
  // SMA(3) at index 2 = (1+2+3)/3 = 2.0
  assert_eq(result[2], 2.0)
  // SMA(3) at index 9 = (8+9+10)/3 = 9.0
  assert_eq(result[9], 9.0)
}

test "ema basic" {
  let data = [10.0, 11.0, 12.0, 13.0, 14.0, 15.0]
  let result = @indicators.ema(data, 3)
  // Seed = (10+11+12)/3 = 11.0
  assert_eq(result[2], 11.0)
  // k = 2/(3+1) = 0.5; EMA[3] = 13*0.5 + 11*0.5 = 12.0
  assert_eq(result[3], 12.0)
}

test "rsi monotonic increase" {
  // Monotonically increasing => RSI should be 100
  let data = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
  let result = @indicators.rsi(data, 5)
  assert_eq(result[5], 100.0)
}

test "bollinger bands flat" {
  let data = [20.0, 20.0, 20.0, 20.0, 20.0]
  let (upper, middle, lower) = @indicators.bollinger_bands(data, 5, 2.0)
  // All same values => std = 0, bands collapse to mean
  assert_eq(middle[4], 20.0)
  assert_eq(upper[4], 20.0)
  assert_eq(lower[4], 20.0)
}
