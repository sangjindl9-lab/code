#!/usr/bin/env node
/**
 * 전체 흐름(E2E) 검증.
 * 실제 서버 프로세스와 실제 PC 엔진 프로세스를 띄우고, 웹 API 로 프로그램 제작을 요청해
 * 기획 → 작업 분할 → 구현 → 실제 테스트 실행 → 자동 수정 → ZIP 패키징 → 다운로드까지 확인합니다.
 * AI 는 테스트 전용 모의 어댑터를 사용합니다(실제 Codex 는 사용자 PC 의 로그인 계정이 필요).
 *
 * 필요: PostgreSQL (E2E_DATABASE_URL), 미리 빌드된 apps/server, apps/engine
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.E2E_DATABASE_URL || 'postgres://postgres@127.0.0.1:5544/eum';
const PORT = Number(process.env.E2E_PORT || 4599);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eum-e2e-'));
const CLI = path.join(ROOT, 'apps/engine/dist/src/cli.js');
const children = new Set();
const results = [];

function start(name, cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(TMP, `${name}.log`));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, token, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return json;
}

let seq = 0;
/** 새 조직(사용자) + 그 조직에 등록된 PC 엔진 설정을 만듭니다. */
async function setup(label, engineCfg = {}) {
  const id = ++seq; // 병렬 실행 시 섞이지 않도록 지역 변수로 고정
  const email = `e2e-${id}-${Date.now()}@example.com`;
  const { token } = await api('POST', '/api/auth/register', undefined, { email, password: 'password-1234', name: label });
  await api('PUT', '/api/settings/role-assignments', token, { assignments: { '*': 'mock' } });
  const home = path.join(TMP, `engine-${id}`);
  const env = { EUM_ENGINE_HOME: home };
  const { code } = await api('POST', '/api/agents/pairing-code', token);
  execFileSync(process.execPath, [CLI, 'pair', '--server', BASE, '--code', code, '--name', `${label}-PC`], { env: { ...process.env, ...env } });
  const cfgFile = path.join(home, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, enableMock: true, workspaceRoot: path.join(home, 'workspaces'), ...engineCfg }));
  const startEngine = () => start(`engine-${label}-${Date.now()}`, process.execPath, [CLI, 'start'], env);
  return { token, home, startEngine, workspaces: path.join(home, 'workspaces') };
}

const createProject = (token, extra = {}) =>
  api('POST', '/api/projects', token, {
    name: '계산기',
    description: '더하기와 곱하기를 지원하는 계산기 모듈을 만들어 주세요.',
    kind: 'api',
    automationMode: 'auto',
    splitTasks: true, // E2E 는 분할 경로(dev-1, dev-2 …)까지 검증
    ...extra,
  }).then((r) => r.id);

async function waitFor(token, projectId, pred, what, timeoutMs = 120_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await api('GET', `/api/projects/${projectId}`, token);
    if (pred(last)) return last;
    await sleep(400);
  }
  throw new Error(`시간 초과: ${what}\n` + last.tasks.map((t) => `  ${t.key}: ${t.status} ${JSON.stringify(t.result)}`).join('\n'));
}
const statusIs = (...s) => (d) => s.includes(d.project.status);
const summary = (d) => d.tasks.map((t) => `${t.key}:${t.status}`);

async function scenario(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
    console.log(`  ✖ ${name}\n    ${String(e.stack || e).split('\n').join('\n    ')}`);
  }
}

// ───────────────────────── 시나리오 ─────────────────────────

async function happyPath() {
  const s = await setup('정상');
  const engine = s.startEngine();
  // 실시간 로그(WebSocket) 수신 확인
  const live = [];
  const pid = await createProject(s.token);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: s.token }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'ready') {
        ws.send(JSON.stringify({ type: 'subscribe', projectId: pid }));
        res();
      } else if (msg.type === 'event') live.push(msg.event);
    };
    ws.onerror = rej;
  });

  const d = await waitFor(s.token, pid, statusIs('review', 'failed'), '정상 흐름 완료');
  assert.deepEqual(summary(d), ['plan:succeeded', 'dev-1:succeeded', 'dev-2:succeeded', 'verify-1:succeeded', 'package:succeeded']);
  assert.equal(d.project.status, 'review');

  // 실제 테스트 명령 결과가 기록되어 있다
  const run = d.testRuns[0];
  assert.equal(run.status, 'passed');
  const cmds = run.results.map((r) => `${r.command}=${r.exit_code}`);
  assert.deepEqual(cmds, ['npm test=0', 'npm run build=0']);
  assert.match(run.results[0].log_tail, /pass 2/);

  // 결과물: 실제 ZIP 파일, 서버 기록 해시와 다운로드한 파일의 해시가 일치
  assert.equal(d.artifacts.length, 1);
  const art = d.artifacts[0];
  const { url } = await api('POST', `/api/artifacts/${art.id}/link`, s.token);
  const dlRes = await fetch(BASE + url);
  assert.match(dlRes.headers.get('content-disposition'), /^attachment; filename="download\.zip"; filename\*=UTF-8''.+-source-[0-9a-f]{8}\.zip$/);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  assert.equal(createHash('sha256').update(buf).digest('hex'), art.sha256);
  assert.equal(buf.length, Number(art.size));
  const zip = path.join(TMP, 'happy.zip');
  fs.writeFileSync(zip, buf);
  const listing = execFileSync('unzip', ['-Z1', zip]).toString();
  for (const f of ['package.json', 'src/calc.js', 'test/add.test.js', 'test/mul.test.js', 'docs/PRD.md', 'docs/TASKS.json', 'README.md'])
    assert.ok(listing.split('\n').includes(f), `ZIP 에 ${f} 없음`);
  assert.ok(!listing.includes('node_modules'));

  // 압축을 풀어 다시 테스트해도 통과한다 (결과물이 실제로 동작)
  const out = path.join(TMP, 'happy-unzipped');
  execFileSync('unzip', ['-q', zip, '-d', out]);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  execFileSync('npm', ['test'], { cwd: out, env, stdio: 'pipe' });

  // 로그: 저장된 이벤트는 작업·시도별로 순번이 빠짐없이 이어진다
  const events = await api('GET', `/api/projects/${pid}/events?tail=1000`, s.token);
  const bySeq = new Map();
  for (const e of events) {
    const k = `${e.taskId}:${e.attemptNo}`;
    bySeq.set(k, [...(bySeq.get(k) || []), e.seq]);
  }
  for (const seqs of bySeq.values()) assert.deepEqual(seqs, seqs.map((_, i) => i));
  assert.ok(events.some((e) => e.type === 'file' && e.message === 'add: src/calc.js'));
  assert.ok(events.some((e) => e.message.includes('$ npm test')));
  assert.ok(live.length > 0, 'WebSocket 으로 실시간 이벤트를 받지 못함');
  ws.close();

  // 작업 폴더는 엔진의 작업 루트 안에만 생긴다
  assert.ok(d.repository.local_path.startsWith(fs.realpathSync(s.workspaces)));
  assert.equal(d.repository.head_commit.length, 40);

  // 최종 승인 → 완료
  const final = d.approvals.find((a) => a.kind === 'final' && a.status === 'pending');
  await api('POST', `/api/approvals/${final.id}/decide`, s.token, { approve: true });
  assert.equal((await api('GET', `/api/projects/${pid}`, s.token)).project.status, 'completed');

  // 대시보드에 PC·AI 상태가 보인다
  const dash = await api('GET', '/api/dashboard', s.token);
  assert.equal(dash.agents[0].status, 'online');
  assert.deepEqual(dash.agents[0].providers.map((p) => p.key).sort(), ['antigravity', 'claude', 'codex', 'mock']);
  assert.equal(dash.counts.completed, 1);
  engine.kill('SIGTERM');
}

async function autoFix() {
  const s = await setup('자동수정', { mockScenario: 'fail-once' });
  const engine = s.startEngine();
  const pid = await createProject(s.token);
  const d = await waitFor(s.token, pid, statusIs('review', 'failed'), '자동 수정 흐름 완료');
  assert.deepEqual(summary(d), ['plan:succeeded', 'dev-1:succeeded', 'dev-2:succeeded', 'verify-1:failed', 'fix-1:succeeded', 'verify-2:succeeded', 'package:succeeded']);
  const failedRun = d.testRuns.find((r) => r.status === 'failed');
  const bad = failedRun.results.find((r) => r.status === 'failed');
  assert.equal(bad.command, 'npm test');
  assert.notEqual(bad.exit_code, 0);
  assert.match(bad.log_tail, /더하기/);
  assert.ok(d.testRuns.some((r) => r.status === 'passed'));
  assert.equal(d.project.status, 'review');
  engine.kill('SIGTERM');
}

async function retryLimit() {
  const s = await setup('한도', { mockScenario: 'always-bad' });
  const engine = s.startEngine();
  const pid = await createProject(s.token);
  const d = await waitFor(s.token, pid, statusIs('review', 'failed'), '재시도 한도 도달', 180_000);
  assert.equal(d.project.status, 'failed');
  assert.equal(d.tasks.filter((t) => t.key.startsWith('fix-')).length, 3);
  assert.equal(d.tasks.find((t) => t.key === 'verify-4').status, 'failed');
  assert.equal(d.tasks.find((t) => t.key === 'package').status, 'blocked');
  assert.equal(d.artifacts.length, 0, '검증 실패한 프로젝트에 결과물이 있으면 안 됨');
  engine.kill('SIGTERM');
}

async function falseCompletion() {
  const s = await setup('허위완료', { mockScenario: 'no-change' });
  const engine = s.startEngine();
  const pid = await createProject(s.token);
  const d = await waitFor(s.token, pid, statusIs('review', 'failed'), '허위 완료 판정');
  assert.equal(d.project.status, 'failed');
  const plan = d.tasks.find((t) => t.key === 'plan');
  assert.equal(plan.status, 'failed');
  assert.equal(plan.attempt_count, 3);
  assert.match(plan.result.reason, /필수 산출물이 생성되지 않았습니다/);
  engine.kill('SIGTERM');
}

async function crashRecovery() {
  const s = await setup('복구', { mockDelayMs: 6000 });
  let engine = s.startEngine();
  const pid = await createProject(s.token);
  await waitFor(s.token, pid, (d) => d.tasks[0].status === 'running', '첫 작업 실행 시작');
  // 1) PC 엔진이 갑자기 죽음 → 서버가 임대 만료로 작업을 회수
  engine.kill('SIGKILL');
  let d = await waitFor(s.token, pid, (x) => x.tasks[0].status === 'queued', '임대 만료 후 대기열 복귀', 30_000);
  assert.equal(d.tasks[0].attempt_count, 1);
  assert.match(d.tasks[0].result.reason, /임대가 만료/);
  // 2) 엔진 재시작 → 같은 작업을 2번째 시도로 다시 수행
  engine = s.startEngine();
  await waitFor(s.token, pid, (x) => x.tasks[0].status === 'running' && x.tasks[0].attempt_count === 2, '재시작 후 재실행');
  // 3) 다시 죽이고 곧바로 재시작 → 엔진이 시작하면서 즉시 복구 요청
  engine.kill('SIGKILL');
  engine = s.startEngine();
  d = await waitFor(s.token, pid, (x) => x.tasks[0].attempt_count === 3 && x.tasks[0].status === 'running', '즉시 복구 후 3번째 시도', 30_000);
  d = await waitFor(s.token, pid, statusIs('review', 'failed'), '복구 후 전체 완료', 180_000);
  assert.equal(d.project.status, 'review');
  assert.equal(d.artifacts.length, 1);
  engine.kill('SIGTERM');
}

async function cancelRunning() {
  const s = await setup('취소', { mockDelayMs: 30_000 });
  const engine = s.startEngine();
  const pid = await createProject(s.token);
  await waitFor(s.token, pid, (d) => d.tasks[0].status === 'running', '첫 작업 실행 시작');
  await api('POST', `/api/projects/${pid}/cancel`, s.token);
  const d = await waitFor(s.token, pid, (x) => x.tasks.every((t) => t.status === 'cancelled'), '실행 중 작업 중단', 20_000);
  assert.equal(d.project.status, 'cancelled');
  engine.kill('SIGTERM');
}

async function manualMode() {
  const s = await setup('수동승인');
  const engine = s.startEngine();
  const pid = await createProject(s.token, { automationMode: 'manual' });
  let approvals = 0;
  const t0 = Date.now();
  for (;;) {
    const d = await api('GET', `/api/projects/${pid}`, s.token);
    if (['review', 'failed'].includes(d.project.status)) {
      assert.equal(d.project.status, 'review');
      break;
    }
    const pending = d.approvals.find((a) => a.kind === 'task' && a.status === 'pending');
    if (pending) {
      // 승인 전에는 해당 작업이 실행되지 않는다
      assert.equal(d.tasks.find((t) => t.id === pending.task_id).status, 'awaiting_approval');
      await api('POST', `/api/approvals/${pending.id}/decide`, s.token, { approve: true });
      approvals++;
    }
    if (Date.now() - t0 > 120_000) throw new Error('수동 승인 흐름 시간 초과');
    await sleep(400);
  }
  assert.equal(approvals, 3); // 기획 1 + 개발 2 (검증·패키징은 AI 작업이 아니므로 자동)
  engine.kill('SIGTERM');
}

// ───────────────────────── 실행 ─────────────────────────

async function main() {
  console.log('EUM E2E 검증 시작');
  execFileSync('psql', [DATABASE_URL, '-qc', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'], { stdio: 'pipe' });
  start('server', process.execPath, [path.join(ROOT, 'apps/server/dist/src/main.js')], {
    DATABASE_URL,
    PORT: String(PORT),
    JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret',
    ALLOW_SIGNUP: '1',
    RATE_LIMIT_MAX: '100000',
    LEASE_SEC: '5',
    STORAGE_DIR: path.join(TMP, 'storage'),
  });
  for (let i = 0; ; i++) {
    try {
      await api('GET', '/api/health');
      break;
    } catch {
      if (i > 60) throw new Error(`서버가 시작되지 않았습니다. 로그: ${TMP}/server.log`);
      await sleep(250);
    }
  }
  await Promise.all([
    scenario('정상 흐름: 요청 → 기획 → 작업 분할 → 구현 → 테스트 → ZIP → 다운로드 → 승인', happyPath),
    scenario('자동 오류 수정: 테스트 실패 → 수정 작업 → 재검증 통과', autoFix),
    scenario('재시도 한도: 수정 3회 실패 시 중단하고 실패 보고 (결과물 없음)', retryLimit),
    scenario('허위 완료 차단: AI 가 완료라고 해도 산출물이 없으면 실패', falseCompletion),
    scenario('장애 복구: PC 엔진 강제 종료 → 임대 만료 회수 → 재시작 후 완료', crashRecovery),
    scenario('실행 중 취소: 사용자가 취소하면 PC 의 작업 프로세스가 중단됨', cancelRunning),
    scenario('수동 승인 모드: 승인할 때마다 한 단계씩 진행', manualMode),
  ]);
}

let failed = false;
try {
  await main();
  failed = results.some((r) => !r.ok) || results.length === 0;
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  for (const c of children) c.kill('SIGKILL');
  if (process.env.E2E_REPORT) fs.writeFileSync(process.env.E2E_REPORT, JSON.stringify(results, null, 2));
  console.log(`\n결과: ${results.filter((r) => r.ok).length}/${results.length} 통과${failed ? ` — 로그: ${TMP}` : ''}`);
  if (!failed) fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
