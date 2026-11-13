import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ProviderAdapter } from './adapters/types';
import { ApiError, ServerApi, withRetry } from './api';
import { assertInside, changedFiles, checkpoint, ensureRepo, git, head, projectDir, resetToCheckpoint } from './workspace';
import { runChecks } from './verify';

export interface ClaimedTask {
  task: {
    id: string;
    key: string;
    title: string;
    role: string;
    kind: 'ai' | 'verify' | 'package';
    providerKey: string | null;
    prompt: string | null;
    spec: { requiredFiles?: string[]; collectFiles?: string[] } & Record<string, unknown>;
    attemptNo: number;
    timeoutSec: number;
    leaseSec: number;
  };
  project: { id: string; name: string; kind: string };
}

export interface RunnerDeps {
  api: ServerApi;
  workspaceRoot: string;
  adapters: Map<string, ProviderAdapter>;
  log: (msg: string) => void;
}

/** 실행 이벤트를 순번(seq)과 함께 모아 순서대로 서버에 보냅니다. 전송 실패 시 같은 묶음을 다시 보내며, 서버는 순번으로 중복을 제거합니다. */
class EventSink {
  private seq = 0;
  private queue: Array<{ seq: number; type: string; message: string; data?: unknown }> = [];
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout;

  constructor(
    private readonly api: ServerApi,
    private readonly taskId: string,
    private readonly attemptNo: number,
  ) {
    this.timer = setInterval(() => void this.flush(), 700);
  }

  push(type: string, message: string, data?: unknown) {
    if (this.queue.length > 20_000) return; // 서버 장애가 길어질 때 메모리 보호
    this.queue.push({ seq: this.seq++, type, message: message.slice(0, 8000), data });
    if (this.queue.length >= 100) void this.flush();
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.queue.length) {
        const batch = this.queue.slice(0, 200);
        try {
          await this.api.post(`/api/agent/tasks/${this.taskId}/events`, { attemptNo: this.attemptNo, events: batch });
          this.queue.splice(0, batch.length);
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) this.queue.splice(0, batch.length);
          break; // 일시적 오류: 다음 주기에 같은 묶음을 다시 전송
        }
      }
    })().finally(() => (this.flushing = null));
    return this.flushing;
  }

  async close() {
    clearInterval(this.timer);
    for (let i = 0; i < 5 && this.queue.length; i++) {
      await this.flush();
      if (this.queue.length) await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/** 임대받은 작업 하나를 실행하고 결과(사실)를 서버에 보고합니다. 성공 여부는 서버가 판정합니다. */
export async function runTask(deps: RunnerDeps, claimed: ClaimedTask, engineStop: AbortSignal): Promise<void> {
  const { task, project } = claimed;
  const { api } = deps;
  const sink = new EventSink(api, task.id, task.attemptNo);
  const abort = new AbortController();
  let leaseLost = false;
  let cancelled = false;
  let timedOut = false;

  const onStop = () => {
    leaseLost = true; // 엔진 종료 시에는 보고하지 않고 서버의 임대 만료·복구에 맡깁니다.
    abort.abort();
  };
  engineStop.addEventListener('abort', onStop, { once: true });
  const hb = setInterval(async () => {
    try {
      const r = await api.post(`/api/agent/tasks/${task.id}/heartbeat`, { attemptNo: task.attemptNo }, 10_000);
      if (r.lost) {
        leaseLost = true;
        abort.abort();
      } else if (r.cancel) {
        cancelled = true;
        abort.abort();
      }
    } catch {
      /* 일시적 통신 오류: 임대가 만료되면 서버가 작업을 회수합니다. */
    }
  }, Math.max(1000, (task.leaseSec * 1000) / 3));
  const timeout = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, task.timeoutSec * 1000);

  const report: Record<string, any> = { attemptNo: task.attemptNo, exitCode: 1, changedFiles: [], files: {}, tests: [] };
  try {
    const dir = projectDir(deps.workspaceRoot, project.id);
    report.workspacePath = dir;
    await ensureRepo(dir);
    await resetToCheckpoint(dir);
    report.gitBefore = await head(dir);
    sink.push('system', `작업 시작: ${task.title} (시도 ${task.attemptNo})`);

    if (task.kind === 'ai') {
      const adapter = task.providerKey ? deps.adapters.get(task.providerKey) : undefined;
      if (!adapter) throw new Error(`이 PC 에서 사용할 수 없는 AI 도구입니다: ${task.providerKey}`);
      const policy = await adapter.checkExecutionPolicy();
      if (!policy.allowed) throw new Error(policy.reason || `${adapter.displayName} 을(를) 자동 실행할 수 없습니다.`);
      const handle = adapter.startTask({ taskId: task.id, prompt: task.prompt || '', cwd: dir, timeoutMs: task.timeoutSec * 1000 });
      adapter.streamEvents(handle, (e) => sink.push(e.type, e.message, e.data));
      const onAbort = () => adapter.cancelTask(handle);
      abort.signal.addEventListener('abort', onAbort, { once: true });
      const result = await handle.done;
      abort.signal.removeEventListener('abort', onAbort);
      await adapter.collectArtifacts(handle);
      report.exitCode = result.exitCode ?? 1;
      if (result.error) report.error = result.error;
      if (result.retryAfterSec) report.retryAfterSec = result.retryAfterSec;
      if (result.timedOut) timedOut = true;
      // AI 의 응답과 별개로, 실제 파일·Git 변경을 사실로 수집합니다.
      if (!abort.signal.aborted || timedOut) {
        if (report.exitCode === 0) {
          report.gitAfter = await checkpoint(dir, `[EUM] ${task.key}: ${task.title}`);
          report.changedFiles = await changedFiles(dir, report.gitBefore, report.gitAfter);
        } else {
          await resetToCheckpoint(dir);
          report.gitAfter = report.gitBefore;
        }
        for (const rel of new Set([...(task.spec.requiredFiles || []), ...(task.spec.collectFiles || [])])) {
          let exists = false;
          let content: string | undefined;
          try {
            const f = assertInside(dir, path.join(dir, rel));
            const st = fs.statSync(f);
            exists = st.isFile() && st.size > 0;
            if (exists && (task.spec.collectFiles || []).includes(rel) && st.size < 300_000) content = fs.readFileSync(f, 'utf8');
          } catch {
            exists = false;
          }
          report.files[rel] = { exists, content };
        }
        sink.push('system', `변경 파일 ${report.changedFiles.length}개, 종료 코드 ${report.exitCode}`);
      }
    } else if (task.kind === 'verify') {
      report.tests = await runChecks(dir, { signal: abort.signal, onLog: (t, m) => sink.push(t, m) });
      report.gitAfter = report.gitBefore;
      report.exitCode = 0;
      if (report.tests.length === 0) sink.push('error', '실행할 수 있는 테스트·빌드 명령을 찾지 못했습니다.');
    } else if (task.kind === 'package') {
      const commit = report.gitBefore as string;
      const tmpDir = path.join(deps.workspaceRoot, '.eum-tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const safe = project.name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'project';
      const filename = `${safe}-source-${commit.slice(0, 8)}.zip`;
      const zip = path.join(tmpDir, `${task.id}-${task.attemptNo}.zip`);
      try {
        sink.push('command', '$ git archive --format=zip HEAD');
        await git(dir, ['archive', '--format=zip', '-o', zip, 'HEAD'], 10 * 60_000);
        const size = fs.statSync(zip).size;
        if (size === 0) throw new Error('생성된 ZIP 파일이 비어 있습니다.');
        const hash = await sha256File(zip);
        sink.push('system', `ZIP 생성: ${filename} (${size.toLocaleString()} bytes)\nSHA-256: ${hash}`);
        await withRetry(
          () => api.upload(`/api/agent/tasks/${task.id}/artifacts`, zip, { attemptNo: String(task.attemptNo), kind: 'source_zip', filename, sha256: hash, gitCommit: commit }),
          { tries: 4, signal: abort.signal },
        );
        sink.push('system', '서버 업로드 완료');
        report.exitCode = 0;
        report.gitAfter = commit;
      } finally {
        fs.rmSync(zip, { force: true });
      }
    }
  } catch (e: any) {
    report.exitCode = report.exitCode === 0 ? 1 : report.exitCode;
    report.error = String(e?.message || e).slice(0, 4000);
    sink.push('error', report.error);
  } finally {
    clearInterval(hb);
    clearTimeout(timeout);
    engineStop.removeEventListener('abort', onStop);
  }

  if (timedOut) {
    report.exitCode = 124;
    report.error = `작업 제한 시간(${task.timeoutSec}초)을 초과해 중단했습니다.`;
    sink.push('error', report.error);
  }
  if (cancelled && !timedOut) {
    report.cancelled = true;
    sink.push('system', '사용자 요청으로 작업을 중단했습니다.');
  }
  await sink.close();
  if (leaseLost) {
    deps.log(`작업 ${task.key}: 임대가 종료되어 결과를 보고하지 않습니다.`);
    return;
  }
  try {
    const r = await withRetry(() => api.post(`/api/agent/tasks/${task.id}/complete`, report, 60_000), { tries: 10 });
    deps.log(`작업 ${task.key} 보고 완료 → ${r.accepted ? (r.ok ? '성공' : `실패: ${r.reason}`) : '무시됨(이미 처리됨)'}`);
  } catch (e: any) {
    deps.log(`작업 ${task.key} 결과 보고 실패: ${e.message} (서버가 임대 만료 후 작업을 복구합니다)`);
  }
}
