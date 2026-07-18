/// @pattern Facade, Strategy
///|
/// WASM entry point — re-exports context utility functions for the host.
/// Integer-only signatures to ensure WASM export compatibility.

/// Re-export: estimate token count with 1.2x safety margin.
pub fn estimate_tokens(text_len : Int) -> Int {
  @ctx.estimate_tokens(text_len)
}

/// Re-export: estimate tokens with custom safety margin.
pub fn estimate_tokens_with_margin(text_len : Int, safety_num : Int) -> Int {
  @ctx.estimate_tokens_with_margin(text_len, safety_num)
}

/// Re-export: check overflow against budget.
pub fn check_overflow(total_tokens : Int, budget : Int, safety_num : Int) -> Int {
  @ctx.check_overflow(total_tokens, budget, safety_num)
}

/// Re-export: single tool result cap (50% of budget).
pub fn single_tool_result_cap(context_budget : Int) -> Int {
  @ctx.single_tool_result_cap(context_budget)
}

/// Re-export: preemptive overflow threshold (90% of budget).
pub fn preemptive_threshold(context_budget : Int) -> Int {
  @ctx.preemptive_threshold(context_budget)
}

/// Re-export: calculate truncation position.
pub fn truncate_position(data_len : Int, max_chars : Int) -> Int {
  @ctx.truncate_position(data_len, max_chars)
}

fn main {
  println("context_utils WASM loaded")
}
