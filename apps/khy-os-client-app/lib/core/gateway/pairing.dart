/// Pairing payload contract — the consumer half.
///
/// Producer: `services/backend/src/cli/handlers/mobile.js` →
/// `buildPairingPayload()`, reachable as `khy mobile app`. It emits
/// `JSON.stringify({ apiBaseUrl })` — deliberately JSON and not a bare URL,
/// because a bare URL gets claimed by the phone's system camera and opens a
/// browser tab instead of being handed to this app.
///
/// There are two QR codes in the CLI and they are NOT interchangeable:
///
/// | command          | payload                                        | audience      |
/// |------------------|------------------------------------------------|---------------|
/// | `khy mobile`     | `http://<lan-ip>:<mgmt-port>/admin/ai-gateway` | browser tab   |
/// | `khy mobile app` | `{"apiBaseUrl":"http://<lan-ip>:<api-port>"}`  | this app      |
///
/// Scanning the management QR with this app would take the admin page path as
/// the API root and 404 every request. [PairingPayloadParser.parse] therefore rejects
/// that specific known-wrong payload with an actionable message instead of
/// failing later with an opaque network error.
library;

import 'dart:convert';

/// Raised when a scanned/pasted pairing payload cannot be turned into an API
/// base URL. The message always carries problem + cause + fix (规则 2.2), so it
/// can be surfaced to the user verbatim.
class PairingParseException implements Exception {
  /// 问题 + 原因 + 修复建议
  final String message;

  /// Raw payload that failed, kept for logging (never rendered bare).
  final String raw;

  const PairingParseException(this.message, {this.raw = ''});

  @override
  String toString() => message;
}

/// A validated pairing payload.
class PairingPayload {
  /// API root, scheme included, no trailing slash. e.g. `http://192.168.1.9:3000`
  final String apiBaseUrl;

  /// Optional pre-shared token. Reserved: the current producer does not emit
  /// one, but an older/newer CLI may, and the parser accepts it rather than
  /// silently dropping a credential.
  final String? token;

  const PairingPayload({required this.apiBaseUrl, this.token});

  @override
  String toString() => 'PairingPayload($apiBaseUrl)';
}

/// Parses the payload produced by `khy mobile app`.
///
/// Accepts, in order of preference:
///   1. the canonical JSON envelope `{"apiBaseUrl": "..."}` (optionally with
///      `apiUrl` / `url` / `backend` / `api` as alternate keys);
///   2. a bare `http(s)://host:port` URL;
///   3. a bare `host:port` pair, assumed `http://`.
///
/// Everything is normalized to `<scheme>://<host>[:port]` with no trailing
/// slash, because every call site builds `<base>/api/...` by concatenation.
abstract final class PairingPayloadParser {
  /// Admin-page entry path from `khy mobile` (the *wrong* QR for this app).
  static const String managementEntryPath = '/admin/ai-gateway';

  /// Alternate JSON keys, tried after `apiBaseUrl`. Kept from the previous
  /// implementation so a payload from an older producer still pairs.
  static const List<String> _alternateKeys = ['apiUrl', 'url', 'backend', 'api'];

  /// Parse [raw] (scanned QR text or pasted string) into a [PairingPayload].
  ///
  /// Throws [PairingParseException] with an actionable message.
  static PairingPayload parse(String raw) {
    final text = _stripDecoration(raw);
    if (text.isEmpty) {
      throw const PairingParseException(
        '配对内容为空：没有读到二维码文本，请重新对准 `khy mobile app` 生成的二维码，或粘贴其内容',
      );
    }

    final candidate = text.startsWith('{') ? _fromJson(text) : text;

    final normalized = _normalizeUrl(candidate);

    // Reject the management-page QR before it reaches the network layer.
    final path = _pathWithoutTrailingSlash(Uri.tryParse(normalized)?.path ?? '');
    if (path == managementEntryPath || path.startsWith('$managementEntryPath/')) {
      throw PairingParseException(
        '这是管理页二维码，不是配对二维码：'
        '`khy mobile` 生成的是浏览器管理页地址，App 用它会把 "$path" 当成 API 根地址，所有请求都会 404。'
        '请在电脑上重新执行 `khy mobile app` 生成配对二维码。',
        raw: text,
      );
    }

    return PairingPayload(apiBaseUrl: normalized);
  }

  /// Parse without throwing. Returns `null` on any failure.
  static PairingPayload? tryParse(String raw) {
    try {
      return parse(raw);
    } on PairingParseException {
      return null;
    }
  }

  /// Strip paste/scan noise: surrounding whitespace, newlines, wrapping quotes,
  /// and the zero-width characters some QR keyboards inject.
  static String _stripDecoration(String raw) {
    var text = raw.replaceAll(RegExp(r'[\u200B-\u200D\uFEFF]'), '').trim();
    // A pasted JSON object may arrive wrapped in quotes or backticks.
    const wrappers = ['"', "'", '`'];
    for (final w in wrappers) {
      if (text.length >= 2 && text.startsWith(w) && text.endsWith(w)) {
        text = text.substring(1, text.length - 1).trim();
        break;
      }
    }
    // Multi-line paste: collapse to the first non-empty line's content, but keep
    // a JSON object intact (it may legitimately span lines).
    if (!text.startsWith('{') && text.contains('\n')) {
      text = text.split('\n').firstWhere((l) => l.trim().isNotEmpty, orElse: () => '');
      text = text.trim();
    }
    return text;
  }

  /// Whether [host] is a DNS name, IPv4 or IPv6 literal that could actually be
  /// dialed. Deliberately strict: a host is a host, not a place for stray
  /// quotes, brackets or spaces from a mis-scanned QR.
  static bool _isDialableHost(String host) {
    if (host.isEmpty || host.length > 253) return false;
    if (host.contains('..')) return false;
    if (host.startsWith('.') || host.endsWith('.')) return false;
    if (host.startsWith('-') || host.endsWith('-')) return false;
    // IPv6 (Dart strips the surrounding brackets from `Uri.host`).
    if (host.contains(':')) return RegExp(r'^[0-9A-Fa-f:.]+$').hasMatch(host);
    return RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(host);
  }

  /// Port text of [uri] without touching `Uri.port`, which throws ArgumentError
  /// when the port is not numeric (a mis-scanned payload would otherwise crash
  /// the screen). Returns `''` when there is no port.
  static String _rawPort(Uri uri) {
    var authority = uri.authority;
    if (authority.contains('@')) {
      authority = authority.split('@').last;
    }
    if (authority.startsWith('[')) {
      final close = authority.indexOf(']');
      return close < 0 ? '' : authority.substring(close + 1).replaceFirst(':', '');
    }
    final colon = authority.lastIndexOf(':');
    return colon < 0 ? '' : authority.substring(colon + 1);
  }

  /// Strip a trailing slash from a URI path (never from the base URL itself —
  /// see [_normalizeUrl] for that).
  static String _pathWithoutTrailingSlash(String path) {
    var p = path;
    while (p.length > 1 && p.endsWith('/')) {
      p = p.substring(0, p.length - 1);
    }
    return p;
  }

  /// Extract the API base URL from the JSON envelope.
  static String _fromJson(String text) {
    Object? decoded;
    try {
      decoded = jsonDecode(text);
    } on FormatException catch (e) {
      throw PairingParseException(
        '配对内容不是合法 JSON：${e.message}。'
        '请重新执行 `khy mobile app` 生成二维码；手工输入时只填后端地址，如 192.168.1.9:3000',
        raw: text,
      );
    }

    if (decoded is! Map) {
      throw PairingParseException(
        '配对内容格式不对：期望是 {"apiBaseUrl":"..."} 对象，实际是 ${decoded.runtimeType}。'
        '请重新执行 `khy mobile app` 生成二维码',
        raw: text,
      );
    }

    final map = decoded.cast<Object?, Object?>();
    for (final key in ['apiBaseUrl', ..._alternateKeys]) {
      final value = map[key];
      if (value is String && value.trim().isNotEmpty) {
        return value.trim();
      }
    }

    final seen = map.keys.map((k) => '$k').join(', ');
    throw PairingParseException(
      '配对内容缺少 apiBaseUrl 字段：实际字段为 [$seen]。'
      '请确认扫的是 `khy mobile app` 的配对二维码，而不是 `khy mobile` 的管理页二维码',
      raw: text,
    );
  }

  /// Normalize to `<scheme>://<host>[:port][/path]` with scheme present and no
  /// trailing slash.
  static String _normalizeUrl(String candidate) {
    var text = candidate.trim();
    if (text.isEmpty) {
      throw const PairingParseException(
        '配对内容没有地址：JSON 里 apiBaseUrl 为空，请重新执行 `khy mobile app`',
      );
    }

    if (!RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*://').hasMatch(text)) {
      // No scheme. `host:port` is the documented shorthand (`khy mobile app 3000`
      // prints exactly that form in its explanatory line); anything else without
      // a scheme is assumed plain HTTP too.
      text = 'http://$text';
    }

    final uri = Uri.tryParse(text);
    if (uri == null || !uri.hasAuthority || uri.host.isEmpty) {
      throw PairingParseException(
        '配对内容不是有效地址："$candidate"。'
        '期望形如 192.168.1.9:3000 或 http://192.168.1.9:3000',
        raw: candidate,
      );
    }

    if (uri.scheme != 'http' && uri.scheme != 'https') {
      throw PairingParseException(
        '配对内容协议不支持："${uri.scheme}"。'
        '后端地址只支持 http / https，请重新执行 `khy mobile app` 生成二维码',
        raw: candidate,
      );
    }

    if (uri.hasPort) {
      // `Uri.port` throws ArgumentError on a non-numeric port, which would crash
      // the screen instead of reporting it — read the raw port text first.
      final rawPort = _rawPort(uri);
      final port = int.tryParse(rawPort);
      if (port == null || port <= 0 || port > 65535) {
        throw PairingParseException(
          '配对内容端口越界："${rawPort.isEmpty ? '（空）' : rawPort}"。'
          '端口应为 1-65535 的数字，请重新执行 `khy mobile app <端口>` 指定正确端口',
          raw: candidate,
        );
      }
    }

    // A host that is not a plain DNS name / IPv4 / IPv6 literal can never be
    // dialed. Dart's Uri is permissive enough to keep characters like quotes or
    // brackets from a mis-scanned payload, so reject them here with a message
    // that says which part is wrong rather than letting dio fail later with
    // "Invalid argument(s) (uri)".
    if (!_isDialableHost(uri.host)) {
      throw PairingParseException(
        '配对内容的地址部分非法："${uri.host}"。'
        '期望形如 192.168.1.9 或 khy.example.com，请重新执行 `khy mobile app` 生成二维码',
        raw: candidate,
      );
    }

    // Drop any trailing slash so `<base>/api/health` never becomes `//api/health`.
    var normalized = uri.toString();
    while (normalized.endsWith('/')) {
      normalized = normalized.substring(0, normalized.length - 1);
    }
    return normalized;
  }
}
