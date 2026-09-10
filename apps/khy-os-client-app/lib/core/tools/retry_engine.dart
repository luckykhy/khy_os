import 'dart:math' as math;
import 'dart:async';

/// 重试策略
enum RetryStrategy { none, exponential, linear }

/// 单次重试配置
class RetryConfig {
  final int maxAttempts;
  final int initialDelayMs;
  final double backoffMultiplier;
  final int circuitBreakerThreshold; // 连续失败 N 次后熔断
  final Duration circuitBreakerCooldown;

  const RetryConfig({
    this.maxAttempts = 3,
    this.initialDelayMs = 1000,
    this.backoffMultiplier = 2.0,
    this.circuitBreakerThreshold = 5,
    this.circuitBreakerCooldown = const Duration(minutes: 5),
  });

  /// 获取第 N 次重试的等待时间（毫秒）
  int delayFor(int attempt) {
    if (attempt <= 0) return 0;
    return (initialDelayMs * math.pow(backoffMultiplier, attempt - 1))
        .toInt();
  }
}

/// 默认重试配置
const defaultRetryConfig = RetryConfig(
  maxAttempts: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2.0,
);

/// 网络工具重试（更保守）
const networkRetryConfig = RetryConfig(
  maxAttempts: 3,
  initialDelayMs: 2000,
  backoffMultiplier: 2.0,
  circuitBreakerThreshold: 5,
);

/// 重试执行器
class RetryEngine {
  final Map<String, int> _failureCounts = {};
  final Map<String, DateTime> _circuitOpenTime = {};

  /// 执行一个可能失败的操作（带重试）
  Future<T> execute<T>(
    String operation,
    Future<T> Function() action, {
    required RetryConfig config,
    void Function(int attempt, String error)? onRetry,
  }) async {
    // 检查熔断
    if (_isCircuitOpen(operation)) {
      throw CircuitBreakerOpenException(operation);
    }

    T? result;
    for (var attempt = 0; attempt < config.maxAttempts; attempt++) {
      try {
        result = await action();
        // 成功：重置计数
        _failureCounts[operation] = 0;
        return result!;
      } catch (e) {
        if (attempt == config.maxAttempts - 1) {
          // 最后一次也失败
          _recordFailure(operation);
          throw e;
        }

        // 等待后重试
        final delayMs = config.delayFor(attempt + 1);
        _recordFailure(operation);
        onRetry?.call(attempt + 1, e.toString());
        await Future.delayed(Duration(milliseconds: delayMs));
      }
    }
    throw StateError('RetryEngine: unreachable');
  }

  /// 记录失败（用于熔断判断）
  void _recordFailure(String operation) {
    _failureCounts[operation] =
        (_failureCounts[operation] ?? 0) + 1;
    if ((_failureCounts[operation] ?? 0) >=
        networkRetryConfig.circuitBreakerThreshold) {
      _circuitOpenTime[operation] =
          DateTime.now().add(networkRetryConfig.circuitBreakerCooldown);
    }
  }

  /// 检查熔断状态
  bool _isCircuitOpen(String operation) {
    final openTime = _circuitOpenTime[operation];
    if (openTime == null) return false;
    if (DateTime.now().isAfter(openTime)) {
      // 冷却期过，半开
      _circuitOpenTime.remove(operation);
      _failureCounts[operation] = 0;
      return false;
    }
    return true;
  }

  /// 获取某操作的连续失败次数
  int getFailureCount(String operation) =>
      _failureCounts[operation] ?? 0;

  /// 重置所有状态
  void reset() {
    _failureCounts.clear();
    _circuitOpenTime.clear();
  }
}

/// 熔断异常
class CircuitBreakerOpenException implements Exception {
  final String operation;
  CircuitBreakerOpenException(this.operation);

  @override
  String toString() =>
      '熔断器开启：$operation 连续失败过多，冷却中';
}
