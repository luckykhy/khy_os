/// @pattern Facade, Strategy
///|
fn main {
  let request = "{\"city\":\"shanghai\"}"
  let result = @sdk.call_json_utf8(
    @sdk.SERVICE_NET,
    @sdk.NET_HTTP_GET,
    request,
  )

  if result.status < 0 {
    println("IPC failed: \{result.status}")
    return
  }

  let response_json = @sdk.payload_utf8(result)
  println("IPC ok: \{response_json}")
}
