import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const ENGINE_VERSION = '0.1.0';

export interface EngineConfig {
  serverUrl?: string;
  agentId?: string;
  /** 엔진 토큰. 데스크톱 앱에서는 OS 보안 저장소로 암호화해 두고 EUM_AGENT_TOKEN 으로 전달합니다. */
  agentToken?: string;
  agentTokenEnc?: string;
  name: string;
  workspaceRoot: string;
  maxConcurrency: number;
  /** CPU 사용률이 이 값(%)을 넘으면 새 작업을 받지 않습니다. */
  cpuLimitPercent: number;
  /** 남은 메모리가 이 값(MB)보다 적으면 새 작업을 받지 않습니다. */
  minFreeMemMb: number;
  /** 종량제 AI API 사용 허용 (기본: 꺼짐) */
  allowMeteredApi: boolean;
  /** 테스트용 모의 AI 사용 (기본: 꺼짐) */
  enableMock: boolean;
  mockScenario?: string;
  mockDelayMs?: number;
  codex?: { binary?: string; model?: string };
  claude?: { binary?: string; model?: string };
  /** mode: accept-edits(기본, 파일 수정만 자동 승인) | auto(샌드박스 안에서 명령도 자동 실행) */
  antigravity?: { binary?: string; model?: string; mode?: string };
}

export function engineHome(): string {
  return process.env.EUM_ENGINE_HOME || path.join(os.homedir(), '.eum-engine');
}
const configPath = () => path.join(engineHome(), 'config.json');

export function loadConfig(): EngineConfig {
  const defaults: EngineConfig = {
    name: os.hostname(),
    workspaceRoot: path.join(os.homedir(), 'EUM-Projects'),
    maxConcurrency: 1,
    cpuLimitPercent: 90,
    minFreeMemMb: 512,
    allowMeteredApi: false,
    enableMock: false,
  };
  let stored: Partial<EngineConfig> = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    /* 설정 파일 없음 */
  }
  const cfg = { ...defaults, ...stored };
  if (process.env.EUM_AGENT_TOKEN) cfg.agentToken = process.env.EUM_AGENT_TOKEN;
  cfg.maxConcurrency = Math.min(8, Math.max(1, Number(cfg.maxConcurrency) || 1));
  return cfg;
}

export function saveConfig(patch: Partial<EngineConfig>): EngineConfig {
  fs.mkdirSync(engineHome(), { recursive: true, mode: 0o700 });
  let stored: Partial<EngineConfig> = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    /* 새로 만듦 */
  }
  const next = { ...stored, ...patch };
  for (const k of Object.keys(next) as (keyof EngineConfig)[]) if (next[k] === undefined || next[k] === null) delete next[k];
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configPath());
  return loadConfig();
}

/** 서버 주소 검증: 로컬 주소가 아니면 반드시 HTTPS(TLS) 여야 합니다. */
export function validateServerUrl(raw: string): string {
  const u = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (local || process.env.EUM_ALLOW_INSECURE === '1'))) {
    throw new Error('서버 주소는 https:// 로 시작해야 합니다. (로컬 테스트 주소만 http 허용)');
  }
  return u.origin;
}
