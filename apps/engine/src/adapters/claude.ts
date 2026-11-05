import { RunResult } from '../proc';
import { CliAdapter, CliArtifacts } from './cli-base';
import { AdapterEvent, Capabilities, ExecutionPolicy, TaskInput } from './types';

/**
 * Claude Code 어댑터.
 * Anthropic 이 배포한 Claude Code 실행 파일을 수정 없이, 공식 비대화형 모드(`claude -p`)로 실행합니다.
 * 로그인은 사용자가 PC 에서 `claude` 로 직접 하며, 엔진은 로그인 정보를 읽거나 저장·전송하지 않습니다.
 * (Claude Code 이용 조건: 사용자는 자신의 구독 계정으로 수정되지 않은 Claude Code 에 로그인해 사용해야 하며,
 *  제3자가 사용자의 구독 자격 증명을 수집·중계하는 것은 허용되지 않습니다.)
 */
export class ClaudeCodeAdapter extends CliAdapter {
  readonly key = 'claude';
  readonly displayName = 'Claude Code';
  protected readonly defaultBinary = 'claude';
  private lastRateLimit: Record<string, unknown> | undefined;

  /**
   * 승인 없이 실행을 허용하는 명령. 파일 수정은 작업 폴더 안에서만 자동 승인(acceptEdits)되고,
   * 여기에 없는 셸 명령은 비대화형 모드에서 거부됩니다.
   */
  static readonly ALLOWED_TOOLS = ['Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)', 'Bash(mkdir:*)'];

  async detectInstallation() {
    const r = await this.exec(['--version']);
    if (r.spawnError || r.exitCode !== 0) return { installed: false };
    return { installed: true, version: r.stdout.trim().split('\n')[0] };
  }

  private async authStatus(): Promise<{ loggedIn: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string; error?: string }> {
    const r = await this.exec(['auth', 'status']);
    if (r.spawnError) return { loggedIn: false, error: 'Claude Code 가 설치되어 있지 않습니다.' };
    try {
      const j = JSON.parse(r.stdout);
      return { loggedIn: j.loggedIn === true, authMethod: j.authMethod, apiProvider: j.apiProvider, subscriptionType: j.subscriptionType };
    } catch {
      if (r.exitCode !== 0) return { loggedIn: false };
      return { loggedIn: false, error: '로그인 상태를 확인할 수 없습니다. Claude Code 를 최신 버전으로 업데이트하세요.' };
    }
  }

  async checkAuthentication() {
    const s = await this.authStatus();
    if (!s.loggedIn) return { authenticated: false, detail: s.error || '로그인되어 있지 않습니다. PC 에서 `claude` 를 실행해 본인 계정으로 로그인하세요.' };
    return { authenticated: true, method: s.authMethod, detail: [s.authMethod, s.subscriptionType].filter(Boolean).join(' / ') };
  }

  async checkExecutionPolicy(): Promise<ExecutionPolicy> {
    const s = await this.authStatus();
    if (!s.loggedIn) return { allowed: false, mode: 'automatic', billing: 'unknown', reason: s.error || '로그인이 필요합니다. PC 에서 `claude` 를 실행해 로그인하세요.' };
    const metered = /api.?key/i.test(s.authMethod || '') || (!!s.apiProvider && s.apiProvider !== 'firstParty');
    if (metered && !this.opts.allowMeteredApi) {
      return {
        allowed: false,
        mode: 'automatic',
        billing: 'metered',
        reason: 'Claude Code 가 API 키 또는 클라우드 과금 계정으로 로그인되어 있습니다. 요금이 발생할 수 있어 실행하지 않습니다. 구독 계정으로 로그인하거나, 엔진 설정에서 종량제 사용을 명시적으로 허용하세요.',
      };
    }
    return { allowed: true, mode: 'automatic', billing: metered ? 'metered' : 'subscription' };
  }

  getCapabilities(): Capabilities {
    return { planning: true, codeGeneration: true, codeReview: true, testGeneration: true, nonInteractive: true, streaming: true, cancel: true, sandbox: false, usageReporting: true };
  }

  async getUsageStatus() {
    return this.lastRateLimit ? { supported: true, ...this.lastRateLimit } : { supported: true, note: '작업을 한 번 실행한 뒤부터 사용 한도 상태가 표시됩니다.' };
  }

  protected buildRun(input: TaskInput) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
    if (this.modelArg) args.push('--model', this.modelArg);
    args.push('--allowedTools', ...ClaudeCodeAdapter.ALLOWED_TOOLS);
    return { args, stdin: input.prompt }; // 지시문은 표준 입력으로 전달
  }

  protected parseLine(line: string, artifacts: CliArtifacts) {
    const out = parseClaudeLine(line, artifacts);
    const rl = (artifacts as any).rateLimit;
    if (rl) this.lastRateLimit = rl;
    return out;
  }

  protected onFinished(_r: RunResult, _a: CliArtifacts) {}
}

function rel(p: unknown): string {
  return String(p ?? '').replace(/\\/g, '/').split('/').slice(-3).join('/');
}

/** `claude -p --output-format stream-json --verbose` 의 한 줄을 엔진 이벤트로 변환합니다. */
export function parseClaudeLine(line: string, artifacts: CliArtifacts & { rateLimit?: Record<string, unknown> } = {}): AdapterEvent[] | undefined {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return [{ type: 'log', message: line }];
  }
  if (!j || typeof j !== 'object') return undefined;
  switch (j.type) {
    case 'system':
      return j.subtype === 'init' ? [{ type: 'log', message: `Claude Code 세션 시작 (모델 ${j.model}, 권한 모드 ${j.permissionMode})`, data: { apiKeySource: j.apiKeySource } }] : undefined;
    case 'assistant': {
      const events: AdapterEvent[] = [];
      for (const c of Array.isArray(j.message?.content) ? j.message.content : []) {
        if (c.type === 'text' && c.text) {
          artifacts.lastMessage = c.text;
          events.push({ type: 'message', message: c.text });
        } else if (c.type === 'tool_use') {
          const i = c.input || {};
          if (c.name === 'Bash') events.push({ type: 'command', message: `$ ${i.command}` });
          else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(c.name)) events.push({ type: 'file', message: `${c.name === 'Write' ? 'write' : 'edit'}: ${rel(i.file_path || i.notebook_path)}` });
          else events.push({ type: 'log', message: `${c.name}${i.file_path ? `: ${rel(i.file_path)}` : i.pattern ? `: ${i.pattern}` : ''}` });
        }
      }
      return events;
    }
    case 'user': {
      const events: AdapterEvent[] = [];
      for (const c of Array.isArray(j.message?.content) ? j.message.content : [])
        if (c.type === 'tool_result' && c.is_error) {
          const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
          events.push({ type: 'error', message: `도구 실행 실패: ${text.slice(0, 1500)}` });
        }
      return events;
    }
    case 'rate_limit_event': {
      const r = j.rate_limit_info || {};
      artifacts.rateLimit = { status: r.status, limitType: r.rateLimitType, resetsAt: r.resetsAt ? new Date(r.resetsAt * 1000).toISOString() : undefined };
      if (r.status && r.status !== 'allowed') return [{ type: 'error', message: `사용 한도 상태: ${r.status} (${r.rateLimitType || ''})` }];
      return undefined;
    }
    case 'result': {
      artifacts.usage = { ...(j.usage || {}), numTurns: j.num_turns, durationMs: j.duration_ms };
      if (j.is_error || (j.subtype && j.subtype !== 'success')) {
        artifacts.failed = true;
        artifacts.lastError = String(j.result || j.subtype || 'Claude Code 가 작업을 완료하지 못했습니다.').slice(0, 2000);
        return [{ type: 'error', message: artifacts.lastError }];
      }
      const denied = Array.isArray(j.permission_denials) ? j.permission_denials.length : 0;
      return [{ type: 'usage', message: `작업 완료 (${j.num_turns}턴${denied ? `, 승인되지 않아 건너뛴 명령 ${denied}건` : ''})`, data: j.usage }];
    }
    default:
      return undefined; // stream_event(글자 단위 조각) 등은 표시하지 않음
  }
}
