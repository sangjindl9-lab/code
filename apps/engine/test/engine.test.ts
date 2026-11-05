import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexAdapter, parseCodexLine } from '../src/adapters/codex';
import { AdapterEvent } from '../src/adapters/types';
import { validateServerUrl } from '../src/config';
import { run, safeEnv } from '../src/proc';
import { planChecks, runChecks } from '../src/verify';
import { assertInside, changedFiles, checkpoint, ensureRepo, head, projectDir, resetToCheckpoint } from '../src/workspace';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eum-engine-test-'));

test('경로 격리: 작업 폴더 밖 경로와 심볼릭 링크 탈출을 차단한다', () => {
  const root = tmp();
  const outside = tmp();
  assert.ok(assertInside(root, path.join(root, 'a', 'b.txt')));
  assert.throws(() => assertInside(root, path.join(root, '..', 'x')), /밖의 경로/);
  assert.throws(() => assertInside(root, '/etc/passwd'), /밖의 경로/);
  assert.throws(() => assertInside(root, root + '-sibling/file'), /밖의 경로/);
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => assertInside(root, path.join(root, 'link', 'secret.txt')), /밖의 경로/);
  assert.throws(() => projectDir(root, '../evil'), /형식/);
  assert.throws(() => projectDir(root, 'not-a-uuid'), /형식/);
  assert.ok(projectDir(root, '123e4567-e89b-12d3-a456-426614174000').startsWith(fs.realpathSync(root)));
});

test('환경변수: 엔진 비밀정보(EUM_*)는 하위 프로세스에 전달하지 않는다', async () => {
  process.env.EUM_AGENT_TOKEN = 'eumag_secret';
  const env = safeEnv();
  assert.equal(env.EUM_AGENT_TOKEN, undefined);
  const r = await run(process.execPath, ['-e', 'console.log(process.env.EUM_AGENT_TOKEN || "없음")'], { cwd: tmp() });
  assert.equal(r.stdout.trim(), '없음');
  delete process.env.EUM_AGENT_TOKEN;
});

test('서버 주소: 원격 서버는 HTTPS 만 허용한다', () => {
  assert.equal(validateServerUrl('https://eum.example.com/path'), 'https://eum.example.com');
  assert.equal(validateServerUrl('http://localhost:4000'), 'http://localhost:4000');
  assert.throws(() => validateServerUrl('http://eum.example.com'), /https/);
});

test('프로세스 실행: 제한 시간을 넘기면 자식 프로세스까지 종료한다', async () => {
  const dir = tmp();
  const marker = path.join(dir, 'alive.txt');
  // 부모가 자식을 띄우고, 자식이 2초 뒤 파일을 쓰려 한다. 0.5초 제한으로 둘 다 죽어야 한다.
  const script = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 2000)'], {stdio:'inherit'}); setTimeout(()=>{}, 60000);`;
  const r = await run(process.execPath, ['-e', script], { cwd: dir, timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exitCode, 0);
  await new Promise((res) => setTimeout(res, 2500));
  assert.equal(fs.existsSync(marker), false, '자식 프로세스가 살아남아 파일을 썼음');
});

test('Git 체크포인트: 변경 파일을 실제 diff 로 수집하고, 미완료 변경은 되돌린다', async () => {
  const dir = path.join(tmp(), 'repo');
  await ensureRepo(dir);
  const before = await head(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '1');
  const after = await checkpoint(dir, '작업');
  assert.deepEqual(await changedFiles(dir, before, after), ['a.txt']); // node_modules 는 커밋되지 않음
  assert.equal(await checkpoint(dir, '변경 없음'), after);
  fs.writeFileSync(path.join(dir, 'a.txt'), '중단된 작업의 잔여물');
  fs.writeFileSync(path.join(dir, 'leftover.txt'), 'x');
  await resetToCheckpoint(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello');
  assert.equal(fs.existsSync(path.join(dir, 'leftover.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules', 'x.js')), true);
});

test('검증 계획: package.json 스크립트에서 고정 명령만 만든다', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test', build: 'node build.js', lint: 'eslint .', evil: 'rm -rf /' }, devDependencies: { typescript: '^5' } }),
  );
  fs.mkdirSync(path.join(dir, 'web'));
  fs.writeFileSync(path.join(dir, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  const checks = planChecks(dir);
  assert.deepEqual(
    checks.map((c) => c.command),
    ['npm install --no-audit --no-fund', 'npm run lint', 'npm test', 'npm run build', 'npm audit --audit-level=critical --omit=dev'],
  );
  assert.ok(!checks.some((c) => c.command.includes('evil')));
});

test('검증 실행: 실제 명령의 종료 코드로 통과·실패를 판정한다', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'node -e "console.log(1)"' } }));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), `require('node:test')('실패하는 테스트', () => require('node:assert').strictEqual(1, 2));`);
  let results = await runChecks(dir, {});
  assert.deepEqual(results.map((r) => `${r.category}:${r.status}`), ['test:failed', 'build:passed']);
  assert.notEqual(results[0].exitCode, 0);
  assert.match(results[0].logTail, /실패하는 테스트/);
  fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), `require('node:test')('통과하는 테스트', () => require('node:assert').strictEqual(1, 1));`);
  results = await runChecks(dir, {});
  assert.deepEqual(results.map((r) => r.status), ['passed', 'passed']);
  // 테스트가 전혀 없는 폴더는 검사 항목이 없다 → 서버가 "미검증"으로 판정
  assert.deepEqual(await runChecks(tmp(), {}), []);
});

test('Codex 이벤트 변환: codex exec --json 출력을 한국어 로그 이벤트로 바꾼다', () => {
  const art: any = {};
  assert.equal(parseCodexLine('{"type":"turn.started"}', art), undefined);
  assert.deepEqual(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"완료"}}', art), { type: 'message', message: '완료' });
  assert.equal(art.lastMessage, '완료');
  assert.equal(parseCodexLine('{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}', art)!.message, '$ npm test');
  assert.match(parseCodexLine('{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":1,"aggregated_output":"fail"}}', art)!.message, /종료 코드 1/);
  assert.equal(parseCodexLine('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.ts","kind":"add"}]}}', art)!.message, 'add: a.ts');
  assert.equal(parseCodexLine('{"type":"turn.failed","error":{"message":"usage limit reached"}}', art)!.type, 'error');
  assert.equal(art.lastError, 'usage limit reached');
  assert.deepEqual(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":10}}', art)!.data, { input_tokens: 10 });
  assert.equal(parseCodexLine('일반 텍스트 줄', art)!.type, 'log');
});

/** 실제 Codex 대신 같은 명령줄 규칙을 흉내 내는 대역 실행 파일 (어댑터의 프로세스 연동 검증용) */
function fakeCodex(loginLine: string, loginExit = 0): string {
  const file = path.join(tmp(), 'fake-codex.js');
  fs.writeFileSync(
    file,
    `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0); }
if (a[0] === 'login') { console.log(${JSON.stringify(loginLine)}); process.exit(${loginExit}); }
if (a[0] === 'exec') {
  let input = '';
  process.stdin.on('data', (d) => (input += d)).on('end', () => {
    const out = (o) => console.log(JSON.stringify(o));
    out({ type: 'thread.started', thread_id: 't1' });
    out({ type: 'item.completed', item: { type: 'agent_message', text: 'args=' + a.join(' ') + ' cwd=' + process.cwd() + ' prompt=' + input } });
    if (input.includes('HANG')) return setTimeout(() => {}, 60000);
    require('fs').writeFileSync('made-by-codex.txt', input);
    out({ type: 'turn.completed', usage: { output_tokens: 3 } });
    process.exit(input.includes('FAIL') ? 3 : 0);
  });
}
`,
    { mode: 0o755 },
  );
  return file;
}

test('Codex 어댑터: 설치·로그인 확인과 종량제 API 차단', { skip: process.platform === 'win32' }, async () => {
  const sub = new CodexAdapter({ binary: fakeCodex('Logged in using ChatGPT') });
  assert.deepEqual(await sub.detectInstallation(), { installed: true, version: 'codex-cli 9.9.9' });
  assert.equal((await sub.checkAuthentication()).method, 'chatgpt');
  assert.deepEqual(await sub.checkExecutionPolicy(), { allowed: true, mode: 'automatic', billing: 'subscription' });

  const metered = new CodexAdapter({ binary: fakeCodex('Logged in using an API key - sk-***') });
  const policy = await metered.checkExecutionPolicy();
  assert.equal(policy.allowed, false);
  assert.equal(policy.billing, 'metered');
  assert.equal((await new CodexAdapter({ binary: fakeCodex('Logged in using an API key'), allowMeteredApi: true }).checkExecutionPolicy()).allowed, true);

  assert.equal((await new CodexAdapter({ binary: fakeCodex('Not logged in', 1) }).checkExecutionPolicy()).allowed, false);
  assert.deepEqual(await new CodexAdapter({ binary: '/nonexistent/codex' }).detectInstallation(), { installed: false });
});

test('Codex 어댑터: 작업 폴더에서 샌드박스 옵션으로 실행하고, 지시문은 표준 입력으로 전달한다', { skip: process.platform === 'win32' }, async () => {
  const adapter = new CodexAdapter({ binary: fakeCodex('Logged in using ChatGPT') });
  const cwd = fs.realpathSync(tmp());
  const events: AdapterEvent[] = [];
  const prompt = '계산기를 만들어줘; rm -rf / "$(whoami)"';
  const h = adapter.startTask({ taskId: 't1', prompt, cwd, timeoutMs: 20_000 });
  adapter.streamEvents(h, (e) => events.push(e));
  const r = await h.done;
  assert.equal(r.exitCode, 0);
  const msg = events.find((e) => e.type === 'message')!.message;
  assert.match(msg, /args=exec --json --color never --sandbox workspace-write --skip-git-repo-check -( |$)/);
  assert.ok(msg.includes(`cwd=${cwd}`));
  assert.ok(msg.includes(`prompt=${prompt}`)); // 셸 해석 없이 그대로 전달됨
  assert.equal(fs.readFileSync(path.join(cwd, 'made-by-codex.txt'), 'utf8'), prompt);
  assert.deepEqual((await adapter.collectArtifacts(h)).usage, { output_tokens: 3 });

  const fail = adapter.startTask({ taskId: 't2', prompt: 'FAIL', cwd, timeoutMs: 20_000 });
  const fr = await fail.done;
  assert.equal(fr.exitCode, 3);
  assert.ok(fr.error);

  const hang = adapter.startTask({ taskId: 't3', prompt: 'HANG', cwd, timeoutMs: 20_000 });
  setTimeout(() => adapter.cancelTask(hang), 300);
  const hr = await hang.done;
  assert.equal(hr.cancelled, true);
});
