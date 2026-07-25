/// @pattern Facade, Strategy
// KHY OS kernel MoonBit module
// Uses println() which routes through moonbit_println → serial output

fn main {
  println("[MOONBIT] MoonBit runtime initialized")
  println("[MOONBIT] KHY OS MoonBit kernel module v0.1.0")
  println("[MOONBIT] System Language: MoonBit")
  println("[MOONBIT] Target: Native (freestanding x86_64)")
  println("[MOONBIT] Memory Model: Reference Counting")
  // Demo: compute Fibonacci
  println("[MOONBIT] Computing Fibonacci sequence...")
  let result = fib(20)
  println("[MOONBIT] fib(20) = \{result}")
  println("[MOONBIT] Vision: Minimal kernel + WASM components")
  println("[MOONBIT] MoonBit module completed.")
}

/// Recursive Fibonacci
fn fib(n : Int) -> Int {
  if n <= 1 {
    n
  } else {
    fib(n - 1) + fib(n - 2)
  }
}
