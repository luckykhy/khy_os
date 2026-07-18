/// @pattern Template Method
// chain_test.mbt — Unit tests for chain execution primitives.
// Run: cd backend/wasm-chain && moon test

test "render_template basic" {
  let result = render_template(
    "Hello {name}, you said: {input}",
    ["name", "input"],
    ["Alice", "hi"],
  )
  assert_eq(result, "Hello Alice, you said: hi")
}

test "render_template no placeholders" {
  let result = render_template("plain text", [], [])
  assert_eq(result, "plain text")
}

test "render_template missing value" {
  let result = render_template("{a} and {b}", ["a"], ["X"])
  assert_eq(result, "X and {b}")
}

test "count_placeholders" {
  assert_eq(count_placeholders("{a} and {b} and {c}"), 3)
  assert_eq(count_placeholders("no placeholders"), 0)
  assert_eq(count_placeholders("{}"), 0) // empty name
  assert_eq(count_placeholders("{x}"), 1)
}

test "extract_placeholders" {
  let result = extract_placeholders("Hello {name}, input: {input}")
  assert_eq(result, "[\"name\",\"input\"]")
}

test "format_history basic" {
  let result = format_history(
    ["hello", "how are you"],
    ["hi there", "I'm good"],
    10,
  )
  assert_eq(
    result,
    "Human: hello\nAI: hi there\nHuman: how are you\nAI: I'm good",
  )
}

test "format_history max_turns truncation" {
  let result = format_history(
    ["a", "b", "c", "d"],
    ["1", "2", "3", "4"],
    2,
  )
  // Should only include last 2 turns
  assert_eq(result, "Human: c\nAI: 3\nHuman: d\nAI: 4")
}

test "format_history empty" {
  let result = format_history([], [], 10)
  assert_eq(result, "")
}

test "estimate_history_tokens" {
  let tokens = estimate_history_tokens(
    ["hello"],
    ["world"],
    10,
  )
  // "Human: hello\nAI: world\n" = 24 chars → ceil(24/4)*1.2 = ceil(7.2) = 8
  assert_true(tokens > 0)
  assert_true(tokens < 20)
}

test "max_turns_for_budget" {
  let turns = max_turns_for_budget(
    ["short", "another short"],
    ["reply", "another reply"],
    1000,
  )
  assert_eq(turns, 2) // both should fit in 1000 tokens
}

test "max_turns_for_budget tight" {
  let turns = max_turns_for_budget(
    ["hello"],
    ["world"],
    1, // very small budget
  )
  assert_eq(turns, 0) // nothing fits
}

test "parse_react_response final answer" {
  let result = parse_react_response("Thinking...\nFinal Answer: 42")
  assert_true(result.contains("\"type\":\"final\""))
  assert_true(result.contains("\"answer\":\"42\""))
}

test "parse_react_response action" {
  let result = parse_react_response(
    "I need to calculate.\nAction: calculator\nAction Input: 2+3",
  )
  assert_true(result.contains("\"type\":\"action\""))
  assert_true(result.contains("\"tool\":\"calculator\""))
  assert_true(result.contains("\"input\":\"2+3\""))
}

test "parse_react_response plain text" {
  let result = parse_react_response("Just a normal response")
  assert_true(result.contains("\"type\":\"text\""))
}

test "validate_input normal" {
  assert_eq(validate_input("hello", 1000), 0)
}

test "validate_input empty" {
  assert_eq(validate_input("", 1000), -2)
}

test "validate_input too long" {
  assert_eq(validate_input("hello world", 5), -1)
}

test "estimate_chain_tokens" {
  let tokens = estimate_chain_tokens(100, 50, 20)
  assert_true(tokens > 20) // should be more than just history tokens
}
