/// @pattern Strategy
// chain.mbt — Chain execution primitives for KHY OS AI subsystem.
// Compiled to WASM-GC and loaded by Node.js chainWasm.js.
//
// Provides hot-path functions that the Node.js chain orchestrator calls:
//   - Prompt template rendering (variable substitution)
//   - Memory buffer management (turn tracking, token-aware truncation)
//   - Tool dispatch protocol (ReAct action parsing)
//   - Input validation and sanitization

// ── Prompt Templating ──────────────────────────────────────────────

/// Render a prompt template by substituting {key} placeholders.
/// Keys and values are passed as parallel arrays.
/// Returns the rendered prompt string.
///
/// Example:
///   render_template("Hello {name}, you said {input}",
///     ["name", "input"], ["Alice", "hi"])
///   → "Hello Alice, you said hi"
pub fn render_template(
  template : String,
  keys : Array[String],
  values : Array[String]
) -> String {
  let mut result = template
  let count = if keys.length() < values.length() {
    keys.length()
  } else {
    values.length()
  }
  for i = 0; i < count; i = i + 1 {
    let placeholder = "{" + keys[i] + "}"
    result = string_replace(result, placeholder, values[i])
  }
  result
}

/// Replace all occurrences of `old` with `new_str` in `s`.
fn string_replace(s : String, old : String, new_str : String) -> String {
  if old.length() == 0 {
    return s
  }
  let mut result = ""
  let mut i = 0
  while i < s.length() {
    if i + old.length() <= s.length() && s[i:i + old.length()].to_owned() == old {
      result = result + new_str
      i = i + old.length()
    } else {
      result = result + s[i:i + 1].to_owned()
      i = i + 1
    }
  }
  result
}

/// Count the number of {placeholders} in a template string.
/// Used by Node.js to validate that all required variables are provided.
pub fn count_placeholders(template : String) -> Int {
  let mut count = 0
  let mut i = 0
  while i < template.length() {
    if template[i] == '{' {
      let mut j = i + 1
      while j < template.length() && template[j] != '}' && template[j] != '{' {
        j = j + 1
      }
      if j < template.length() && template[j] == '}' && j > i + 1 {
        count = count + 1
        i = j + 1
      } else {
        i = i + 1
      }
    } else {
      i = i + 1
    }
  }
  count
}

/// Extract placeholder names from a template string.
/// Returns them as a JSON array string: ["name", "input"]
pub fn extract_placeholders(template : String) -> String {
  let mut result = "["
  let mut first = true
  let mut i = 0
  while i < template.length() {
    if template[i] == '{' {
      let mut j = i + 1
      while j < template.length() && template[j] != '}' && template[j] != '{' {
        j = j + 1
      }
      if j < template.length() && template[j] == '}' && j > i + 1 {
        let name = template[i + 1:j].to_owned()
        if !first {
          result = result + ","
        }
        result = result + "\"" + name + "\""
        first = false
        i = j + 1
      } else {
        i = i + 1
      }
    } else {
      i = i + 1
    }
  }
  result + "]"
}

// ── Memory Buffer ──────────────────────────────────────────────────

/// Format a conversation history buffer into a prompt-friendly string.
/// Inputs/outputs are parallel arrays representing turns.
///
/// Returns formatted string like:
///   Human: hello
///   AI: hi there
///   Human: how are you
///   AI: I'm good
pub fn format_history(
  inputs : Array[String],
  outputs : Array[String],
  max_turns : Int
) -> String {
  let total = if inputs.length() < outputs.length() {
    inputs.length()
  } else {
    outputs.length()
  }
  let start = if total > max_turns && max_turns > 0 {
    total - max_turns
  } else {
    0
  }

  let mut result = ""
  for i = start; i < total; i = i + 1 {
    if i > start {
      result = result + "\n"
    }
    result = result + "Human: " + inputs[i] + "\nAI: " + outputs[i]
  }
  result
}

/// Estimate the token count of a history buffer.
/// Uses the same 4-chars-per-token heuristic as context_utils.
pub fn estimate_history_tokens(
  inputs : Array[String],
  outputs : Array[String],
  max_turns : Int
) -> Int {
  let total = if inputs.length() < outputs.length() {
    inputs.length()
  } else {
    outputs.length()
  }
  let start = if total > max_turns && max_turns > 0 {
    total - max_turns
  } else {
    0
  }

  let mut char_count = 0
  for i = start; i < total; i = i + 1 {
    // "Human: " = 7, "\nAI: " = 5, "\n" = 1
    char_count = char_count + 7 + inputs[i].length() + 5 + outputs[i].length() + 1
  }
  // 4 chars per token, 1.2x safety margin
  let raw = (char_count + 3) / 4
  (raw * 12 + 9) / 10
}

/// Calculate the maximum number of turns that fit within a token budget.
/// Works backwards from the most recent turn.
pub fn max_turns_for_budget(
  inputs : Array[String],
  outputs : Array[String],
  token_budget : Int
) -> Int {
  let total = if inputs.length() < outputs.length() {
    inputs.length()
  } else {
    outputs.length()
  }

  let mut turns = 0
  let mut tokens_used = 0
  let mut i = total - 1
  while i >= 0 && turns < total {
    let turn_chars = 7 + inputs[i].length() + 5 + outputs[i].length() + 1
    let turn_tokens = ((turn_chars + 3) / 4 * 12 + 9) / 10
    if tokens_used + turn_tokens > token_budget {
      break
    }
    tokens_used = tokens_used + turn_tokens
    turns = turns + 1
    i = i - 1
  }
  turns
}

// ── ReAct Protocol Parsing ─────────────────────────────────────────

/// Parse a ReAct-style LLM response to extract action and input.
/// Returns action as JSON: {"type":"action","tool":"name","input":"value"}
///   or: {"type":"final","answer":"text"}
///   or: {"type":"text","content":"raw response"}
pub fn parse_react_response(response : String) -> String {
  // Check for Final Answer
  let final_idx = string_index_of(response, "Final Answer:")
  if final_idx >= 0 {
    let answer = string_trim(response[final_idx + 13:response.length()].to_owned())
    return "{\"type\":\"final\",\"answer\":\"" + escape_json(answer) + "\"}"
  }

  // Check for Action + Action Input
  let action_idx = string_index_of(response, "Action:")
  let input_idx = string_index_of(response, "Action Input:")

  if action_idx >= 0 && input_idx >= 0 {
    // Extract tool name (between "Action:" and newline or "Action Input:")
    let action_start = action_idx + 7
    let action_end = if input_idx > action_start {
      input_idx
    } else {
      response.length()
    }
    let tool = string_trim(response[action_start:action_end].to_owned())

    // Extract tool input (after "Action Input:" to end or next newline)
    let input_start = input_idx + 13
    let mut input_end = response.length()
    // Find end of line
    let mut k = input_start
    while k < response.length() {
      if response[k] == '\n' {
        input_end = k
        break
      }
      k = k + 1
    }
    let tool_input = string_trim(response[input_start:input_end].to_owned())

    return "{\"type\":\"action\",\"tool\":\"" +
      escape_json(tool) +
      "\",\"input\":\"" +
      escape_json(tool_input) +
      "\"}"
  }

  // Plain text response
  "{\"type\":\"text\",\"content\":\"" + escape_json(response) + "\"}"
}

// ── Input Validation ───────────────────────────────────────────────

/// Validate chain input: check length and basic sanitization.
/// Returns 0 if valid, negative error code otherwise.
///   -1: input too long
///   -2: input empty
pub fn validate_input(input : String, max_length : Int) -> Int {
  if input.length() == 0 {
    return -2
  }
  if max_length > 0 && input.length() > max_length {
    return -1
  }
  0
}

/// Estimate the total prompt tokens for a chain call.
/// Combines template, input, and history tokens.
pub fn estimate_chain_tokens(
  template_len : Int,
  input_len : Int,
  history_tokens : Int
) -> Int {
  let text_tokens = ((template_len + input_len + 3) / 4 * 12 + 9) / 10
  text_tokens + history_tokens
}

// ── String Utilities ───────────────────────────────────────────────

/// Find the first occurrence of `needle` in `haystack`.
/// Returns the index or -1 if not found.
fn string_index_of(haystack : String, needle : String) -> Int {
  if needle.length() == 0 {
    return 0
  }
  if needle.length() > haystack.length() {
    return -1
  }
  let limit = haystack.length() - needle.length()
  for i = 0; i <= limit; i = i + 1 {
    if haystack[i:i + needle.length()].to_owned() == needle {
      return i
    }
  }
  -1
}

/// Trim leading and trailing whitespace from a string.
fn string_trim(s : String) -> String {
  let mut start = 0
  while start < s.length() &&
    (s[start] == ' ' || s[start] == '\n' || s[start] == '\r' || s[start] == '\t') {
    start = start + 1
  }
  let mut end = s.length()
  while end > start &&
    (s[end - 1] == ' ' || s[end - 1] == '\n' || s[end - 1] == '\r' || s[end - 1] == '\t') {
    end = end - 1
  }
  s[start:end].to_owned()
}

/// Escape special JSON characters in a string.
fn escape_json(s : String) -> String {
  let mut result = ""
  for ch in s {
    if ch == '"' {
      result = result + "\\\""
    } else if ch == '\\' {
      result = result + "\\\\"
    } else if ch == '\n' {
      result = result + "\\n"
    } else if ch == '\r' {
      result = result + "\\r"
    } else if ch == '\t' {
      result = result + "\\t"
    } else {
      result = result + ch.to_string()
    }
  }
  result
}
