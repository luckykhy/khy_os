import 'dart:async';
import 'dart:convert';

/// Permission levels for tool execution
enum PermissionLevel { auto, ask, deny }

/// Result of a tool execution
class ToolResult {
  final bool success;
  final String output;
  final Map<String, dynamic>? metadata;

  const ToolResult({required this.success, required this.output, this.metadata});

  factory ToolResult.ok(String output, {Map<String, dynamic>? metadata}) =>
      ToolResult(success: true, output: output, metadata: metadata);

  factory ToolResult.fail(String error) =>
      ToolResult(success: false, output: error);

  String get jsonOutput => jsonEncode({
    'success': success,
    'output': output,
    if (metadata != null) 'metadata': metadata,
  });
}

/// Tool definition
class ToolDef {
  final String name;
  final String description;
  final Map<String, dynamic> inputSchema;
  final PermissionLevel permission;
  final Future<ToolResult> Function(Map<String, dynamic> args) execute;
  final List<String> tags;

  const ToolDef({
    required this.name,
    required this.description,
    required this.inputSchema,
    required this.execute,
    this.permission = PermissionLevel.auto,
    this.tags = const [],
  });

  /// Convert to OpenAI function calling format
  Map<String, dynamic> toFunctionSchema() => {
    'type': 'function',
    'function': {
      'name': name,
      'description': description,
      'parameters': inputSchema,
    },
  };
}

/// Tool execution hook
typedef ToolHook = Future<void> Function(String toolName, Map<String, dynamic> args, ToolResult? result);

/// The tool engine: registry + execution + hooks + permissions
class ToolEngine {
  final Map<String, ToolDef> _tools = {};
  final Map<String, PermissionLevel> _permissions = {};
  final List<ToolHook> _beforeHooks = [];
  final List<ToolHook> _afterHooks = [];

  /// Register a tool
  void register(ToolDef tool) {
    _tools[tool.name] = tool;
  }

  /// Register multiple tools
  void registerAll(List<ToolDef> tools) {
    for (final t in tools) {
      _tools[t.name] = t;
    }
  }

  /// Get all registered tools
  List<ToolDef> get allTools => _tools.values.toList();

  /// Get tool by name
  ToolDef? getTool(String name) => _tools[name];

  /// Set permission for a tool
  void setPermission(String toolName, PermissionLevel level) {
    _permissions[toolName] = level;
  }

  /// Get permission for a tool
  PermissionLevel getPermission(String toolName) =>
      _permissions[toolName] ?? PermissionLevel.auto;

  /// Check if tool can execute
  bool canExecute(String toolName) =>
      getPermission(toolName) != PermissionLevel.deny;

  /// Add before-execution hook
  void addBeforeHook(ToolHook hook) => _beforeHooks.add(hook);

  /// Add after-execution hook
  void addAfterHook(ToolHook hook) => _afterHooks.add(hook);

  /// Execute a tool by name
  Future<ToolResult> execute(String toolName, Map<String, dynamic> args) async {
    final tool = _tools[toolName];
    if (tool == null) {
      return ToolResult.fail('Tool not found: $toolName');
    }

    if (!canExecute(toolName)) {
      return ToolResult.fail('Tool denied: $toolName');
    }

    // Before hooks
    for (final hook in _beforeHooks) {
      try {
        await hook(toolName, args, null);
      } catch (_) {}
    }

    // Execute
    ToolResult result;
    try {
      result = await tool.execute(args);
    } catch (e) {
      result = ToolResult.fail('Tool error: $e');
    }

    // After hooks
    for (final hook in _afterHooks) {
      try {
        await hook(toolName, args, result);
      } catch (_) {}
    }

    return result;
  }

  /// Generate OpenAI function schemas for all tools
  List<Map<String, dynamic>> toFunctionSchemas() =>
      _tools.values.map((t) => t.toFunctionSchema()).toList();

  /// Get tool names for system prompt
  String toolNamesString() =>
      _tools.keys.map((k) => '- $k').join('\n');

  /// Execute tool calls from OpenAI response
  Future<List<Map<String, dynamic>>> executeToolCalls(
    List<Map<String, dynamic>> toolCalls,
  ) async {
    final results = <Map<String, dynamic>>[];
    for (final tc in toolCalls) {
      final id = tc['id'] ?? '';
      final fn = tc['function'] ?? {};
      final name = fn['name'] ?? '';
      final argsStr = fn['arguments'] ?? '{}';

      Map<String, dynamic> args;
      try {
        args = jsonDecode(argsStr) as Map<String, dynamic>;
      } catch (_) {
        args = {};
      }

      final result = await execute(name, args);
      results.add({
        'tool_call_id': id,
        'role': 'tool',
        'content': result.jsonOutput,
      });
    }
    return results;
  }
}
