import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AntigravityAdapter, parseAntigravityLine } from '../src/adapters/antigravity';
import { ClaudeCodeAdapter, parseClaudeLine } from '../src/adapters/claude';
import { AdapterEvent } from '../src/adapters/types';
import { buildAdapters } from '../src/engine';
import { aiEnv, cliInvocation } from '../src/proc';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eum-adapter-test-')));
const posixOnly = { skip: process.platform === 'win32' };

/** 실제 CLI 와 같은 명령 규칙을 흉내 내는 대역 실행 파일 */
function fake(body: string): string {
  const file = path.join(tmp(), 'fake-cli.js');
  fs.writeFileSync(file, `#!${process.execPath}\nconst a = process.argv.slice(2);\nconst out = (o) => console.log(JSON.stringify(o));\n${body}\n`, { mode: 0o755 });
  return file;
}

test('종량제 차단: API 키 환경변수는 AI 도구에 전달하지 않는다', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
  process.env.OPENAI_API_KEY = 'sk-x';
  process.env.GEMINI_API_KEY = 'g-x';
  const env = aiEnv(false);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(aiEnv(true).ANTHROPIC_API_KEY, 'sk-ant-x'); // 사용자가 명시적으로 허용한 경우에만 전달
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

test('어댑터 등록: Codex·Claude Code·Antigravity 가 기본 등록되고 모의 AI 는 설정을 켠 경우에만 등록된다', () => {
  const base = { name: 'pc', workspaceRoot: '/tmp/x', maxConcurrency: 1, cpuLimitPercent: 90, minFreeMemMb: 0, allowMeteredApi: false };
  assert.deepEqual([...buildAdapters({ ...base, enableMock: false }).keys()], ['codex', 'claude', 'antigravity']);
  assert.ok(buildAdapters({ ...base, enableMock: true }).has('mock'));
});

test('Windows 실행 규칙: .cmd 는 셸을 거치되 특수문자 인자를 따옴표로 감싼다', { skip: process.platform !== 'win32' }, () => {
  const inv = cliInvocation('claude', ['-p', '--allowedTools', 'Bash(npm:*)']);
  assert.equal(inv.shell, true);
  assert.deepEqual(inv.args, ['-p', '--allowedTools', '"Bash(npm:*)"']);
  assert.equal(cliInvocation('agy', ['-p', 'a b'], true).shell, false);
});

// 아래 줄들은 실제 Claude Code 2.1.318 의 `-p --output-format stream-json --verbose` 출력에서 가져와 줄인 것입니다.
const CLAUDE_REAL = [
  '{"type":"system","subtype":"init","cwd":"/w","session_id":"s1","model":"claude-sonnet-5-5","permissionMode":"acceptEdits","apiKeySource":"none"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\": \\"/tmp"}},"session_id":"s1"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/w/proj/src/hello.txt","content":"hi\\n"}}]},"session_id":"s1"}',
  '{"type":"user","message":{"content":[{"tool_use_id":"t1","type":"tool_result","content":"File created successfully"}]},"session_id":"s1"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"node -e \\"console.log(1+1)\\"","description":"Run node"}}]},"session_id":"s1"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793896800,"rateLimitType":"five_hour","overageStatus":"rejected"},"session_id":"s1"}',
  '{"type":"user","message":{"content":[{"tool_use_id":"t2","type":"tool_result","content":"2","is_error":false}]},"session_id":"s1"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"결과: `2`"}]},"session_id":"s1"}',
  '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"duration_ms":6148,"result":"결과: `2`","usage":{"input_tokens":4,"output_tokens":220},"permission_denials":[],"total_cost_usd":0.0695}',
];

test('Claude Code 이벤트 변환: 실제 출력 형식을 로그 이벤트로 바꾼다', () => {
  const art: any = {};
  const events = CLAUDE_REAL.flatMap((l) => parseClaudeLine(l, art) || []);
  assert.deepEqual(
    events.map((e) => `${e.type}|${e.message}`),
    [
      'log|Claude Code 세션 시작 (모델 claude-sonnet-5-5, 권한 모드 acceptEdits)',
      'file|write: proj/src/hello.txt',
      '$|'.slice(0, 0) + 'command|$ node -e "console.log(1+1)"',
      'message|결과: `2`',
      'usage|작업 완료 (3턴)',
    ],
  );
  assert.equal(art.lastMessage, '결과: `2`');
  assert.equal(art.failed, undefined);
  assert.equal(art.rateLimit.status, 'allowed');
  assert.equal(art.rateLimit.limitType, 'five_hour');
  // 실패 결과와 사용 한도 초과
  const bad: any = {};
  assert.equal(parseClaudeLine('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"한도 초과"}', bad)![0].type, 'error');
  assert.equal(bad.failed, true);
  assert.equal(parseClaudeLine('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour"}}', {})![0].type, 'error');
  assert.equal(parseClaudeLine('{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"permission denied"}]}}', {})![0].type, 'error');
});

const claudeFake = (status: object, exitBody = '') =>
  fake(`
if (a[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (a[0] === 'auth') { console.log(JSON.stringify(${JSON.stringify(status)}, null, 2)); process.exit(0); }
let input = ''; process.stdin.on('data', (d) => (input += d)).on('end', () => {
  out({ type: 'system', subtype: 'init', model: 'm', permissionMode: 'acceptEdits' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ args: a, cwd: process.cwd(), prompt: input, key: process.env.ANTHROPIC_API_KEY || null }) }] } });
  ${exitBody || "require('fs').writeFileSync('made-by-claude.txt', 'x'); out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, usage: { output_tokens: 1 } });"}
});`);

test('Claude Code 어댑터: 구독 로그인만 자동 실행하고, API 키·클라우드 과금 로그인은 차단한다', posixOnly, async () => {
  const sub = new ClaudeCodeAdapter({ binary: claudeFake({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }) });
  assert.deepEqual(await sub.detectInstallation(), { installed: true, version: '9.9.9 (Claude Code)' });
  assert.deepEqual(await sub.checkAuthentication(), { authenticated: true, method: 'claude.ai', detail: 'claude.ai / max' });
  assert.deepEqual(await sub.checkExecutionPolicy(), { allowed: true, mode: 'automatic', billing: 'subscription' });

  const key = await new ClaudeCodeAdapter({ binary: claudeFake({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }) }).checkExecutionPolicy();
  assert.equal(key.allowed, false);
  assert.equal(key.billing, 'metered');
  const cloud = await new ClaudeCodeAdapter({ binary: claudeFake({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }) }).checkExecutionPolicy();
  assert.equal(cloud.allowed, false);
  const off = await new ClaudeCodeAdapter({ binary: claudeFake({ loggedIn: false }) }).checkExecutionPolicy();
  assert.equal(off.allowed, false);
  assert.match(off.reason!, /로그인/);
  assert.deepEqual(await new ClaudeCodeAdapter({ binary: '/nonexistent/claude' }).detectInstallation(), { installed: false });
});

test('Claude Code 어댑터: 공식 비대화형 옵션으로 작업 폴더에서 실행하고 결과 실패를 감지한다', posixOnly, async () => {
  const adapter = new ClaudeCodeAdapter({ binary: claudeFake({ loggedIn: true, authMethod: 'claude.ai' }) });
  const cwd = tmp();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
  const events: AdapterEvent[] = [];
  const prompt = '계산기를 만들어줘 "$(rm -rf /)" `whoami`';
  const h = adapter.startTask({ taskId: 'c1', prompt, cwd, timeoutMs: 20_000 });
  adapter.streamEvents(h, (e) => events.push(e));
  const r = await h.done;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(r.exitCode, 0);
  const seen = JSON.parse(events.find((e) => e.type === 'message')!.message);
  assert.deepEqual(seen.args.slice(0, 6), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
  assert.ok(!seen.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(seen.args.slice(seen.args.indexOf('--allowedTools') + 1), ClaudeCodeAdapter.ALLOWED_TOOLS);
  assert.equal(seen.cwd, cwd);
  assert.equal(seen.prompt, prompt);
  assert.equal(seen.key, null);
  assert.ok(fs.existsSync(path.join(cwd, 'made-by-claude.txt')));

  // 프로세스는 0 으로 끝났지만 결과가 오류인 경우 → 실패로 보고
  const failing = new ClaudeCodeAdapter({ binary: claudeFake({ loggedIn: true }, "out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'usage limit reached' });") });
  const fr = await failing.startTask({ taskId: 'c2', prompt: 'x', cwd, timeoutMs: 20_000 }).done;
  assert.equal(fr.exitCode, 1);
  assert.equal(fr.error, 'usage limit reached');
});

test('Antigravity 이벤트 변환: 공식 문서의 stream-json 이벤트를 로그 이벤트로 바꾼다', () => {
  const art: any = {};
  assert.match(parseAntigravityLine('{"event":"init","payload":{"cwd":"/w","permission_mode":"accept-edits","model":"gemini-3"}}', art)!.message, /gemini-3/);
  assert.equal(parseAntigravityLine('{"event":"step_update","payload":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"안녕"}}', art), undefined);
  assert.equal(parseAntigravityLine('{"event":"step_update","payload":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"하세요"}}', art), undefined);
  assert.deepEqual(parseAntigravityLine('{"event":"step_update","payload":{"step_index":1,"state":"DONE","step_type":"agent_response"}}', art), { type: 'message', message: '안녕하세요' });
  assert.equal(parseAntigravityLine('{"event":"step_update","payload":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_file"}}', art)!.message, '도구 실행: write_file');
  assert.equal(parseAntigravityLine('{"event":"result","payload":{"status":"SUCCESS","response":"끝","num_turns":2,"usage":{"t":1}}}', art)!.type, 'usage');
  assert.equal(art.lastMessage, '끝');
  const bad: any = {};
  assert.equal(parseAntigravityLine('{"event":"result","payload":{"status":"ERROR","error":"authentication required"}}', bad)!.type, 'error');
  assert.equal(bad.failed, true);
});

test('Antigravity 어댑터: 파일 수정만 자동 승인하는 모드로 실행하고, 로그인 필요 오류를 기억한다', posixOnly, async () => {
  const bin = fake(`
if (a[0] === '--version') { console.log('agy 1.4.4'); process.exit(0); }
const i = a.indexOf('-p'); const prompt = a[i + 1];
if (prompt.includes('NOLOGIN')) { console.error('Error: authentication required'); process.exit(1); }
out({ event: 'init', payload: { permission_mode: 'accept-edits' } });
out({ event: 'step_update', payload: { step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: JSON.stringify({ args: a, cwd: process.cwd() }) } });
out({ event: 'result', payload: { status: 'SUCCESS', num_turns: 1 } });`);
  const adapter = new AntigravityAdapter({ binary: bin });
  assert.deepEqual(await adapter.detectInstallation(), { installed: true, version: 'agy 1.4.4' });
  assert.equal((await adapter.checkExecutionPolicy()).allowed, true);
  const cwd = tmp();
  const events: AdapterEvent[] = [];
  const prompt = '여러 줄\n지시문 "따옴표" $(whoami)';
  const h = adapter.startTask({ taskId: 'g1', prompt, cwd, timeoutMs: 20_000 });
  adapter.streamEvents(h, (e) => events.push(e));
  assert.equal((await h.done).exitCode, 0);
  const seen = JSON.parse(events.find((e) => e.type === 'message')!.message);
  assert.deepEqual(seen.args, ['-p', prompt, '--output-format', 'stream-json', '--mode', 'accept-edits']); // 셸 해석 없이 그대로 전달
  assert.ok(!seen.args.includes('--dangerously-skip-permissions'));
  assert.equal(seen.cwd, cwd);

  const r = await adapter.startTask({ taskId: 'g2', prompt: 'NOLOGIN', cwd, timeoutMs: 20_000 }).done;
  assert.equal(r.exitCode, 1);
  assert.match(r.error!, /로그인되어 있지 않습니다/);
  const policy = await adapter.checkExecutionPolicy(); // 이후에는 "로그인 필요"로 표시되어 작업을 받지 않음
  assert.equal(policy.allowed, false);
  assert.deepEqual(await new AntigravityAdapter({ binary: '/nonexistent/agy' }).detectInstallation(), { installed: false });
});
