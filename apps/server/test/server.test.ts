import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Client } from 'pg';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5544/eum_test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
process.env.ALLOW_SIGNUP = '1';
process.env.RATE_LIMIT_MAX = '100000';
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eum-storage-'));

import { RunningServer, startServer } from '../src/main';
import { Db } from '../src/db';
import { parseTasksJson, Pipeline } from '../src/pipeline';

let srv: RunningServer;
let db: Db;
let pipeline: Pipeline;

async function http(method: string, p: string, token?: string, body?: unknown) {
  const res = await fetch(srv.url + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

let n = 0;
async function newUser() {
  const email = `user${++n}-${Date.now()}@example.com`;
  const r = await http('POST', '/api/auth/register', undefined, { email, password: 'password-1234', name: `사용자${n}` });
  assert.equal(r.status, 201);
  return r.body.token as string;
}
async function newAgent(userToken: string, name = 'PC') {
  const code = await http('POST', '/api/agents/pairing-code', userToken);
  const r = await http('POST', '/api/agent/pair', undefined, { code: code.body.code, name });
  assert.equal(r.status, 201);
  return { token: r.body.token as string, id: r.body.agentId as string, code: code.body.code as string };
}
async function newProject(userToken: string, extra: Record<string, unknown> = {}) {
  const r = await http('POST', '/api/projects', userToken, {
    name: '테스트 프로젝트',
    description: '간단한 계산기 프로그램을 만들어 주세요.',
    kind: 'web',
    ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
}
const claim = (agentToken: string) => http('POST', '/api/agent/claim', agentToken, { providers: ['codex'] });
const complete = (agentToken: string, taskId: string, body: Record<string, unknown>) =>
  http('POST', `/api/agent/tasks/${taskId}/complete`, agentToken, body);
const planFiles = (tasksJson?: string) => ({
  'docs/PRD.md': { exists: true },
  'docs/REQUIREMENTS.md': { exists: true },
  'docs/ARCHITECTURE.md': { exists: true },
  'docs/ACCEPTANCE_CRITERIA.md': { exists: true },
  'docs/TASKS.json': { exists: true, content: tasksJson },
});
async function tasksOf(userToken: string, projectId: string) {
  const r = await http('GET', `/api/projects/${projectId}`, userToken);
  return { project: r.body.project, tasks: r.body.tasks as any[], all: r.body };
}

before(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  db = srv.app.get(Db);
  pipeline = srv.app.get(Pipeline);
});
after(async () => {
  await srv.close();
  fs.rmSync(process.env.STORAGE_DIR!, { recursive: true, force: true });
});

test('마이그레이션: 지시서의 26개 테이블이 모두 생성된다', async () => {
  const want = ['users', 'organizations', 'organization_members', 'projects', 'project_requirements', 'project_files', 'project_versions', 'desktop_agents', 'ai_providers', 'ai_provider_capabilities', 'ai_role_assignments', 'ai_tasks', 'ai_task_dependencies', 'ai_task_attempts', 'ai_execution_events', 'approvals', 'git_repositories', 'git_branches', 'test_runs', 'test_results', 'build_jobs', 'build_artifacts', 'deployments', 'notifications', 'audit_logs', 'system_settings'];
  const rows = await db.q<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  const have = new Set(rows.map((r) => r.table_name));
  assert.deepEqual(want.filter((t) => !have.has(t)), []);
});

test('TASKS.json 검증: 형식 오류·알 수 없는 의존성·순환 의존을 거부한다', () => {
  assert.ok(parseTasksJson('{"tasks":[{"id":"A","title":"a"},{"id":"B","title":"b","dependsOn":["A"]}]}').tasks);
  assert.match(parseTasksJson('not json').error!, /JSON/);
  assert.match(parseTasksJson('{"tasks":[]}').error!, /형식/);
  assert.match(parseTasksJson('{"tasks":[{"id":"A","title":"a","dependsOn":["Z"]}]}').error!, /선행/);
  assert.match(parseTasksJson('{"tasks":[{"id":"A","title":"a","dependsOn":["B"]},{"id":"B","title":"b","dependsOn":["A"]}]}').error!, /순환/);
  assert.match(parseTasksJson('{"tasks":[{"id":"A","title":"a"},{"id":"A","title":"b"}]}').error!, /중복/);
});

test('인증: 로그인 없이는 접근할 수 없고, 잘못된 비밀번호는 거부된다', async () => {
  assert.equal((await http('GET', '/api/projects')).status, 401);
  assert.equal((await http('GET', '/api/projects', 'garbage')).status, 401);
  const email = `login-${Date.now()}@example.com`;
  await http('POST', '/api/auth/register', undefined, { email, password: 'password-1234', name: '로그인' });
  assert.equal((await http('POST', '/api/auth/login', undefined, { email, password: 'wrong-password' })).status, 401);
  const ok = await http('POST', '/api/auth/login', undefined, { email, password: 'password-1234' });
  assert.equal(ok.status, 201);
  assert.equal((await http('GET', '/api/auth/me', ok.body.token)).body.email, email);
  const row = await db.one('SELECT password_hash FROM users WHERE email = $1', [email]);
  assert.ok(!row.password_hash.includes('password-1234'), '비밀번호가 평문으로 저장되면 안 됨');
});

test('조직 격리: 다른 조직의 프로젝트·승인·결과물에 접근할 수 없다', async () => {
  const a = await newUser();
  const b = await newUser();
  const pid = await newProject(a);
  assert.equal((await http('GET', `/api/projects/${pid}`, b)).status, 404);
  assert.equal((await http('GET', `/api/projects/${pid}/events`, b)).status, 404);
  assert.equal((await http('POST', `/api/projects/${pid}/cancel`, b)).status, 404);
  assert.equal((await http('GET', '/api/projects', b)).body.length, 0);
  // 다른 조직의 PC 엔진은 이 프로젝트의 작업을 가져갈 수 없다
  const agentB = await newAgent(b);
  assert.equal((await claim(agentB.token)).body.task, null);
  const agentA = await newAgent(a);
  assert.equal((await claim(agentA.token)).body.task.key, 'plan');
});

test('PC 등록: 연결 코드는 한 번만 쓸 수 있고, 토큰은 해시로만 저장된다', async () => {
  const u = await newUser();
  const agent = await newAgent(u);
  const again = await http('POST', '/api/agent/pair', undefined, { code: agent.code, name: '재사용' });
  assert.equal(again.status, 400);
  const row = await db.one('SELECT token_hash FROM desktop_agents WHERE id = $1', [agent.id]);
  assert.notEqual(row.token_hash, agent.token);
  assert.equal((await http('POST', '/api/agent/claim', 'eumag_invalid', { providers: [] })).status, 401);
  // 연결 해제 후에는 토큰이 무효
  assert.equal((await http('DELETE', `/api/agents/${agent.id}`, u)).status, 200);
  assert.equal((await claim(agent.token)).status, 401);
});

test('작업 임대: 두 PC 가 동시에 요청해도 한 작업은 한 PC 에만 배정된다', async () => {
  const u = await newUser();
  await newProject(u);
  const a1 = await newAgent(u, 'PC-1');
  const a2 = await newAgent(u, 'PC-2');
  const [r1, r2] = await Promise.all([claim(a1.token), claim(a2.token)]);
  const got = [r1.body.task, r2.body.task].filter(Boolean);
  assert.equal(got.length, 1);
  // 같은 프로젝트의 다음 작업은 처음 배정된 PC 에만 간다 (작업 폴더가 그 PC 에 있음)
  const winner = r1.body.task ? a1 : a2;
  const loser = r1.body.task ? a2 : a1;
  await complete(winner.token, got[0].id, { attemptNo: 1, exitCode: 0, changedFiles: ['docs/PRD.md'], files: planFiles() });
  assert.equal((await claim(loser.token)).body.task, null);
  assert.equal((await claim(winner.token)).body.task.key, 'implement');
});

test('완료 판정: AI 가 완료했다고 해도 실제 변경·산출물이 없으면 성공 처리하지 않는다', async () => {
  const u = await newUser();
  const pid = await newProject(u);
  const agent = await newAgent(u);
  let t = (await claim(agent.token)).body.task;
  // 종료 코드 0 이지만 필수 문서 없음
  let r = await complete(agent.token, t.id, { attemptNo: 1, exitCode: 0, changedFiles: ['x'], files: {} });
  assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /필수 산출물/);
  // 재시도: 문서는 있다고 하지만 변경 파일 없음
  t = (await claim(agent.token)).body.task;
  assert.equal(t.attemptNo, 2);
  r = await complete(agent.token, t.id, { attemptNo: 2, exitCode: 0, changedFiles: [], files: planFiles() });
  assert.match(r.body.reason, /변경된 파일이 없습니다/);
  // 3번째도 실패하면 재시도 한도 소진 → 프로젝트 실패
  t = (await claim(agent.token)).body.task;
  r = await complete(agent.token, t.id, { attemptNo: 3, exitCode: 2, error: '도구 오류' });
  const s = await tasksOf(u, pid);
  assert.equal(s.tasks.find((x) => x.key === 'plan').status, 'failed');
  assert.equal(s.project.status, 'failed');
  assert.equal((await claim(agent.token)).body.task, null);
});

test('중복 방지: 같은 완료 보고·이벤트를 다시 보내도 한 번만 반영된다', async () => {
  const u = await newUser();
  const pid = await newProject(u);
  const agent = await newAgent(u);
  const t = (await claim(agent.token)).body.task;
  const events = [
    { seq: 0, type: 'log', message: '첫 줄' },
    { seq: 1, type: 'log', message: '둘째 줄' },
  ];
  assert.equal((await http('POST', `/api/agent/tasks/${t.id}/events`, agent.token, { attemptNo: 1, events })).body.stored, 2);
  assert.equal((await http('POST', `/api/agent/tasks/${t.id}/events`, agent.token, { attemptNo: 1, events: [...events, { seq: 2, type: 'log', message: '셋째 줄' }] })).body.stored, 1);
  const list = (await http('GET', `/api/projects/${pid}/events`, u)).body;
  assert.deepEqual(list.map((e: any) => e.message), ['첫 줄', '둘째 줄', '셋째 줄']);
  const body = { attemptNo: 1, exitCode: 0, changedFiles: ['docs/PRD.md'], files: planFiles() };
  assert.equal((await complete(agent.token, t.id, body)).body.accepted, true);
  assert.equal((await complete(agent.token, t.id, body)).body.accepted, false);
  const s = await tasksOf(u, pid);
  assert.equal(s.tasks.find((x) => x.key === 'plan').attempt_count, 1);
});

test('작업 분할: 유효한 TASKS.json 은 의존성이 있는 개발 작업으로 확장된다', async () => {
  const u = await newUser();
  const pid = await newProject(u);
  const agent = await newAgent(u);
  const t = (await claim(agent.token)).body.task;
  const tasksJson = JSON.stringify({
    tasks: [
      { id: 'B', title: '둘째', dependsOn: ['A'] },
      { id: 'A', title: '첫째' },
      { id: 'C', title: '셋째', dependsOn: ['A', 'B'], role: 'frontend' },
    ],
  });
  await complete(agent.token, t.id, { attemptNo: 1, exitCode: 0, changedFiles: ['docs/TASKS.json'], files: planFiles(tasksJson) });
  const s = await tasksOf(u, pid);
  const keys = s.tasks.map((x) => x.key);
  assert.deepEqual(keys, ['plan', 'dev-1', 'dev-2', 'dev-3', 'verify-1', 'package']);
  assert.equal(s.tasks[1].title, '첫째');
  assert.equal(s.tasks[1].status, 'queued');
  assert.equal(s.tasks[2].status, 'blocked');
  assert.equal(s.tasks[3].role, 'frontend');
  assert.equal(s.tasks.find((x) => x.key === 'verify-1').depends_on.length, 3);
  // 잘못된 TASKS.json 이면 단일 구현 작업을 유지한다
  const pid2 = await newProject(u);
  const u2tasks = async () => (await tasksOf(u, pid2)).tasks.map((x) => x.key);
  await complete(agent.token, (await claimFor(agent.token, pid2)).id, { attemptNo: 1, exitCode: 0, changedFiles: ['a'], files: planFiles('{broken') });
  assert.deepEqual(await u2tasks(), ['plan', 'implement', 'verify-1', 'package']);
});

/** 특정 프로젝트의 작업이 나올 때까지 임대합니다(다른 프로젝트 작업은 즉시 실패 처리하지 않고 건너뛸 수 없으므로 테스트는 프로젝트를 직렬로 사용). */
async function claimFor(agentToken: string, projectId: string) {
  for (let i = 0; i < 20; i++) {
    const r = (await claim(agentToken)).body;
    if (r.task && r.project.id === projectId) return r.task;
    if (r.task) await complete(agentToken, r.task.id, { attemptNo: r.task.attemptNo, exitCode: 0, changedFiles: ['x'], files: planFiles() });
  }
  throw new Error('작업을 임대하지 못했습니다');
}

async function runUntilVerify(u: string, agentToken: string, extra: Record<string, unknown> = {}) {
  const pid = await newProject(u, extra);
  let t = await claimFor(agentToken, pid);
  await complete(agentToken, t.id, { attemptNo: 1, exitCode: 0, changedFiles: ['docs/PRD.md'], files: planFiles() });
  t = (await claim(agentToken)).body.task;
  assert.equal(t.key, 'implement');
  await complete(agentToken, t.id, { attemptNo: 1, exitCode: 0, changedFiles: ['src/a.js'] });
  t = (await claim(agentToken)).body.task;
  assert.equal(t.kind, 'verify');
  return { pid, verify: t };
}
const testResult = (status: 'passed' | 'failed', category = 'test') => ({
  category,
  name: '자동 테스트',
  command: 'npm test',
  cwd: '.',
  exitCode: status === 'passed' ? 0 : 1,
  status,
  durationMs: 10,
  logTail: status === 'failed' ? 'AssertionError: 5 !== -1' : 'ok',
});

test('검증: 실제 테스트 결과가 없으면 통과 처리하지 않고, 실패하면 수정 작업을 만든다', async () => {
  const u = await newUser();
  const agent = await newAgent(u);
  const { pid, verify } = await runUntilVerify(u, agent.token);
  // 설치만 성공하고 테스트·빌드가 하나도 없으면 "미검증"
  let r = await complete(agent.token, verify.id, { attemptNo: 1, exitCode: 0, tests: [testResult('passed', 'install')] });
  assert.equal(r.body.ok, false);
  let s = await tasksOf(u, pid);
  assert.deepEqual(s.tasks.map((x) => `${x.key}:${x.status}`).slice(2), ['verify-1:failed', 'fix-1:queued', 'verify-2:blocked', 'package:blocked']);
  assert.equal(s.all.testRuns[0].status, 'unverified');
  assert.equal(s.project.status, 'running');
  // 수정 작업의 지시문에는 실패 정보가 담긴다
  let t = (await claim(agent.token)).body.task;
  assert.equal(t.key, 'fix-1');
  assert.match(t.prompt, /테스트·빌드 명령을 하나도 찾지 못했습니다/);
  await complete(agent.token, t.id, { attemptNo: 1, exitCode: 0, changedFiles: ['package.json'] });
  t = (await claim(agent.token)).body.task;
  assert.equal(t.key, 'verify-2');
  r = await complete(agent.token, t.id, { attemptNo: 1, exitCode: 0, tests: [testResult('failed')] });
  t = (await claim(agent.token)).body.task;
  assert.equal(t.key, 'fix-2');
  assert.match(t.prompt, /AssertionError: 5 !== -1/);
  assert.match(t.prompt, /npm test/);
});

test('재시도 한도: 자동 수정 3회를 모두 쓰면 무한 반복하지 않고 실패로 보고한다', async () => {
  const u = await newUser();
  const agent = await newAgent(u);
  const { pid, verify } = await runUntilVerify(u, agent.token);
  let v = verify;
  for (let round = 1; round <= 3; round++) {
    await complete(agent.token, v.id, { attemptNo: 1, exitCode: 0, tests: [testResult('failed')] });
    const fix = (await claim(agent.token)).body.task;
    assert.equal(fix.key, `fix-${round}`);
    await complete(agent.token, fix.id, { attemptNo: 1, exitCode: 0, changedFiles: ['src/a.js'] });
    v = (await claim(agent.token)).body.task;
    assert.equal(v.key, `verify-${round + 1}`);
  }
  await complete(agent.token, v.id, { attemptNo: 1, exitCode: 0, tests: [testResult('failed')] });
  const s = await tasksOf(u, pid);
  assert.equal(s.project.status, 'failed');
  assert.equal(s.tasks.filter((x) => x.key.startsWith('fix-')).length, 3);
  assert.equal(s.tasks.find((x) => x.key === 'package').status, 'blocked');
  assert.equal((await claim(agent.token)).body.task, null);
  const notes = (await http('GET', '/api/notifications', u)).body;
  assert.ok(notes.some((x: any) => x.type === 'failed'));
  // 사용자가 다시 시도하면 수정 횟수가 추가로 부여된다
  assert.equal((await http('POST', `/api/projects/${pid}/retry`, u)).status, 201);
  assert.equal((await claim(agent.token)).body.task.key, 'verify-4');
});

test('결과물: 해시가 다르면 거부하고, 업로드된 파일이 있어야 패키징이 완료된다', async () => {
  const u = await newUser();
  const agent = await newAgent(u);
  const { pid, verify } = await runUntilVerify(u, agent.token);
  await complete(agent.token, verify.id, { attemptNo: 1, exitCode: 0, tests: [testResult('passed'), testResult('passed', 'build')] });
  let t = (await claim(agent.token)).body.task;
  assert.equal(t.kind, 'package');
  // 업로드 없이 완료 보고 → 실패(재시도)
  let r = await complete(agent.token, t.id, { attemptNo: 1, exitCode: 0 });
  assert.match(r.body.reason, /업로드되지 않았습니다/);
  t = (await claim(agent.token)).body.task;
  const data = Buffer.from('PK-fake-zip-content');
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const upload = async (sha: string) => {
    const form = new FormData();
    form.append('attemptNo', String(t.attemptNo));
    form.append('kind', 'source_zip');
    form.append('filename', '결과물.zip');
    form.append('sha256', sha);
    form.append('file', new Blob([data]), 'a.zip');
    return fetch(`${srv.url}/api/agent/tasks/${t.id}/artifacts`, { method: 'POST', headers: { authorization: `Bearer ${agent.token}` }, body: form });
  };
  assert.equal((await upload('0'.repeat(64))).status, 400);
  assert.equal((await upload(hash)).status, 201);
  assert.equal((await upload(hash)).status, 201); // 같은 파일을 다시 올려도
  r = await complete(agent.token, t.id, { attemptNo: t.attemptNo, exitCode: 0 });
  assert.equal(r.body.ok, true);
  const s = await tasksOf(u, pid);
  assert.equal(s.all.artifacts.length, 1); // 결과물은 한 건만 기록된다
  assert.equal(s.all.artifacts[0].sha256, hash);
  assert.equal(s.project.status, 'review');
  // 다운로드: 서명된 링크로만 가능, 내용 일치
  const other = await newUser();
  assert.equal((await http('POST', `/api/artifacts/${s.all.artifacts[0].id}/link`, other)).status, 404);
  const link = (await http('POST', `/api/artifacts/${s.all.artifacts[0].id}/link`, u)).body.url;
  const dl = await fetch(srv.url + link);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await dl.arrayBuffer())).digest('hex'), hash);
  assert.equal((await fetch(`${srv.url}/api/download/${s.all.artifacts[0].id}?token=bad`)).status, 403);
  // 최종 승인 전에는 완료가 아니다
  const final = s.all.approvals.find((a: any) => a.kind === 'final');
  assert.equal(final.status, 'pending');
  await http('POST', `/api/approvals/${final.id}/decide`, u, { approve: true });
  assert.equal((await tasksOf(u, pid)).project.status, 'completed');
});

test('수동 승인 모드: 승인 전에는 AI 작업이 PC 로 전달되지 않는다', async () => {
  const u = await newUser();
  const agent = await newAgent(u);
  const pid = await newProject(u, { automationMode: 'manual' });
  assert.equal((await claim(agent.token)).body.task, null);
  let s = await tasksOf(u, pid);
  assert.equal(s.project.status, 'awaiting_approval');
  const ap = s.all.approvals.find((a: any) => a.kind === 'task' && a.status === 'pending');
  await http('POST', `/api/approvals/${ap.id}/decide`, u, { approve: true });
  assert.equal((await claim(agent.token)).body.task.key, 'plan');
  assert.equal((await http('POST', `/api/approvals/${ap.id}/decide`, u, { approve: true })).status, 400);
});

test('복구: 임대가 만료된 작업은 대기열로 돌아가고, 늦게 온 보고는 무시된다', async () => {
  const u = await newUser();
  const agent = await newAgent(u);
  const pid = await newProject(u);
  const t = (await claim(agent.token)).body.task;
  assert.equal((await http('POST', `/api/agent/tasks/${t.id}/heartbeat`, agent.token, { attemptNo: 1 })).body.lost, false);
  await db.q(`UPDATE ai_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [t.id]);
  assert.ok((await pipeline.reap()) >= 1);
  let s = await tasksOf(u, pid);
  assert.equal(s.tasks[0].status, 'queued');
  assert.equal((await http('POST', `/api/agent/tasks/${t.id}/heartbeat`, agent.token, { attemptNo: 1 })).body.lost, true);
  const late = await complete(agent.token, t.id, { attemptNo: 1, exitCode: 0, changedFiles: ['x'], files: planFiles() });
  assert.equal(late.body.accepted, false);
  const t2 = (await claim(agent.token)).body.task;
  assert.equal(t2.attemptNo, 2);
  // PC 엔진 재시작 시에는 즉시 복구
  assert.equal((await http('POST', '/api/agent/recover', agent.token, {})).body.recovered, 1);
  s = await tasksOf(u, pid);
  assert.equal(s.tasks[0].status, 'queued');
});

test('취소: 대기 작업은 즉시 취소되고 실행 중 작업에는 중단 신호가 전달된다', async () => {
  const u = await newUser();
  const agent = await newAgent(u);
  const pid = await newProject(u);
  const t = (await claim(agent.token)).body.task;
  await http('POST', `/api/projects/${pid}/cancel`, u);
  assert.equal((await http('POST', `/api/agent/tasks/${t.id}/heartbeat`, agent.token, { attemptNo: 1 })).body.cancel, true);
  await complete(agent.token, t.id, { attemptNo: 1, exitCode: 1, cancelled: true });
  const s = await tasksOf(u, pid);
  assert.equal(s.project.status, 'cancelled');
  assert.ok(s.tasks.every((x) => x.status === 'cancelled'));
});

test('사용량 한도: 한도 도달 보고는 시도 횟수를 소모하지 않고 재개 시각까지 배정을 미룬다', async () => {
  const u = await newUser();
  const pid = await newProject(u);
  const agent = await newAgent(u);
  const t = (await claim(agent.token)).body.task;
  const r = await complete(agent.token, t.id, { attemptNo: 1, exitCode: 1, error: "You've hit your 5-hour limit · resets 2:40am", retryAfterSec: 3600 });
  assert.equal(r.body.accepted, true);
  let s = await tasksOf(u, pid);
  const plan = s.tasks.find((x) => x.key === 'plan');
  assert.equal(plan.status, 'queued');
  assert.equal(plan.result.rateLimited, true);
  assert.equal(plan.max_attempts, 4); // 시도 횟수 보전
  assert.equal((await claim(agent.token)).body.task, null); // 재개 시각 전에는 배정되지 않음
  const notes = (await http('GET', '/api/notifications', u)).body;
  assert.ok(notes.some((n: any) => n.title.includes('사용량 한도')));
});

test('사용량 한도: 같은 PC 에 다른 AI 도구가 있으면 즉시 그 도구로 넘겨 계속 진행한다', async () => {
  const u = await newUser();
  const pid = await newProject(u);
  const agent = await newAgent(u);
  const prov = (key: string) => ({ key, displayName: key, installed: true, authenticated: true, executionPolicy: { allowed: true } });
  await http('POST', '/api/agent/heartbeat', agent.token, { providers: [prov('codex'), prov('claude')] });
  const t = (await claim(agent.token)).body.task; // 기본 배정: codex
  assert.equal(t.providerKey, 'codex');
  const r = await complete(agent.token, t.id, { attemptNo: 1, exitCode: 1, error: 'usage limit reached', retryAfterSec: 3600 });
  assert.equal(r.body.switchedTo, 'claude');
  const next = (await http('POST', '/api/agent/claim', agent.token, { providers: ['claude'] })).body.task;
  assert.ok(next, '전환된 작업이 즉시 배정되어야 함');
  assert.equal(next.key, 'plan');
  assert.equal(next.providerKey, 'claude');
  assert.equal(next.attemptNo, 2);
});

test('감사 로그: 주요 행위가 기록된다', async () => {
  const rows = await db.q<{ action: string }>('SELECT DISTINCT action FROM audit_logs');
  const have = new Set(rows.map((r) => r.action));
  for (const a of ['user.register', 'user.login', 'user.login_failed', 'project.create', 'agent.pair', 'agent.revoke', 'approval.approve', 'artifact.upload', 'artifact.download', 'project.cancel', 'project.retry'])
    assert.ok(have.has(a), `감사 로그 누락: ${a}`);
});
