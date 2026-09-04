/**
 * failsafe/types.d.ts — TypeScript 类型契约（用户要求的 TS 实现层）。
 *
 * 本项目运行时是纯 JavaScript（无 TS 编译链），核心以 JS 落地以免产生死代码；本文件提供
 * 与运行时 1:1 对应的 TS 类型契约，供 IDE 智能提示与（未来）TS 消费方使用：
 *   import type { Attribution, SafeResult } from './failsafe/types';
 *
 * 对应需求中的 SafeResponseWrapper / ErrorClassifier / StreamFailSafeInjector 三件套。
 */

/** E01–E08 错误码字面量联合。 */
export type ErrorCode =
  | 'E01' | 'E02' | 'E03' | 'E04' | 'E05' | 'E06' | 'E07' | 'E08';

/** 错误字典单条定义。 */
export interface ErrorCodeDef {
  code: ErrorCode;
  category: string;
  reason: string;
  requiredFields: string[];
  suggestion: string;
  retryable: boolean;
  /** true → detail/fields 走脱敏白名单（E02 安全审查 / E07 权限拦截）。 */
  sensitive: boolean;
}

/** 归因结果：所有非正常终止的统一对外结构。 */
export interface Attribution {
  status: 'failed';
  error_code: ErrorCode;
  /** 固定 reason 文案（取自字典，替代模糊废话）。 */
  reason: string;
  /** 动态详情（脱敏码下为固定安全模板，不含内部细节）。 */
  detail: string;
  suggestion: string;
  retryable: boolean;
  sensitive: boolean;
  category: string;
  /** 该码必填字段，缺失项填 'unknown'。 */
  fields: Record<string, unknown>;
  /** 必填字段是否全部齐备（false = 归因不完整）。 */
  attribution_complete: boolean;
}

/** 归因上下文（旁路提供的字段，优先级低于原始信号自带字段）。 */
export interface ClassifyContext {
  kind?: 'llm' | 'tool' | 'value' | 'empty_reply' | 'schema';
  model?: string;
  toolName?: string;
  tool?: string;
  endpoint?: string;
  timeoutMs?: number;
  retryCount?: number;
  ctxLimit?: number;
  requiredTokens?: number;
  promptTokens?: number;
  finishReason?: string;
  httpStatus?: number | string;
  expectedSchema?: string;
  rawOutput?: unknown;
  missingDep?: string;
  syscallVerdict?: unknown;
  message?: string;
  stack?: string;
}

/** ErrorClassifier 主入口。 */
export function classify(input: unknown, context?: ClassifyContext): Attribution;
/** 仅返回归因后的错误码。 */
export function classifyCode(input: unknown, context?: ClassifyContext): ErrorCode;

/** SafeResponseWrapper.guard 的返回。 */
export interface SafeResult<T = unknown> {
  ok: boolean;
  /** ok=true → 原始结果；ok=false → Attribution。 */
  value: T | Attribution;
  /** ok=false → Attribution；ok=true → null。 */
  failure: Attribution | null;
  /** 底层原始值或异常（供日志）。 */
  raw: unknown;
}

/** 零静默失败拦截器基座（所有外部通信 + LLM 调用继承）。 */
export class SafeResponseWrapper {
  constructor(context?: ClassifyContext);
  guard<T>(producer: () => Promise<T>, localCtx?: ClassifyContext): Promise<SafeResult<T>>;
  validateLLM(value: unknown, localCtx?: ClassifyContext): Attribution | null;
  validateTool(value: unknown, localCtx?: ClassifyContext): Attribution | null;
  protected _safeCall<T>(producer: () => Promise<T>, localCtx?: ClassifyContext): Promise<T>;
}

/** 流式兜底注入器构造参数。 */
export interface StreamInjectorOptions {
  send: (event: Record<string, unknown>) => void;
  res?: { end?: () => void } | null;
  context?: ClassifyContext;
  track?: boolean;
}

/** 兜底协议执行器：流意外结束 / 进程被杀也补写最后一条结构化错误。 */
export class StreamFailSafeInjector {
  constructor(opts: StreamInjectorOptions);
  emit(event: Record<string, unknown>): this;
  markDone(): this;
  fail(input: unknown, ctx?: ClassifyContext): Attribution | null;
  finalize(input?: unknown, ctx?: ClassifyContext): Attribution | null;
  dispose(): void;
  static installProcessGuards(): void;
  static _clearActive(): void;
  static _activeCount(): number;
}

export function sweepActive(signal: { error_code?: ErrorCode } & Record<string, unknown>): void;

export const ERROR_CODES: Record<ErrorCode, ErrorCodeDef>;
export const FALLBACK_CODE: ErrorCode;
export function getErrorCode(code: string): ErrorCodeDef;
export function listCodes(): ErrorCode[];
export function isKnownCode(code: string): boolean;
