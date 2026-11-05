import * as os from 'os';
import { AntigravityAdapter } from './adapters/antigravity';
import { ClaudeCodeAdapter } from './adapters/claude';
import { CodexAdapter } from './adapters/codex';
import { MockAdapter } from './adapters/mock';
import { ProviderAdapter } from './adapters/types';
import { ApiError, ServerApi } from './api';
import { EngineConfig, ENGINE_VERSION, validateServerUrl } from './config';
import { ClaimedTask, runTask } from './runner';

export interface ProviderStatus {
  key: string;
  displayName: string;
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  capabilities: Record<string, boolean>;
  executionPolicy: Record<string, unknown>;
  usageStatus: Record<string, unknown>;
}

export interface EngineStatus {
  connected: boolean;
  paused: boolean;
  running: Array<{ taskId: string; title: string; project: string }>;
  providers: ProviderStatus[];
  lastError?: string;
}

export function buildAdapters(cfg: EngineConfig): Map<string, ProviderAdapter> {
  const m = new Map<string, ProviderAdapter>();
  m.set('codex', new CodexAdapter({ ...cfg.codex, allowMeteredApi: cfg.allowMeteredApi }));
  m.set('claude', new ClaudeCodeAdapter({ ...cfg.claude, allowMeteredApi: cfg.allowMeteredApi }));
  m.set('antigravity', new AntigravityAdapter({ ...cfg.antigravity, allowMeteredApi: cfg.allowMeteredApi }));
  if (cfg.enableMock) m.set('mock', new MockAdapter({ scenario: cfg.mockScenario, delayMs: cfg.mockDelayMs }));
  return m;
}

export async function probeProviders(adapters: Map<string, ProviderAdapter>): Promise<ProviderStatus[]> {
  const out: ProviderStatus[] = [];
  for (const a of adapters.values()) {
    const inst = await a.detectInstallation().catch(() => ({ installed: false }) as { installed: boolean; version?: string });
    const auth = inst.installed ? await a.checkAuthentication().catch(() => ({ authenticated: false })) : { authenticated: false };
    const policy = inst.installed ? await a.checkExecutionPolicy().catch(() => ({ allowed: false })) : { allowed: false };
    const usage = inst.installed ? await a.getUsageStatus().catch(() => ({})) : {};
    out.push({
      key: a.key,
      displayName: a.displayName,
      installed: inst.installed,
      authenticated: auth.authenticated,
      version: inst.version ?? null,
      capabilities: a.getCapabilities(),
      executionPolicy: policy as Record<string, unknown>,
      usageStatus: usage,
    });
  }
  return out;
}

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  return { idle, total };
}

export class Engine {
  private readonly api: ServerApi;
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly stopCtl = new AbortController();
  private readonly active = new Map<string, { title: string; project: string; done: Promise<void> }>();
  private providers: ProviderStatus[] = [];
  private lastProbe = 0;
  private lastCpu = cpuSnapshot();
  private cpuPercent = 0;
  private loops: Promise<void>[] = [];
  status: EngineStatus = { connected: false, paused: false, running: [], providers: [] };

  constructor(
    private readonly cfg: EngineConfig,
    private readonly log: (msg: string) => void = (m) => console.log(`[${new Date().toLocaleTimeString('ko-KR')}] ${m}`),
    private readonly onStatus: (s: EngineStatus) => void = () => undefined,
  ) {
    if (!cfg.serverUrl || !cfg.agentToken) throw new Error('서버에 연결되어 있지 않습니다. 먼저 `eum-engine pair` 로 PC 를 등록하세요.');
    this.api = new ServerApi(validateServerUrl(cfg.serverUrl), cfg.agentToken);
    this.adapters = buildAdapters(cfg);
  }

  private publish() {
    this.status.running = [...this.active.entries()].map(([taskId, v]) => ({ taskId, title: v.title, project: v.project }));
    this.status.providers = this.providers;
    this.onStatus(this.status);
  }

  /** 실행 가능한(설치·로그인·정책 허용) AI 도구만 서버에 알립니다. */
  private usableProviders(): string[] {
    return this.providers.filter((p) => p.installed && p.authenticated && p.executionPolicy.allowed === true).map((p) => p.key);
  }

  private resourcesOk(): boolean {
    const freeMb = os.freemem() / 1024 / 1024;
    return this.cpuPercent <= this.cfg.cpuLimitPercent && freeMb >= this.cfg.minFreeMemMb;
  }

  private async heartbeat() {
    const now = cpuSnapshot();
    const dt = now.total - this.lastCpu.total;
    if (dt > 0) this.cpuPercent = Math.round(100 * (1 - (now.idle - this.lastCpu.idle) / dt));
    this.lastCpu = now;
    const reprobe = Date.now() - this.lastProbe > 60_000;
    if (reprobe) {
      this.providers = await probeProviders(this.adapters);
      this.lastProbe = Date.now();
    }
    try {
      const r = await this.api.post('/api/agent/heartbeat', {
        platform: `${os.platform()} ${os.release()}`,
        engineVersion: ENGINE_VERSION,
        maxConcurrency: this.cfg.maxConcurrency,
        systemInfo: { cpus: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1024 / 1024), freeMemMb: Math.round(os.freemem() / 1024 / 1024), cpuPercent: this.cpuPercent },
        providers: reprobe ? this.providers : [],
      }, 15_000);
      if (!this.status.connected) this.log('서버에 연결되었습니다.');
      this.status.connected = true;
      this.status.paused = !!r.paused;
      this.status.lastError = undefined;
    } catch (e: any) {
      if (this.status.connected) this.log(`서버 연결이 끊겼습니다: ${e.message}`);
      this.status.connected = false;
      this.status.lastError = e.message;
      if (e instanceof ApiError && e.status === 401) {
        this.log('이 PC 의 등록이 해제되었습니다. 엔진을 중지합니다.');
        this.stopCtl.abort();
      }
    }
    this.publish();
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      const sig = this.stopCtl.signal;
      function done() {
        sig.removeEventListener('abort', done);
        clearTimeout(t);
        resolve();
      }
      sig.addEventListener('abort', done, { once: true });
    });
  }

  async start() {
    this.log(`EUM Desktop Engine ${ENGINE_VERSION} 시작 — 작업 폴더: ${this.cfg.workspaceRoot}`);
    await this.heartbeat();
    for (const p of this.providers)
      this.log(`AI 도구 ${p.displayName}: ${!p.installed ? '미설치' : !p.authenticated ? '로그인 필요' : p.executionPolicy.allowed ? '사용 가능' : `사용 불가 (${p.executionPolicy.reason})`}`);
    // 재시작 후 정합성: 이전 실행에서 이 PC 가 맡았던 작업은 프로세스가 사라졌으므로 서버에 복구를 요청합니다.
    try {
      const r = await this.api.post('/api/agent/recover', {});
      if (r.recovered) this.log(`중단됐던 작업 ${r.recovered}개를 대기열로 되돌렸습니다.`);
    } catch (e: any) {
      this.log(`복구 요청 실패: ${e.message}`);
    }
    this.loops.push(
      (async () => {
        while (!this.stopCtl.signal.aborted) {
          await this.sleep(10_000);
          if (!this.stopCtl.signal.aborted) await this.heartbeat();
        }
      })(),
      this.claimLoop(),
    );
  }

  private async claimLoop() {
    while (!this.stopCtl.signal.aborted) {
      let got = false;
      if (this.status.connected && !this.status.paused && this.active.size < this.cfg.maxConcurrency && this.resourcesOk()) {
        try {
          const r: ClaimedTask | { task: null } = await this.api.post('/api/agent/claim', { providers: this.usableProviders() }, 20_000);
          if (r.task) {
            got = true;
            const c = r as ClaimedTask;
            this.log(`작업 수신: [${c.project.name}] ${c.task.title}`);
            const done = runTask({ api: this.api, workspaceRoot: this.cfg.workspaceRoot, adapters: this.adapters, log: this.log }, c, this.stopCtl.signal)
              .catch((e) => this.log(`작업 실행 오류: ${e.message}`))
              .finally(() => {
                this.active.delete(c.task.id);
                this.publish();
              });
            this.active.set(c.task.id, { title: c.task.title, project: c.project.name, done });
            this.publish();
          }
        } catch (e: any) {
          this.status.lastError = e.message;
        }
      }
      await this.sleep(got ? 200 : 2000);
    }
  }

  /** 엔진을 중지합니다. 실행 중인 AI·빌드 프로세스도 함께 종료합니다. */
  async stop() {
    this.stopCtl.abort();
    await Promise.all([...this.active.values()].map((v) => v.done));
    await Promise.all(this.loops);
    this.log('엔진을 중지했습니다.');
  }
}
