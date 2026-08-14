/// @pattern Facade, Strategy
///|
/// WASM entry point — re-exports chain primitives for the Node.js host.
/// All functions use integer/string signatures for WASM export compatibility.

// NOTE: WASM-GC export functions must take/return primitives.
// String arrays cannot be directly exported; the Node.js host calls
// these via the WASM instance with JS-managed string arrays.

/// Re-export: render a prompt template with variable substitution.
pub fn render_template(
  template : String,
  keys : Array[String],
  values : Array[String]
) -> String {
  @chain.render_template(template, keys, values)
}

/// Re-export: count {placeholders} in a template.
pub fn count_placeholders(template : String) -> Int {
  @chain.count_placeholders(template)
}

/// Re-export: extract placeholder names as JSON array.
pub fn extract_placeholders(template : String) -> String {
  @chain.extract_placeholders(template)
}

/// Re-export: format conversation history buffer.
pub fn format_history(
  inputs : Array[String],
  outputs : Array[String],
  max_turns : Int
) -> String {
  @chain.format_history(inputs, outputs, max_turns)
}

/// Re-export: estimate tokens in history buffer.
pub fn estimate_history_tokens(
  inputs : Array[String],
  outputs : Array[String],
  max_turns : Int
) -> Int {
  @chain.estimate_history_tokens(inputs, outputs, max_turns)
}

/// Re-export: calculate max turns that fit in token budget.
pub fn max_turns_for_budget(
  inputs : Array[String],
  outputs : Array[String],
  token_budget : Int
) -> Int {
  @chain.max_turns_for_budget(inputs, outputs, token_budget)
}

/// Re-export: parse ReAct-style LLM response.
pub fn parse_react_response(response : String) -> String {
  @chain.parse_react_response(response)
}

/// Re-export: validate chain input.
pub fn validate_input(input : String, max_length : Int) -> Int {
  @chain.validate_input(input, max_length)
}

/// Re-export: estimate total chain prompt tokens.
pub fn estimate_chain_tokens(
  template_len : Int,
  input_len : Int,
  history_tokens : Int
) -> Int {
  @chain.estimate_chain_tokens(template_len, input_len, history_tokens)
}

fn main {
  println("chain WASM loaded")
}
