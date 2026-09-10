import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core/network/network_diagnostic.dart';
import '../../core/services/app_logger.dart';

class NetworkDiagnosticScreen extends StatefulWidget {
  const NetworkDiagnosticScreen({super.key});

  @override
  State<NetworkDiagnosticScreen> createState() => _NetworkDiagnosticScreenState();
}

class _NetworkDiagnosticScreenState extends State<NetworkDiagnosticScreen> {
  final NetworkDiagnostic _diagnostic = NetworkDiagnostic();
  final AppLogger _logger = AppLogger();
  List<DiagnosticResult> _results = [];
  bool _running = false;
  String _report = '';
  String _detailedLogs = '';

  Future<void> _runDiagnostic() async {
    setState(() {
      _running = true;
      _results = [];
      _report = '';
      _detailedLogs = '';
    });
    _logger.i(LogCategory.system, '用户启动网络诊断');
    try {
      final results = await _diagnostic.runFullDiagnostic();
      final report = _diagnostic.generateReport();
      setState(() {
        _results = results;
        _report = report;
        _detailedLogs = _diagnostic.detailedLogs.join('\n');
      });
      final successCount = results.where((r) => r.success).length;
      if (successCount == 0 && mounted) {
        Future.delayed(const Duration(milliseconds: 500), () => _showRepairGuideDialog());
      }
    } catch (e) {
      _logger.e(LogCategory.system, '诊断失败', error: e);
    } finally {
      setState(() => _running = false);
    }
  }

  Future<void> _copyAll() async {
    final text = '# khy-os 网络诊断报告\n时间: ${DateTime.now().toIso8601String()}\n\n$_report\n\n=== 详细日志 ===\n$_detailedLogs\n';
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('完整报告已复制到剪贴板')),
      );
    }
  }

  Future<void> _copyLogs() async {
    await Clipboard.setData(ClipboardData(text: _detailedLogs));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('诊断日志已复制')),
      );
    }
  }

  void _showRepairGuideDialog() {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: Row(children: [
          const Icon(Icons.build, color: Colors.orange),
          const SizedBox(width: 8),
          const Text('网络修复指南'),
        ]),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('检测到网络连接异常。如果手机能正常上网，请按以下步骤排查：',
                  style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 16),
              _guideStep('1', '检查私有DNS', '设置 → WLAN → 更多 → 高级 → 私有DNS\n→ 改为"自动"或"关闭"'),
              _guideStep('2', '检查app网络权限', '设置 → 应用 → khy-os → 流量\n→ 确保WLAN和移动数据已开启'),
              _guideStep('3', '关闭电池优化', '设置 → 电池 → 应用启动管理 → khy-os\n→ 关闭"自动管理"，允许后台活动'),
              _guideStep('4', '切换网络测试', '关掉WiFi用4G/5G数据试试\n或换个WiFi热点'),
              _guideStep('5', '检查VPN/代理', '关闭所有VPN/代理app\n检查是否有网络加速类功能'),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('稍后')),
          FilledButton(
            onPressed: () { Navigator.pop(ctx); _runDiagnostic(); },
            child: const Text('重新测试'),
          ),
        ],
      ),
    );
  }

  Widget _guideStep(String num, String title, String desc) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 24, height: 24, alignment: Alignment.center,
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.primaryContainer,
            shape: BoxShape.circle,
          ),
          child: Text(num, style: TextStyle(
            color: Theme.of(context).colorScheme.onPrimaryContainer,
            fontSize: 12, fontWeight: FontWeight.bold,
          )),
        ),
        const SizedBox(width: 12),
        Expanded(child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
            const SizedBox(height: 2),
            Text(desc, style: TextStyle(fontSize: 12, color: Colors.grey[600], height: 1.4)),
          ],
        )),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final passCount = _results.where((r) => r.success).length;
    final failCount = _results.where((r) => !r.success).length;

    return Scaffold(
      appBar: AppBar(
        title: const Text('网络诊断'),
        centerTitle: true,
        actions: [
          IconButton(
            icon: const Icon(Icons.copy_outlined),
            onPressed: _results.isNotEmpty ? _copyAll : null,
            tooltip: '复制报告',
          ),
          IconButton(
            icon: const Icon(Icons.article_outlined),
            onPressed: _detailedLogs.isNotEmpty ? _copyLogs : null,
            tooltip: '复制日志',
          ),
        ],
      ),
      body: Column(children: [
        // 顶部诊断按钮
        Container(
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
          child: FilledButton.icon(
            onPressed: _running ? null : _runDiagnostic,
            icon: _running
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.network_check),
            label: Text(_running ? '诊断中...' : '开始诊断', style: const TextStyle(fontSize: 16)),
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
          ),
        ),

        // 统计卡片
        if (_results.isNotEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
            child: Card(
              elevation: 0,
              color: cs.surfaceContainerHighest.withValues(alpha: 0.3),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 20),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    _statItem('通过', passCount, Colors.green),
                    Container(width: 1, height: 32, color: cs.outlineVariant),
                    _statItem('失败', failCount, Colors.red),
                    Container(width: 1, height: 32, color: cs.outlineVariant),
                    _statItem('总计', _results.length, cs.onSurface),
                  ],
                ),
              ),
            ),
          ),

        const SizedBox(height: 12),

        // 结果列表
        Expanded(
          child: _running
              ? const Center(child: CircularProgressIndicator())
              : _results.isEmpty
                  ? _buildEmptyState(cs)
                  : _buildResultsList(cs),
        ),

        // 底部提示
        if (_results.isNotEmpty && failCount > 0)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
            child: OutlinedButton.icon(
              onPressed: _showRepairGuideDialog,
              icon: const Icon(Icons.build, size: 18),
              label: const Text('查看修复指南'),
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 12),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ),
      ]),
    );
  }

  Widget _statItem(String label, int value, Color color) {
    return Column(children: [
      Text('$value', style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: color)),
      const SizedBox(height: 4),
      Text(label, style: TextStyle(fontSize: 12, color: Colors.grey[600])),
    ]);
  }

  Widget _buildEmptyState(ColorScheme cs) {
    return Center(child: Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(Icons.network_check, size: 80, color: cs.outlineVariant),
        const SizedBox(height: 16),
        Text('点击上方按钮开始诊断', style: TextStyle(fontSize: 16, color: cs.outline)),
        const SizedBox(height: 8),
        Text('将测试DNS、TCP、HTTPS连通性', style: TextStyle(fontSize: 13, color: cs.outlineVariant)),
      ],
    ));
  }

  Widget _buildResultsList(ColorScheme cs) {
    // 按类别分组：网卡、系统DNS、智能DNS、UDP、TCP、HTTPS
    final categories = <String, List<DiagnosticResult>>{};
    for (final r in _results) {
      final cat = r.name.split(' ').first;
      categories.putIfAbsent(cat, () => []).add(r);
    }

    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      itemCount: categories.length,
      itemBuilder: (context, i) {
        final catName = categories.keys.elementAt(i);
        final catResults = categories[catName]!;
        final catPass = catResults.where((r) => r.success).length;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 类别标题
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
              child: Row(children: [
                Icon(
                  catPass == catResults.length ? Icons.check_circle : Icons.warning,
                  size: 16,
                  color: catPass == catResults.length ? Colors.green : Colors.orange,
                ),
                const SizedBox(width: 8),
                Text(catName, style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: cs.onSurface.withValues(alpha: 0.7),
                )),
                const SizedBox(width: 8),
                Text('$catPass/${catResults.length}', style: TextStyle(
                  fontSize: 12,
                  color: catPass == catResults.length ? Colors.green : Colors.orange,
                )),
              ]),
            ),
            // 该类别的测试项
            ...catResults.map((r) => Card(
              elevation: 0,
              margin: const EdgeInsets.only(bottom: 4),
              color: r.success
                  ? Colors.green.withValues(alpha: 0.05)
                  : Colors.red.withValues(alpha: 0.05),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
              child: ListTile(
                dense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12),
                leading: Icon(
                  r.success ? Icons.check_circle_outline : Icons.error_outline,
                  color: r.success ? Colors.green : Colors.red,
                  size: 20,
                ),
                title: Text(
                  _cleanName(r.name),
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
                ),
                subtitle: Text(
                  r.message,
                  style: TextStyle(fontSize: 11, color: Colors.grey[600]),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: r.durationMs != null
                    ? Text('${r.durationMs}ms', style: TextStyle(fontSize: 11, color: Colors.grey[500]))
                    : null,
              ),
            )),
            const SizedBox(height: 8),
          ],
        );
      },
    );
  }

  String _cleanName(String name) {
    // 去掉类别前缀
    final parts = name.split(' ');
    return parts.length > 1 ? parts.sublist(1).join(' ') : name;
  }
}
