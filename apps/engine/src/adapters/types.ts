/** 모든 AI 도구 연결이 구현하는 공통 인터페이스 (지시서 3.1) */

export interface Capabilities {
  planning: boolean;
  codeGeneration: boolean;
  codeReview: boolean;
  testGeneration: boolean;
  nonInteractive: boolean;
  streaming: boolean;
  cancel: boolean;
  sandbox: boolean;
  usageReporting: boolean;
  [k: string]: boolean;
}

export interface AdapterEvent {
  type: string; // message | command | file | reasoning | usage | error | log
  message: string;
  data?: unknown;
}

export interface TaskInput {
  taskId: string;
  prompt: string;
  /** 승인된 프로젝트 작업 폴더. 어댑터는 이 폴더 안에서만 작업하도록 도구를 실행해야 합니다. */
  cwd: string;
  timeoutMs: number;
}

export interface TaskResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
  /** 구독 사용량 한도 등으로 실패했을 때, 몇 초 뒤에 다시 시도하면 되는지 (시도 횟수를 소모하지 않음) */
  retryAfterSec?: number;
}

export interface TaskHandle {
  taskId: string;
  done: Promise<TaskResult>;
}

/**
 * 오류 문구에서 구독 사용량 한도 도달 여부와 재개까지 남은 초를 추정합니다.
 * 예) "You've hit your 5-hour limit · resets 2:40am (Asia/Seoul)" → 초기화 시각까지의 초(+2분 여유). 시각을 못 읽으면 30분.
 */
export function rateLimitRetryAfterSec(message: string | undefined, now = new Date()): number | undefined {
  if (!message) return undefined;
  if (!/hit your .*limit|usage limit|rate limit|rate_limit|too many requests|quota .*exceeded|한도/i.test(message)) return undefined;
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (!m) return 30 * 60;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const t = new Date(now);
  t.setHours(h, min, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return Math.min(24 * 3600, Math.max(60, Math.round((t.getTime() - now.getTime()) / 1000) + 120));
}

export interface Artifacts {
  lastMessage?: string;
  usage?: Record<string, unknown>;
}

export interface ExecutionPolicy {
  /** 이 도구로 자동(비대화형) 실행을 해도 되는지 */
  allowed: boolean;
  /** automatic: 엔진이 자동 실행 / manual: 사용자가 직접 실행하고 결과만 수집 */
  mode: 'automatic' | 'manual';
  /** 구독 계정인지, 종량제 API 키인지 */
  billing: 'subscription' | 'metered' | 'local' | 'unknown';
  reason?: string;
}

export interface ProviderAdapter {
  readonly key: string;
  readonly displayName: string;
  detectInstallation(): Promise<{ installed: boolean; version?: string }>;
  checkAuthentication(): Promise<{ authenticated: boolean; method?: string; detail?: string }>;
  getCapabilities(): Capabilities;
  startTask(input: TaskInput): TaskHandle;
  /** 이미 발생한 이벤트부터 순서대로 전달합니다. */
  streamEvents(handle: TaskHandle, onEvent: (e: AdapterEvent) => void): void;
  cancelTask(handle: TaskHandle): void;
  collectArtifacts(handle: TaskHandle): Promise<Artifacts>;
  getUsageStatus(): Promise<Record<string, unknown>>;
  checkExecutionPolicy(): Promise<ExecutionPolicy>;
}

/** 실행 중인 작업의 이벤트 버퍼·취소 신호를 관리하는 공통 구현 */
export class TaskSession {
  readonly abort = new AbortController();
  private buffer: AdapterEvent[] = [];
  private listener?: (e: AdapterEvent) => void;
  artifacts: Artifacts = {};

  emit(e: AdapterEvent) {
    if (this.listener) this.listener(e);
    else this.buffer.push(e);
  }
  subscribe(fn: (e: AdapterEvent) => void) {
    for (const e of this.buffer) fn(e);
    this.buffer = [];
    this.listener = fn;
  }
}
