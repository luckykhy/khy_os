/// @pattern Strategy
// KHY OS MoonBit Plugin SDK
// M1 host interface wrapper around imported `khy_sys` functions.

///|
pub const CAP_IPC : Int = 1 << 0
pub const CAP_NET : Int = 1 << 1
pub const CAP_FS_READ : Int = 1 << 2
pub const CAP_FS_WRITE : Int = 1 << 3
pub const CAP_WINDOW : Int = 1 << 4
pub const CAP_SHM : Int = 1 << 5
pub const CAP_IRQ_BIND : Int = 1 << 6

///|
pub const SERVICE_FS : Int = 1
pub const SERVICE_NET : Int = 2
pub const SERVICE_WM : Int = 3

///|
pub const FS_READ_FILE : Int = 1
pub const FS_STAT : Int = 2

pub const NET_HTTP_GET : Int = 1
pub const NET_DNS_RESOLVE : Int = 2

pub const WM_PRESENT_TEXT : Int = 1
pub const WM_BLIT_RGBA : Int = 2

///|
pub const ERRNO_EPERM : Int = -1
pub const ERRNO_ENOENT : Int = -2
pub const ERRNO_EIO : Int = -5
pub const ERRNO_ENOMEM : Int = -12
pub const ERRNO_EACCES : Int = -13
pub const ERRNO_EINVAL : Int = -22
pub const ERRNO_ENOSYS : Int = -38
pub const ERRNO_ETIMEDOUT : Int = -60
pub const ERRNO_EPROTO : Int = -71
pub const ERRNO_EMSGSIZE : Int = -90

///|
pub const DEFAULT_TIMEOUT_MS : Int = 3000
pub const DEFAULT_RESPONSE_CAPACITY : Int = 65536

///|
pub struct IpcCallResult {
  status : Int
  payload : Bytes
}

///|
// Raw imported functions from host runtime.
fn cap_check_raw(cap_bit : Int) -> Int = "khy_sys" "cap_check"

// NOTE:
// `khy_sys` is imported as a wasm stub (`"module" "name"` form), where MoonBit
// only accepts primitive stub types by default. We intentionally bypass that
// check here to pass borrowed byte buffers for host IPC interop.
#unsafe_skip_stub_check
#borrow(req_bytes, resp_bytes)
fn ipc_call_raw(
  service_id : Int,
  method_id : Int,
  req_bytes : Bytes,
  req_len : Int,
  resp_bytes : Bytes,
  resp_cap : Int,
  timeout_ms : Int
) -> Int = "khy_sys" "ipc_call"

fn ipc_last_len_raw() -> Int = "khy_sys" "ipc_last_len"
fn ipc_last_status_raw() -> Int = "khy_sys" "ipc_last_status"

fn shm_create_raw(size : Int, perms : Int) -> Int = "khy_sys" "shm_create"
fn shm_map_raw(handle : Int, offset : Int, length : Int) -> Int = "khy_sys" "shm_map"

///|
fn _clamp_non_negative(value : Int) -> Int {
  if value < 0 {
    0
  } else {
    value
  }
}

///|
fn _bounded_length(raw_len : Int, cap : Int) -> Int {
  let safe_cap = if cap <= 0 { 1 } else { cap }
  let l = _clamp_non_negative(raw_len)
  if l > safe_cap {
    safe_cap
  } else {
    l
  }
}

///|
pub fn has_capability(cap_bit : Int) -> Bool {
  cap_check_raw(cap_bit) == 1
}

///|
pub fn ipc_last_len() -> Int {
  ipc_last_len_raw()
}

pub fn ipc_last_status() -> Int {
  ipc_last_status_raw()
}

///|
pub fn call_json(
  service_id : Int,
  method_id : Int,
  request_payload : Bytes
) -> IpcCallResult {
  call_json_with(
    service_id,
    method_id,
    request_payload,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_RESPONSE_CAPACITY,
  )
}

///|
pub fn call_json_with(
  service_id : Int,
  method_id : Int,
  request_payload : Bytes,
  timeout_ms : Int,
  response_capacity : Int
) -> IpcCallResult {
  let cap = if response_capacity <= 0 { 1 } else { response_capacity }
  let resp = Bytes::new(cap)

  let status = ipc_call_raw(
    service_id,
    method_id,
    request_payload,
    request_payload.length(),
    resp,
    cap,
    timeout_ms,
  )

  let out_len = _bounded_length(ipc_last_len_raw(), cap)
  let payload = resp[0:out_len].to_owned()

  { status, payload }
}

///|
pub fn call_json_utf8(
  service_id : Int,
  method_id : Int,
  request_json : String
) -> IpcCallResult {
  let req = @utf8.encode(request_json)
  call_json(service_id, method_id, req)
}

///|
pub fn payload_utf8(result : IpcCallResult) -> String {
  @utf8.decode_lossy(result.payload)
}

///|
pub fn shm_create(size : Int, perms : Int) -> Int {
  shm_create_raw(size, perms)
}

pub fn shm_map(handle : Int, offset : Int, length : Int) -> Int {
  shm_map_raw(handle, offset, length)
}
