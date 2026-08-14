/// @pattern Strategy
// context_utils.mbt — Hot-path functions for AI context management.
// Compiled to WASM-GC and loaded by Node.js contextWasm.js.
//
// Algorithms ported from OpenClaw constants:
//   CHARS_PER_TOKEN_ESTIMATE = 4
//   SAFETY_MARGIN = 1.2

/// Estimate token count from text length.
/// Uses ceil(len/4) * 1.2 safety margin (integer arithmetic).
pub fn estimate_tokens(text_len : Int) -> Int {
  if text_len <= 0 {
    return 0
  }
  let raw = (text_len + 3) / 4 // ceil(len / 4)
  (raw * 12 + 9) / 10 // ceil(raw * 1.2) via integer math
}

/// Estimate token count with a custom safety margin (numerator/10).
/// e.g. safety_num=12 means 1.2x, safety_num=15 means 1.5x.
pub fn estimate_tokens_with_margin(text_len : Int, safety_num : Int) -> Int {
  if text_len <= 0 {
    return 0
  }
  let raw = (text_len + 3) / 4
  (raw * safety_num + 9) / 10
}

/// FNV-1a hash for tool call dedup.
/// Produces a stable 64-bit hash from a byte array.
/// Replaces JSON.stringify-based comparison with O(n) hashing.
pub fn fnv1a_hash(data : Bytes) -> Int64 {
  let offset_basis : Int64 = 0xcbf29ce484222325L
  let prime : Int64 = 0x100000001b3L
  let len = data.length()
  let mut h = offset_basis
  for i = 0; i < len; i = i + 1 {
    let byte_val = data[i].to_int64()
    h = h.lxor(byte_val)
    h = h * prime
  }
  h
}

/// Combine two FNV-1a hashes (for composing tool name + args hashes).
pub fn fnv1a_combine(h1 : Int64, h2 : Int64) -> Int64 {
  let prime : Int64 = 0x100000001b3L
  let mut h = h1
  // Mix in h2 byte by byte (8 bytes)
  let h2u = h2.reinterpret_as_uint64()
  for i = 0; i < 8; i = i + 1 {
    let byte_val = (h2u >> (i * 8)).land(0xffUL).reinterpret_as_int64()
    h = h.lxor(byte_val)
    h = h * prime
  }
  h
}

/// Calculate truncation cut position.
/// Returns the position to cut at (capped at max_chars or data_len).
pub fn truncate_position(data_len : Int, max_chars : Int) -> Int {
  if data_len <= max_chars {
    return data_len
  }
  max_chars
}

/// Check if total tokens exceed budget with safety margin.
/// Returns the overflow amount (positive = over budget, 0 or negative = fits).
pub fn check_overflow(
  total_tokens : Int,
  budget : Int,
  safety_num : Int
) -> Int {
  let effective = (total_tokens * safety_num + 9) / 10
  effective - budget
}

/// Calculate the single tool result token cap.
/// OpenClaw: SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5
pub fn single_tool_result_cap(context_budget : Int) -> Int {
  context_budget / 2
}

/// Calculate preemptive overflow threshold.
/// OpenClaw: PREEMPTIVE_OVERFLOW_RATIO = 0.9
pub fn preemptive_threshold(context_budget : Int) -> Int {
  (context_budget * 9) / 10
}
