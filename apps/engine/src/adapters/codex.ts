import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { aiEnv, run } from '../proc';
import {
  AdapterEvent,
  Artifacts,
  Capabilities,
  ExecutionPolicy,
  ProviderAdapter,
  TaskHandle,
  TaskInput,
  TaskSession,
} from './types';

export interface CodexOptions {
  /** codex 실행 파일 경로(기본: PATH 의 codex). 엔진 설정에서만 지정하며 AI·서버 입력으로 바꿀 수 없습니다. */
  binary?: string;
  model?: string;
  /** 종량제 API 키 로그인 상태에서도 실행을 허용할지 (기본: 허용 안 함) */
  allowMeteredApi?: boolean;
}

/**
 * OpenAI Codex CLI 어댑터.
 * 공식 비대화형 인터페이스 `codex exec --json` 만 사용합니다.
 * 로그인·인증 정보는 Codex CLI 가 관리하며 엔진은 읽거나 서버로 보내지 않습니다.
 */
export class CodexAdapter implements ProviderAdapter {
  readonly key = 'codex';
  readonly displayName = 'OpenAI Codex CLI';
  private sessions = new Map<string, TaskSession>();

  constructor(private readonly opts: CodexOptions = {}) {}

  private get bin() {
    return this.opts.binary || 'codex';
  }
  /** Windows 에서는 npm 전역 설치본이 codex.cmd 이므로 셸을 거쳐 실행합니다. 인자는 모두 고정 문자열입니다. */
  private get useShell() {
    return process.platform === 'win32' && !this.opts.binary;
  }

  private exec(args: string[], timeoutMs = 20_000) {
    return run(this.bin, args, { cwd: process.cwd(), env: aiEnv(!!this.opts.allowMeteredApi), timeoutMs, shell: this.useShell });
  }

  async detectInstallation() {
    const r = await this.exec(['--version']);
    if (r.spawnError || r.exitCode !== 0) return { installed: false };
    return { installed: true, version: r.stdout.trim().split('\n')[0] };
  }

  async checkAuthentication() {
    const r = await this.exec(['login', 'status']);
    if (r.spawnError) return { authenticated: false, detail: 'Codex CLI 가 설치되어 있지 않습니다.' };
    const text = r.tail.trim();
    if (r.exitCode !== 0) return { authenticated: false, detail: '로그인되어 있지 않습니다. PC 에서 `codex login` 을 실행하세요.' };
    const method = /api key/i.test(text) ? 'api_key' : /chatgpt/i.test(text) ? 'chatgpt' : 'unknown';
    return { authenticated: true, method, detail: text.split('\n')[0] };
  }

  getCapabilities(): Capabilities {
    return {
      planning: true,
      codeGeneration: true,
      codeReview: true,
      testGeneration: true,
      nonInteractive: true,
      streaming: true,
      cancel: true,
      sandbox: true,
      usageReporting: false,
    };
  }

  async checkExecutionPolicy(): Promise<ExecutionPolicy> {
    const auth = await this.checkAuthentication();
    if (!auth.authenticated) return { allowed: false, mode: 'automatic', billing: 'unknown', reason: auth.detail };
    if (auth.method === 'api_key' && !this.opts.allowMeteredApi) {
      return {
        allowed: false,
        mode: 'automatic',
        billing: 'metered',
        reason: 'Codex 가 종량제 API 키로 로그인되어 있습니다. 요금이 발생할 수 있어 실행하지 않습니다. ChatGPT 구독 계정으로 로그인하거나, 엔진 설정에서 종량제 사용을 명시적으로 허용하세요.',
      };
    }
    if (!this.windowsSandboxConfigured()) {
      return { allowed: false, mode: 'automatic', billing: 'subscription', reason: WINDOWS_SANDBOX_HINT };
    }
    return { allowed: true, mode: 'automatic', billing: auth.method === 'api_key' ? 'metered' : 'subscription' };
  }

  /**
   * Windows 에서 Codex CLI 는 전용 샌드박스([windows] sandbox = "elevated" | "unelevated")가 설정되어 있지 않으면
   * 읽기 전용으로 동작해 파일을 쓰지 못하고 명령도 "blocked by policy" 로 거부합니다. 설정 파일만 읽어 확인합니다.
   */
  windowsSandboxConfigured(): boolean {
    if (process.platform !== 'win32') return true;
    try {
      const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
      const section = toml.split(/^\s*\[/m).find((b) => /^windows\]/.test(b)) || '';
      if (/^\s*sandbox\s*=\s*"(elevated|unelevated)"/m.test(section)) return true;
      return /^\s*(elevated|experimental)_windows_sandbox\s*=\s*true/m.test(toml);
    } catch {
      return false;
    }
  }

  async getUsageStatus() {
    return { supported: false, note: 'Codex CLI 는 구독 잔여 사용량을 조회하는 공식 비대화형 인터페이스를 제공하지 않습니다.' };
  }

  startTask(input: TaskInput): TaskHandle {
    const session = new TaskSession();
    this.sessions.set(input.taskId, session);
    const args = ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
    if (this.opts.model && /^[\w.\-:]+$/.test(this.opts.model)) args.push('--model', this.opts.model);
    args.push('-'); // 지시문은 표준 입력으로 전달 (명령줄 인용·주입 문제 방지)

    let policyBlocked = false;
    let fileChanges = 0;
    const done = run(this.bin, args, {
      cwd: input.cwd,
      env: aiEnv(!!this.opts.allowMeteredApi),
      timeoutMs: input.timeoutMs,
      signal: session.abort.signal,
      stdin: input.prompt,
      shell: this.useShell,
      onLine: (stream, line) => {
        if (!line.trim()) return;
        if (/blocked by policy|read-only/i.test(line)) policyBlocked = true;
        const e = stream === 'stdout' ? parseCodexLine(line, session.artifacts) : ({ type: 'log', message: line } as AdapterEvent);
        if (e?.type === 'file') fileChanges++;
        if (e) session.emit(e);
      },
    }).then((r) => {
      let error: string | undefined;
      if (r.spawnError) error = `Codex CLI 를 실행할 수 없습니다: ${r.spawnError}`;
      else if (r.timedOut) error = '작업 제한 시간을 초과했습니다.';
      else if (r.exitCode !== 0) error = (session.artifacts as any).lastError || `Codex 가 오류로 종료되었습니다. (종료 코드 ${r.exitCode})\n${r.tail.slice(-1500)}`;
      else if (policyBlocked && fileChanges === 0) error = `Codex 가 읽기 전용 모드로 실행되어 파일을 쓰지 못했습니다. ${WINDOWS_SANDBOX_HINT}`;
      return { exitCode: r.spawnError ? 127 : r.exitCode, timedOut: r.timedOut, cancelled: r.aborted, error };
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

export const WINDOWS_SANDBOX_HINT =
  'Windows 용 Codex 샌드박스가 설정되지 않았습니다. PC 의 %USERPROFILE%\\.codex\\config.toml 에 [windows] 섹션과 sandbox = "elevated" 를 추가한 뒤, 명령 창에서 codex 를 한 번 실행해 관리자 승인(초기 설정)을 마치고 엔진을 다시 시작하세요.';

/** `codex exec --json` 의 JSONL 한 줄을 엔진 이벤트로 변환합니다. 모르는 형식은 원문 로그로 남깁니다. */
export function parseCodexLine(line: string, artifacts: Artifacts & { lastError?: string } = {}): AdapterEvent | undefined {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return { type: 'log', message: line };
  }
  if (!j || typeof j !== 'object') return { type: 'log', message: line };
  const t = String(j.type || '');
  if (t === 'thread.started') return { type: 'log', message: 'Codex 세션 시작', data: { threadId: j.thread_id } };
  if (t === 'turn.started') return undefined;
  if (t === 'turn.completed') {
    artifacts.usage = j.usage;
    return { type: 'usage', message: '작업 턴 완료', data: j.usage };
  }
  if (t === 'turn.failed' || t === 'error') {
    const msg = j.error?.message || j.message || '알 수 없는 오류';
    artifacts.lastError = String(msg);
    return { type: 'error', message: String(msg) };
  }
  if (t.startsWith('item.')) {
    const it = j.item || {};
    const phase = t.slice(5); // started | updated | completed
    switch (it.type) {
      case 'agent_message':
        if (phase !== 'completed') return undefined;
        artifacts.lastMessage = String(it.text || '');
        return { type: 'message', message: String(it.text || '') };
      case 'reasoning':
        return phase === 'completed' ? { type: 'reasoning', message: String(it.text || '') } : undefined;
      case 'command_execution':
        if (phase === 'started') return { type: 'command', message: `$ ${it.command}` };
        if (phase === 'completed')
          return {
            type: 'command',
            message: `$ ${it.command}\n→ 종료 코드 ${it.exit_code}${it.aggregated_output ? `\n${String(it.aggregated_output).slice(-1500)}` : ''}`,
            data: { exitCode: it.exit_code },
          };
        return undefined;
      case 'file_change':
        if (phase !== 'completed') return undefined;
        return {
          type: 'file',
          message: (it.changes || []).map((c: any) => `${c.kind || 'update'}: ${c.path}`).join('\n') || '파일 변경',
          data: { changes: it.changes },
        };
      case 'todo_list':
        return {
          type: 'log',
          message: (it.items || []).map((x: any) => `${x.completed ? '[x]' : '[ ]'} ${x.text}`).join('\n'),
        };
      case 'error':
        return { type: 'error', message: String(it.message || '') };
      default:
        return phase === 'completed' ? { type: 'log', message: `${it.type || t}` } : undefined;
    }
  }
  return { type: 'log', message: line.slice(0, 2000) };
}
