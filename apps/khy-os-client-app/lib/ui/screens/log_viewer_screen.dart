import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core/services/app_logger.dart';
import '../../ui/theme/app_colors.dart';

class LogViewerScreen extends StatefulWidget {
  const LogViewerScreen({super.key});

  @override
  State<LogViewerScreen> createState() => _LogViewerScreenState();
}

class _LogViewerScreenState extends State<LogViewerScreen> {
  final AppLogger _logger = AppLogger();
  String _logs = '';
  String _logSize = '';
  bool _loading = true;
  bool _showErrorsOnly = false;
  bool _showErrorPanel = false;

  @override
  void initState() {
    super.initState();
    _loadLogs();
  }

  Future<void> _loadLogs() async {
    setState(() => _loading = true);
    final logs =
        _showErrorsOnly ? await _logger.readRecentLogs(200) : await _logger.readLogs();
    final size = await _logger.getLogSize();
    setState(() {
      _logs = logs;
      _logSize = size;
      _loading = false;
    });
  }

  Future<void> _exportLogs() async {
    final exported = await _logger.exportLogs();
    await Clipboard.setData(ClipboardData(text: exported));
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('日志已复制到剪贴板')));
    }
  }

  Future<void> _copyLogs() async {
    await Clipboard.setData(ClipboardData(text: _logs));
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('已复制')));
    }
  }

  Future<void> _clearLogs() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('清空日志'),
        content: const Text('确定要清空所有日志吗？'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(c, false),
              child: const Text('取消')),
          TextButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('确定', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
    if (confirm == true) {
      await _logger.clearLogs();
      _loadLogs();
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final errors = _logger.recentErrors;
    final errorStats = _logger.errorCodeStats;

    return Scaffold(
      appBar: AppBar(
        title: const Text('日志'),
        centerTitle: true,
        actions: [
          IconButton(
            icon: Icon(
                _showErrorsOnly ? Icons.filter_alt : Icons.filter_alt_outlined),
            onPressed: () {
              setState(() => _showErrorsOnly = !_showErrorsOnly);
              _loadLogs();
            },
            tooltip: _showErrorsOnly ? '显示全部' : '仅错误',
          ),
          IconButton(
            icon: const Icon(Icons.copy_outlined),
            onPressed: _copyLogs,
            tooltip: '复制',
          ),
          IconButton(
            icon: const Icon(Icons.file_download_outlined),
            onPressed: _exportLogs,
            tooltip: '导出',
          ),
          IconButton(
            icon: const Icon(Icons.delete_outline),
            onPressed: _clearLogs,
            tooltip: '清空',
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loadLogs,
            tooltip: '刷新',
          ),
        ],
      ),
      body: Column(
        children: [
          // Status bar
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
            child: Row(
              children: [
                Icon(Icons.info_outline, size: 16, color: cs.outline),
                const SizedBox(width: 8),
                Text('大小: $_logSize',
                    style: TextStyle(fontSize: 12, color: cs.outline)),
                const Spacer(),
                Text(
                    _showErrorsOnly
                        ? '仅错误'
                        : '${_logs.split('\n').length} 行',
                    style: TextStyle(fontSize: 12, color: cs.outline)),
              ],
            ),
          ),

          // Error summary panel
          if (errors.isNotEmpty) ...[
            GestureDetector(
              onTap: () => setState(() => _showErrorPanel = !_showErrorPanel),
              child: Container(
                width: double.infinity,
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                color: const Color(0xFFFEE4E2).withValues(alpha: 0.3),
                child: Row(
                  children: [
                    Icon(Icons.error_outline,
                        size: 16, color: cs.error),
                    const SizedBox(width: 8),
                    Text(
                      '最近错误：${errors.length} 条'
                      '（${_formatErrorStats(errorStats)}）',
                      style: TextStyle(fontSize: 13, color: cs.error),
                    ),
                    const Spacer(),
                    Icon(
                      _showErrorPanel ? Icons.expand_less : Icons.expand_more,
                      size: 18,
                      color: cs.onSurfaceVariant,
                    ),
                  ],
                ),
              ),
            ),
            if (_showErrorPanel)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                color: cs.surface,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final err in errors.reversed.take(20))
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: _errorRow(err, cs),
                      ),
                  ],
                ),
              ),
          ],

          // Log content
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _logs.isEmpty
                    ? Center(
                        child:
                            Text('暂无日志', style: TextStyle(color: cs.outline)))
                    : Scrollbar(
                        child: SingleChildScrollView(
                          padding: const EdgeInsets.all(8),
                          child: SelectableText(
                            _logs,
                            style: const TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 10,
                              height: 1.5,
                            ),
                          ),
                        ),
                      ),
          ),

          // Action bar
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: cs.surface,
              border: Border(
                  top: BorderSide(
                      color: cs.outlineVariant.withValues(alpha: 0.3))),
            ),
            child: Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _exportLogs,
                    icon: const Icon(Icons.content_copy, size: 16),
                    label: const Text('导出日志'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () => _showHelp(context),
                    icon: const Icon(Icons.help_outline, size: 16),
                    label: const Text('格式说明'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _errorRow(ErrorRecord err, ColorScheme cs) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 8,
          height: 8,
          margin: const EdgeInsets.only(top: 4),
          decoration: BoxDecoration(
            color: err.severity == LogLevel.fatal ? cs.error : AppColors.warning,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${err.code} ${err.message}',
                style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface),
              ),
              if (err.context.isNotEmpty)
                Text(
                  err.context.entries.map((e) => '${e.key}=${e.value}').join(' · '),
                  style: TextStyle(
                      fontSize: 10, color: cs.onSurface.withValues(alpha: 0.5)),
                ),
              Text(
                _formatTime(err.timestamp),
                style: TextStyle(
                    fontSize: 10, color: cs.onSurface.withValues(alpha: 0.4)),
              ),
            ],
          ),
        ),
      ],
    );
  }

  String _formatErrorStats(Map<String, int> stats) {
    if (stats.isEmpty) return '无';
    return stats.entries.map((e) => '${e.key}×${e.value}').join(' ');
  }

  String _formatTime(DateTime dt) {
    return '${dt.hour.toString().padLeft(2, '0')}:'
        '${dt.minute.toString().padLeft(2, '0')}:'
        '${dt.second.toString().padLeft(2, '0')}';
  }

  void _showHelp(BuildContext context) {
    showDialog(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('日志格式说明 v2'),
        content: const SingleChildScrollView(
          child: Text(
            '格式：\n'
            '[时间][级别][分类] 消息\n'
            '  code: E101\n'
            '  context: {url: "...", mode: "standalone"}\n'
            '  error: DioException [connectionError]\n'
            '  #0 _handleDioErr...（堆栈最多 5 帧）\n'
            '\n'
            '错误码：\n'
            '  E1xx 网络  E101 DNS / E102 连接 / E103 超时\n'
            '            E104 HTTP 4xx / E105 HTTP 5xx\n'
            '  E2xx API  E201 认证 / E202 参数 / E203 模型 / E204 限流\n'
            '  E3xx 工具  E301 执行 / E302 无障碍 / E303 截屏 / E304 Shell\n'
            '  E4xx 系统  E401 权限 / E402 配置 / E403 存储\n'
            '  E5xx 未知  E500\n'
            '\n'
            '级别：DBG INF WRN ERR FTL\n'
            '分类：NET DNS ATH UI  CFG API TOL DEV SYS UNK\n'
            '\n'
            '使用方法：\n'
            '1. 点「导出日志」复制到剪贴板\n'
            '2. 粘贴到 AI 对话框，描述问题\n'
            '3. AI 按错误码快速定位原因',
            style: TextStyle(fontFamily: 'monospace', fontSize: 11, height: 1.4),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(c), child: const Text('确定')),
        ],
      ),
    );
  }
}
