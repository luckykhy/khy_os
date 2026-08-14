/**
 * selfHeal/types.d.ts — TypeScript 契约（运行时为纯 JS，避免引入 TS 工具链与死代码）。
 *
 * 与 DESIGN-ARCH-029「Agent 自愈微循环」对齐：ErrorDiagnostician / MicroLoopExecutor /
 * PrescriptionDeadLoopDetector / FixActions / FallbackTreeWithHeal 的对外形状，供 IDE 与
 * 未来 TS 消费方静态约束。
 */

export type RiskLevel = 'L0' | 'L1' | 'L2';

export type FixKind =
  | 'inject-defaults'
  | 'retarget-path'
  | 'install-dependency'
  | 'switch-runtime'
  | 'probe-port'
  | 'degrade-direct'
  | 'refuse';

/** 诊断字典条目命中产物（capture 为受控标识，绝不含可执行命令）。 */
export interface DictionaryHit {
  id: string;
  cause: string;
  risk: RiskLevel;
  needsConfirm: boolean;
  fixKind: FixKind;
  action: string;
  capture: DiagnosisCapture;
}

export interface DiagnosisCapture {
  dep?: string | null;
  command?: string | null;
  candidates?: string[];
  hostPort?: { host: string; port: string } | null;
  path?: string | null;
}

/** ErrorDiagnostician.diagnose 的统一输出。 */
export interface Diagnosis {
  error_code: string;          // E01–E08
  reason: string;              // resilience 失败原因口径
  cause: string;               // 中文病因
  risk: RiskLevel | null;
  needsConfirm: boolean;
  fixKind: FixKind | null;
  action: string | null;       // 处方动作（仅展示）
  capture: DiagnosisCapture;
  fixable: boolean;            // 是否可进入修复微循环（L2/degrade-direct→false）
  detail: string;             // 脱敏后人读详情
  missingDependency: string | null;
}

export interface DiagnoseContext {
  params?: Record<string, unknown>;
  schema?: Record<string, unknown>;
  tool?: string;
  model?: string;
  kind?: 'tool' | 'llm';
  path?: string;
  control?: unknown;
}

export declare class ErrorDiagnostician {
  constructor(opts?: { dictionary?: unknown });
  diagnose(rawError: unknown, context?: DiagnoseContext): Diagnosis;
}

/** 处方级死循环熔断器（与 resilience 的调用级检测器互补）。 */
export declare class PrescriptionDeadLoopDetector {
  signature(diagnosis: Diagnosis): string;
  check(diagnosis: Diagnosis): { signature: string; dead: boolean; repeats: number; sameAsLast: boolean };
  record(diagnosis: Diagnosis): { signature: string; repeats: number };
  reset(): void;
}

export interface FixResult {
  ok: boolean;
  params?: Record<string, unknown>;
  reason?: string;
  info?: Record<string, unknown>;
}

export interface DependencyInstaller {
  install(dep: string, opts?: { control?: unknown }): Promise<{ ok: boolean; reason?: string; depId?: string }>;
}

export declare class FixActions {
  constructor(opts?: { installer?: DependencyInstaller; probePort?: (hp: unknown) => Promise<unknown> });
  apply(
    diagnosis: Diagnosis,
    ctx: { params?: Record<string, unknown>; toolName?: string; context?: DiagnoseContext; control?: unknown },
  ): Promise<FixResult>;
}

export interface AttemptedFix {
  action: string;
  result: string;   // 'fixed' | 'failed:<reason>' | 'declined:...' | 'skipped:dead-loop...' | 'fixed-but-retry-failed'
  auto: boolean;    // L0=true，L1=false
}

export interface HealResult {
  fixed: boolean;
  params?: Record<string, unknown>;
  diagnosis: Diagnosis;
  degrade: boolean;
  record?: AttemptedFix;
  info?: Record<string, unknown>;
}

export interface RunOnceResult {
  ok: boolean;
  result?: unknown;
  params?: Record<string, unknown>;
  diagnosis: Diagnosis;
  attempted_fixes: AttemptedFix[];
  degrade: boolean;
}

export declare class MicroLoopExecutor {
  /** 微循环硬编码上限——诊断→修复→重试，仅一轮（不可配置）。 */
  readonly MAX_LOOP: 1;
  attempted_fixes: AttemptedFix[];
  lastDiagnosis: Diagnosis | null;
  constructor(opts?: {
    diagnostician?: ErrorDiagnostician;
    deadLoop?: PrescriptionDeadLoopDetector;
    fixActions?: FixActions;
    confirm?: (args: { diagnosis: Diagnosis; dependency?: string; action?: string }) => Promise<boolean> | boolean;
  });
  heal(args: { toolName?: string; params?: Record<string, unknown>; failure: unknown; context?: DiagnoseContext; control?: unknown }): Promise<HealResult>;
  /** resilience BudgetAwareExecutor 的 ctx.repair 适配器。 */
  repair(hookArgs: { node?: { tool?: string }; failure: unknown; params?: Record<string, unknown>; context?: DiagnoseContext }): Promise<{ changed: boolean; params?: Record<string, unknown> }>;
  runOnce(args: { toolName?: string; params?: Record<string, unknown>; failure: unknown; context?: DiagnoseContext; control?: unknown; runTool?: (tool: string, params: Record<string, unknown>) => Promise<unknown> }): Promise<RunOnceResult>;
  reset(): void;
}

/** Goal3 规定的强制兜底报告。 */
export interface FallbackReport {
  status: 'failed';
  intent: string;
  diagnosis: {
    error_code: string;
    cause: string;
    reason: string;
    risk: RiskLevel | null;
    prescription: string | null;
    detail: string;
  };
  attempted_fixes: AttemptedFix[];
  salvage_data: unknown;
  next_action_suggestion: string;
}

export interface HealSuccess {
  status: 'ok';
  intent: string;
  plan: string;
  result: unknown;
  attempted_fixes: AttemptedFix[];
  degraded: boolean;
}

export declare class FallbackTreeWithHeal {
  constructor(opts: {
    runner: (tool: string, params: Record<string, unknown>, planMeta?: unknown) => Promise<unknown>;
    confirm?: (args: { diagnosis: Diagnosis }) => Promise<boolean> | boolean;
    budget?: unknown;
    floorPct?: number;
    onDegrade?: (text: string) => void;
    availableTools?: string[];
    microLoop?: MicroLoopExecutor;
  });
  run(intentOrTree: string | object, context?: Record<string, unknown>): Promise<HealSuccess | FallbackReport>;
}

export declare const MAX_LOOP: 1;
export declare const RISK: { L0: 'L0'; L1: 'L1'; L2: 'L2' };
