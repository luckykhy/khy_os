/// @pattern Facade, Strategy
///|
/// WASM entry point — demonstrates indicator usage.
/// In production, the host calls library functions directly via WASM exports.
fn main {
  let close_prices = [
    100.0, 101.5, 103.0, 102.0, 104.5,
    106.0, 105.5, 107.0, 108.5, 110.0,
    109.0, 111.5, 113.0, 112.0, 114.5,
    116.0, 115.5, 117.0, 118.5, 120.0,
    119.0, 121.5, 123.0, 122.0, 124.5,
    126.0, 125.5, 127.0, 128.5, 130.0,
  ]
  // SMA-5
  let sma5 = @ind.sma(close_prices, 5)
  println("SMA(5) last: \{sma5[29]}")
  // EMA-12
  let ema12 = @ind.ema(close_prices, 12)
  println("EMA(12) last: \{ema12[29]}")
  // RSI-14
  let rsi14 = @ind.rsi(close_prices, 14)
  println("RSI(14) last: \{rsi14[29]}")
  // MACD(12,26,9)
  let (macd_line, signal, hist) = @ind.macd(close_prices, 12, 26, 9)
  println("MACD last: \{macd_line[29]}, Signal: \{signal[29]}, Hist: \{hist[29]}")
  // Bollinger Bands(20, 2)
  let (upper, middle, lower) = @ind.bollinger_bands(close_prices, 20, 2.0)
  println("BB(20) upper: \{upper[29]}, middle: \{middle[29]}, lower: \{lower[29]}")
}
