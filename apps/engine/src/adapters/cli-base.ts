import { aiEnv, cliInvocation, run, RunResult } from '../proc';
import { AdapterEvent, Artifacts, ProviderAdapter, TaskHandle, TaskInput, TaskResult, TaskSession, Capabilities, ExecutionPolicy, rateLimitRetryAfterSec } from './types';

export interface CliOptions {
  binary?: string;
  model?: string;
  allowMeteredApi?: boolean;
}

export type CliArtifacts = Artifacts & { lastError?: string; failed?: boolean };

/** 공식 CLI 를 비대화형으로 실행하는 어댑터의 공통 부분 (프로세스 실행, 이벤트 전달, 취소) */
export abstract class CliAdapter implements ProviderAdapter {
  abstract readonly key: string;
  abstract readonly displayName: string;
  protected abstract readonly defaultBinary: string;
  /** true 면 Windows 에서도 셸 없이 실행합니다(네이티브 실행 파일). */
  protected readonly nativeBinary: boolean = false;
  private sessions = new Map<string, TaskSession>();

  constructor(protected readonly opts: CliOptions = {}) {}

  protected get bin() {
    return this.opts.binary || this.defaultBinary;
  }
  protected get modelArg(): string | undefined {
    return this.opts.model && /^[\w.\-:\[\]]+$/.test(this.opts.model) ? this.opts.model : undefined;
  }

  protected exec(args: string[], timeoutMs = 20_000): Promise<RunResult> {
    const inv = cliInvocation(this.bin, args, this.nativeBinary || !!this.opts.binary);
    return run(inv.cmd, inv.args, { cwd: process.cwd(), env: aiEnv(!!this.opts.allowMeteredApi), timeoutMs, shell: inv.shell });
  }

  abstract detectInstallation(): Promise<{ installed: boolean; version?: string }>;
  abstract checkAuthentication(): Promise<{ authenticated: boolean; method?: string; detail?: string }>;
  abstract getCapabilities(): Capabilities;
  abstract getUsageStatus(): Promise<Record<string, unknown>>;
  abstract checkExecutionPolicy(): Promise<ExecutionPolicy>;

  /** 실행 인자와 표준 입력으로 넘길 내용 */
  protected abstract buildRun(input: TaskInput): { args: string[]; stdin?: string };
  /** 표준 출력 한 줄을 이벤트로 변환 */
  protected abstract parseLine(line: string, artifacts: CliArtifacts): AdapterEvent | AdapterEvent[] | undefined;
  /** 종료 후 오류 문구를 정리 (인증 만료 감지 등) */
  protected onFinished(_r: RunResult, _artifacts: CliArtifacts): void {}

  startTask(input: TaskInput): TaskHandle {
    const session = new TaskSession();
    this.sessions.set(input.taskId, session);
    const artifacts = session.artifacts as CliArtifacts;
    const { args, stdin } = this.buildRun(input);
    const inv = cliInvocation(this.bin, args, this.nativeBinary || !!this.opts.binary);
    const done: Promise<TaskResult> = run(inv.cmd, inv.args, {
      cwd: input.cwd,
      env: aiEnv(!!this.opts.allowMeteredApi),
      timeoutMs: input.timeoutMs,
      signal: session.abort.signal,
      stdin,
      shell: inv.shell,
      onLine: (stream, line) => {
        if (!line.trim()) return;
        const out = stream === 'stdout' ? this.parseLine(line, artifacts) : ({ type: 'log', message: line } as AdapterEvent);
        for (const e of Array.isArray(out) ? out : out ? [out] : []) session.emit(e);
      },
    }).then((r) => {
      this.onFinished(r, artifacts);
      let exitCode = r.spawnError ? 127 : r.exitCode;
      let error: string | undefined;
      if (r.spawnError) error = `${this.displayName} 을(를) 실행할 수 없습니다: ${r.spawnError}`;
      else if (r.timedOut) error = '작업 제한 시간을 초과했습니다.';
      else if (r.exitCode !== 0 || artifacts.failed) {
        error = artifacts.lastError || `${this.displayName} 이(가) 오류로 종료되었습니다. (종료 코드 ${r.exitCode})\n${r.tail.slice(-1500)}`;
        if (exitCode === 0) exitCode = 1; // 도구가 0 으로 끝났어도 결과가 실패면 실패로 보고
      }
      let retryAfterSec = rateLimitRetryAfterSec(error);
      const rl = (artifacts as any).rateLimit;
      if (error && rl?.resetsAt && rl.status && rl.status !== 'allowed') {
        const sec = Math.round((new Date(rl.resetsAt).getTime() - Date.now()) / 1000) + 120;
        if (sec > 0) retryAfterSec = Math.min(24 * 3600, sec);
      }
      return { exitCode, timedOut: r.timedOut, cancelled: r.aborted, error, retryAfterSec };
    });
    return { taskId: input.taskId, done };
  }

  streamEvents(handle: TaskHandle, onEvent: (e: AdapterEvent) => void) {
    this.sessions.get(handle.taskId)?.subscribe(onEvent);
  }
  cancelTask(handle: TaskHandle) {
    this.sessions.get(handle.taskId)?.abort.abort();
  }
  async collectArtifacts(handle: TaskHandle): Promise<Artifacts> {
    const s = this.sessions.get(handle.taskId);
    this.sessions.delete(handle.taskId);
    return s?.artifacts ?? {};
  }
}
