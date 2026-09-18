import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// Full-screen QR scanner that returns the decoded text via `Navigator.pop`.
///
/// Used by [ConnectionScreen] to read the pairing QR printed by
/// `khy mobile app`. There is no business logic here — the caller validates the
/// text with `PairingPayloadParser`, so a wrong QR (e.g. the management-page one
/// from `khy mobile`) is reported by the parser, not silently accepted here.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key, this.title = '扫描配对二维码'});

  final String title;

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  /// Guards against a burst of `onDetect` callbacks popping the route twice.
  bool _handled = false;

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    final barcodes = capture.barcodes;
    if (barcodes.isEmpty) return;
    final raw = barcodes.first.rawValue;
    if (raw == null || raw.trim().isEmpty) return;

    _handled = true;
    Navigator.of(context).pop<String>(raw);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            onDetect: _onDetect,
            errorBuilder: (context, error) => _buildError(context, error),
          ),
          // Aiming frame + guidance.
          IgnorePointer(
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 240,
                    height: 240,
                    decoration: BoxDecoration(
                      border: Border.all(color: Colors.white70, width: 3),
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                  const SizedBox(height: 24),
                  const DecoratedBox(
                    decoration: BoxDecoration(color: Colors.black54),
                    child: Padding(
                      padding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      child: Text(
                        '对准终端里的配对二维码（khy mobile app）',
                        style: TextStyle(color: Colors.white, fontSize: 13),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Honest failure text instead of a black rectangle on screen (规则 2.2).
  ///
  /// Only the two errors a user can actually fix are mapped to guidance;
  /// everything else falls back to the raw `MobileScannerException` string so
  /// the real cause is never hidden.
  Widget _buildError(BuildContext context, MobileScannerException error) {
    final guidance = switch (error.errorCode) {
      MobileScannerErrorCode.permissionDenied =>
        '相机权限被拒绝。请在系统设置中为「khy-os」开启相机权限后重试。',
      MobileScannerErrorCode.unsupported =>
        '这台设备不支持扫码。请返回上一页，把 `khy mobile app` 输出的内容粘贴到输入框完成配对。',
      _ => '',
    };

    final detail = error.errorDetails?.message;
    final reason =
        (detail == null || detail.isEmpty) ? error.toString() : detail;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.no_photography_outlined, size: 48),
            const SizedBox(height: 16),
            Text(
              '无法启动相机：$reason',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleSmall,
            ),
            if (guidance.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                guidance,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 13),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
