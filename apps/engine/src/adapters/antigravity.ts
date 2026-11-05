import { RunResult } from '../proc';
import { CliAdapter, CliArtifacts, CliOptions } from './cli-base';
import { AdapterEvent, Capabilities, ExecutionPolicy, TaskInput } from './types';

/**
 * Google Antigravity CLI(`agy`) 어댑터 — Gemini 구독(Google AI Pro·Ultra) 계정용.
 * Google 은 2026-06-18 부터 구독 계정의 Gemini CLI 사용을 중단하고 Antigravity CLI 로 옮겼습니다.
 * 공식 문서의 비대화형 모드(`agy -p … --output-format stream-json`) 규칙에 맞춰 작성했습니다.
 *
 * [주의] 이 어댑터는 개발 환경에 agy 를 설치할 수 없어 실제 agy 로는 실행해 보지 못했습니다.
 */
export class AntigravityAdapter extends CliAdapter {
  readonly key = 'antigravity';
  readonly displayName = 'Google Antigravity CLI (Gemini)';
  protected readonly defaultBinary = 'agy';
  protected readonly nativeBinary = true; // Go 로 만든 실행 파일이라 셸을 거치지 않고 인자를 그대로 전달
  private authFailedAt = 0;

  constructor(private readonly ag: CliOptions & { mode?: string } = {}) {
    super(ag);
  }

  async detectInstallation() {
    let r = await this.exec(['--version']);
    if (r.spawnError) return { installed: false };
    if (r.exitCode === 0) return { installed: true, version: r.stdout.trim().split('\n')[0] };
    r = await this.exec(['--help']);
    return { installed: r.exitCode === 0 };
  }

  /** agy 에는 로그인 상태를 묻는 명령이 없습니다. 실행 중 "authentication required" 가 나오면 그때부터 로그인 필요로 표시합니다. */
  async checkAuthentication() {
    if (Date.now() - this.authFailedAt < 10 * 60_000)
      return { authenticated: false, detail: '로그인이 필요합니다. PC 에서 `agy` 를 한 번 실행해 Google 계정으로 로그인하세요.' };
    return { authenticated: true, method: 'unknown', detail: '로그인 여부는 작업을 실행할 때 확인됩니다.' };
  }

  async checkExecutionPolicy(): Promise<ExecutionPolicy> {
    const a = await this.checkAuthentication();
    if (!a.authenticated) return { allowed: false, mode: 'automatic', billing: 'unknown', reason: a.detail };
    return { allowed: true, mode: 'automatic', billing: 'subscription' };
  }

  getCapabilities(): Capabilities {
    return { planning: true, codeGeneration: true, codeReview: true, testGeneration: true, nonInteractive: true, streaming: true, cancel: true, sandbox: false, usageReporting: false };
  }
  async getUsageStatus() {
    return { supported: false };
  }

  protected buildRun(input: TaskInput) {
    // Windows 명령줄 길이 제한(약 32,000자)을 넘지 않도록 지시문 가운데를 줄입니다.
    const MAX = 24_000;
    const prompt = input.prompt.length > MAX ? `${input.prompt.slice(0, MAX / 2)}\n\n[… 길이 제한으로 중간 생략 …]\n\n${input.prompt.slice(-MAX / 2)}` : input.prompt;
    // accept-edits: 작업 폴더의 파일 수정만 자동 승인. 셸 명령은 승인되지 않아 건너뜁니다(검증은 엔진이 따로 실행).
    const mode = ['accept-edits', 'auto'].includes(this.ag.mode || '') ? this.ag.mode! : 'accept-edits';
    const args = ['-p', prompt, '--output-format', 'stream-json', '--mode', mode];
    if (mode === 'auto') args.push('--sandbox');
    if (this.modelArg) args.push('--model', this.modelArg);
    return { args };
  }

  protected parseLine(line: string, artifacts: CliArtifacts) {
    return parseAntigravityLine(line, artifacts);
  }

  protected onFinished(r: RunResult, artifacts: CliArtifacts) {
    if (/authentication required/i.test(r.tail) || /authentication required/i.test(artifacts.lastError || '')) {
      this.authFailedAt = Date.now();
      artifacts.failed = true;
      artifacts.lastError = 'Antigravity CLI 에 로그인되어 있지 않습니다. PC 에서 `agy` 를 한 번 실행해 Google 계정으로 로그인하세요.';
    }
  }
}

/** `agy --output-format stream-json` 의 한 줄(NDJSON)을 엔진 이벤트로 변환합니다. 공식 문서의 이벤트 정의 기준. */
export function parseAntigravityLine(line: string, artifacts: CliArtifacts & { texts?: Record<string, string> } = {}): AdapterEvent | undefined {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return { type: 'log', message: line };
  }
  if (!j || typeof j !== 'object') return undefined;
  const kind = j.event || j.type;
  const p = j.payload && typeof j.payload === 'object' ? j.payload : j;
  if (kind === 'init') return { type: 'log', message: `Antigravity 세션 시작${p.model ? ` (모델 ${p.model})` : ''}, 권한 모드 ${p.permission_mode ?? '-'}` };
  if (kind === 'step_update') {
    const key = String(p.step_index ?? 0);
    artifacts.texts = artifacts.texts || {};
    if (p.text_delta) artifacts.texts[key] = (artifacts.texts[key] || '') + p.text_delta;
    if (p.state !== 'DONE') return undefined;
    if (p.step_type === 'agent_response') {
      const text = artifacts.texts[key] || '';
      delete artifacts.texts[key];
      if (!text) return undefined;
      artifacts.lastMessage = text;
      return { type: 'message', message: text };
    }
    if (p.step_type === 'tool') return { type: 'command', message: `도구 실행: ${p.tool_name || ''}`.trim(), data: p.tool_info };
    return undefined;
  }
  if (kind === 'result') {
    artifacts.usage = p.usage;
    if (p.status && p.status !== 'SUCCESS') {
      artifacts.failed = true;
      artifacts.lastError = String(p.error?.message || p.error || `Antigravity 가 작업을 완료하지 못했습니다. (${p.status})`).slice(0, 2000);
      return { type: 'error', message: artifacts.lastError };
    }
    if (p.response) artifacts.lastMessage = p.response;
    return { type: 'usage', message: `작업 완료 (${p.num_turns ?? '?'}턴)`, data: p.usage };
  }
  return undefined;
}
