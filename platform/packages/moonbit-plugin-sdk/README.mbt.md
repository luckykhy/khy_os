# khyos/moonbit_plugin_sdk

MoonBit SDK for KHY OS M1 host IPC (`khy_sys`).

## Scope

This package provides:

- Capability constants (`CAP_IPC`, `CAP_NET`, ...)
- Service/method constants (`SERVICE_NET`, `NET_HTTP_GET`, ...)
- Raw `khy_sys` bindings (`ipc_call`, `ipc_last_len`, ...)
- Safe wrappers:
  - `call_json(...)`
  - `call_json_with(...)`
  - `call_json_utf8(...)`
  - `payload_utf8(...)`

## Host Contract

The host runtime must provide imported symbols in module `"khy_sys"`:

- `cap_check`
- `ipc_call`
- `ipc_last_len`
- `ipc_last_status`
- `shm_create`
- `shm_map`

Current repository implementation:

- `backend/src/services/wasm-sandbox/khySysHost.js`
- `backend/src/services/wasm-sandbox/moonbitHostBridge.js`
- `backend/src/services/wasm-sandbox/loopbackTransport.js`

## Usage Example

```moonbit
let result = @sdk.call_json_utf8(
  @sdk.SERVICE_NET,
  @sdk.NET_HTTP_GET,
  "{\"city\":\"shanghai\"}",
)

if result.status < 0 {
  println("ipc failed: \{result.status}")
} else {
  let json = @sdk.payload_utf8(result)
  println("ipc ok: \{json}")
}
```

## Notes

- `call_json_with` writes into an internal fixed response buffer and truncates to `ipc_last_len()`.
- On errors, host returns negative errno values (for example `-13`, `-22`, `-90`).
- `DEFAULT_RESPONSE_CAPACITY` is `65536` bytes (M1 frame limit).
- Current host-side `khySysHost` implementation in this repository expects pointer-style `u32` req/resp ABI. If module/runtime combination provides non-pointer `externref` byte arguments to `ipc_call`, runtime will reject with `-EPROTO`.
- `app register --abi numeric-v1` will also reject such modules early when `khy_sys.ipc_call` is imported but expected memory export is missing.
- `app register` also performs import compatibility checks and rejects unsupported imports early (host supports `khy_sys.*` and `spectest.print_char`).
- For `string-v2/json-v2`, registration now validates ABI-required exports and currently supports only `return-mode=i64-ptr-len`.
- For `numeric-v1` app execution, host runtime also performs an early module precheck (`imports khy_sys.ipc_call` + `missing expected memory export`) and fails fast with an explicit ABI mismatch error.
