/// @pattern Strategy, Template Method
// Whitebox tests run within the package scope.
// Validate internal computation accuracy.

test "sma sliding window correctness" {
  let data = [2.0, 4.0, 6.0, 8.0, 10.0]
  let result = sma(data, 2)
  assert_eq(result[1], 3.0) // (2+4)/2
  assert_eq(result[2], 5.0) // (4+6)/2
  assert_eq(result[3], 7.0) // (6+8)/2
  assert_eq(result[4], 9.0) // (8+10)/2
}

test "ema smoothing" {
  let data = [44.0, 44.25, 44.50, 43.75, 44.50]
  let result = ema(data, 3)
  // k = 0.5, seed = (44+44.25+44.5)/3 = 44.25
  assert_true((result[2] - 44.25).abs() < 0.001)
}

test "rsi mixed movement" {
  let data = [44.0, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84]
  let result = rsi(data, 7)
  // At index 7, RSI should be calculable
  assert_true(!result[7].is_nan())
  assert_true(result[7] > 0.0 && result[7] < 100.0)
}

test "macd structure" {
  let data : Array[Double] = Array::make(50, 0.0)
  for i = 0; i < 50; i = i + 1 {
    data[i] = 100.0 + i.to_double() * 0.5
  }
  let (macd_line, signal_line, histogram) = macd(data, 12, 26, 9)
  // MACD should be valid after slow_period-1 = 25
  assert_true(!macd_line[25].is_nan())
  // Signal should be valid after 25 + 9 - 1 = 33
  assert_true(!signal_line[33].is_nan())
  assert_true(!histogram[33].is_nan())
}
