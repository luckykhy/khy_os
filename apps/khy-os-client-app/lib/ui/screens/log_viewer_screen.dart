import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core/services/app_logger.dart';

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

  @override
  void initState() {
    super.initState();
    _loadLogs();
  }

  Future<void> _loadLogs() async {
    setState(() => _loading = true);
    final logs = _showErrorsOnly
        ? await _logger.readRecentLogs(200)
        : await _logger.readLogs();
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
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('完整日志已复制到剪贴板，可直接粘贴到 AI 分析')),
      );
    }
  }

  Future<void> _copyLogs() async {
    await Clipboard.setData(ClipboardData(text: _logs));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已复制到剪贴板')),
      );
    }
  }

  Future<void> _clearLogs() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('清空日志'),
        content: const Text('确定要清空所有日志吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('取消')),
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

    return Scaffold(
      appBar: AppBar(
        title: const Text('诊断日志'),
        centerTitle: true,
        actions: [
          IconButton(
            icon: Icon(_showErrorsOnly ? Icons.filter_alt : Icons.filter_alt_outlined),
            onPressed: () {
              setState(() => _showErrorsOnly = !_showErrorsOnly);
              _loadLogs();
            },
            tooltip: _showErrorsOnly ? '显示全部' : '仅显示错误',
          ),
          IconButton(icon: const Icon(Icons.copy_outlined), onPressed: _copyLogs, tooltip: '复制'),
          IconButton(icon: const Icon(Icons.file_download_outlined), onPressed: _exportLogs, tooltip: '导出'),
          IconButton(icon: const Icon(Icons.delete_outline), onPressed: _clearLogs, tooltip: '清空'),
          IconButton(icon: const Icon(Icons.refresh), onPressed: _loadLogs, tooltip: '刷新'),
        ],
      ),
      body: Column(
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
            child: Row(children: [
              Icon(Icons.info_outline, size: 16, color: cs.outline),
              const SizedBox(width: 8),
              Text('大小: $_logSize', style: TextStyle(fontSize: 12, color: cs.outline)),
              const Spacer(),
              Text(_showErrorsOnly ? '仅错误' : '全部', style: TextStyle(fontSize: 12, color: cs.outline)),
            ]),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _logs.isEmpty
                    ? Center(child: Text('暂无日志', style: TextStyle(color: cs.outline)))
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
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: cs.surface,
              border: Border(top: BorderSide(color: cs.outlineVariant.withValues(alpha: 0.3))),
            ),
            child: Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _exportLogs,
                    icon: const Icon(Icons.content_copy, size: 16),
                    label: const Text('复制完整日志'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () => _showHelp(context),
                    icon: const Icon(Icons.help_outline, size: 16),
                    label: const Text('日志格式说明'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  void _showHelp(BuildContext context) {
    showDialog(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('日志格式说明'),
        content: const SingleChildScrollView(
          child: Text(
            '格式: [时间][级别][分类] 消息\n'
            '       key: value\n'
            '       ERROR: 错误详情\n'
            '\n'
            '级别: DBG/INF/WRN/ERR\n'
            '分类: NET=网络 DNS=解析 AUTH=认证\n'
            '      UI=界面 CFG=配置 API=调用\n'
            '      ERR=错误 SYS=系统\n'
            '\n'
            '使用方法:\n'
            '1. 点击"复制完整日志"\n'
            '2. 粘贴到电脑 AI 对话框\n'
            '3. 描述问题，AI 即可分析',
            style: TextStyle(fontFamily: 'monospace', fontSize: 12),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('确定')),
        ],
      ),
    );
  }
}