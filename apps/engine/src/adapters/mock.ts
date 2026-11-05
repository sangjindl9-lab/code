import * as fs from 'fs';
import * as path from 'path';
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

/**
 * 테스트·시연 전용 모의 어댑터. 실제 AI 를 호출하지 않고 정해진 작은 Node.js 프로젝트를 만듭니다.
 * 엔진 설정에서 enableMock 을 켠 경우에만 등록되며, 상용 사용 시에는 꺼 두어야 합니다.
 *
 * 시나리오(EUM_MOCK_SCENARIO 는 테스트에서 엔진 설정으로 전달):
 *  - ok         : 정상 구현
 *  - fail-once  : 첫 구현에 버그를 넣어 검증 실패 → 수정 작업에서 고침
 *  - always-bad : 수정 작업도 버그를 고치지 못함 (재시도 한도 검증용)
 *  - no-change  : 완료했다고 응답하지만 파일을 만들지 않음
 */
export class MockAdapter implements ProviderAdapter {
  readonly key = 'mock';
  readonly displayName = '모의 AI (테스트 전용)';
  private sessions = new Map<string, TaskSession>();

  constructor(private readonly opts: { scenario?: string; delayMs?: number } = {}) {}

  async detectInstallation() {
    return { installed: true, version: 'mock-1.0' };
  }
  async checkAuthentication() {
    return { authenticated: true, method: 'none' };
  }
  getCapabilities(): Capabilities {
    return {
      planning: true,
      codeGeneration: true,
      codeReview: false,
      testGeneration: true,
      nonInteractive: true,
      streaming: true,
      cancel: true,
      sandbox: false,
      usageReporting: false,
    };
  }
  async checkExecutionPolicy(): Promise<ExecutionPolicy> {
    return { allowed: true, mode: 'automatic', billing: 'local' };
  }
  async getUsageStatus() {
    return { supported: false };
  }

  startTask(input: TaskInput): TaskHandle {
    const s = new TaskSession();
    this.sessions.set(input.taskId, s);
    const scenario = this.opts.scenario || 'ok';
    const write = (rel: string, content: string) => {
      const f = path.join(input.cwd, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
      s.emit({ type: 'file', message: `add: ${rel}` });
    };
    const done = (async () => {
      const delay = this.opts.delayMs ?? 50;
      for (let waited = 0; waited < delay; waited += 100) {
        if (s.abort.signal.aborted) return { exitCode: null, timedOut: false, cancelled: true };
        s.emit({ type: 'log', message: `작업 중... (${waited}ms)` });
        await new Promise((r) => setTimeout(r, Math.min(100, delay - waited)));
      }
      if (s.abort.signal.aborted) return { exitCode: null, timedOut: false, cancelled: true };
      const p = input.prompt;
      if (scenario === 'no-change') {
        s.emit({ type: 'message', message: '모든 작업을 완료했습니다.' });
      } else if (p.includes('기획 총괄')) {
        write('docs/PRD.md', '# PRD\n\n간단한 계산기 모듈\n');
        write('docs/REQUIREMENTS.md', '# 요구사항\n\n## 필수 기능\n- 더하기\n- 곱하기\n\n## 선택 기능\n- 없음\n');
        write('docs/ARCHITECTURE.md', '# 아키텍처\n\nNode.js, node:test\n');
        write('docs/ACCEPTANCE_CRITERIA.md', '# 인수 기준\n\n- add(2,3) = 5\n- mul(2,3) = 6\n');
        write(
          'docs/TASKS.json',
          JSON.stringify(
            {
              tasks: [
                { id: 'T1', title: '프로젝트 뼈대와 더하기', role: 'backend', description: 'package.json, add 함수', dependsOn: [], targetFiles: ['package.json', 'src/calc.js'], doneWhen: 'add 동작', testWhen: 'npm test 통과' },
                { id: 'T2', title: '곱하기 기능', role: 'backend', description: 'mul 함수', dependsOn: ['T1'], targetFiles: ['src/calc.js'], doneWhen: 'mul 동작', testWhen: 'npm test 통과' },
              ],
            },
            null,
            2,
          ),
        );
        s.emit({ type: 'message', message: '기획 문서 5종을 작성했습니다.' });
      } else if (p.includes('오류 수정 담당')) {
        if (scenario === 'always-bad') {
          write('NOTES.md', `수정 시도 ${Date.now()}\n`);
        } else {
          write('src/calc.js', calc(false, true));
        }
        s.emit({ type: 'message', message: '오류를 수정했습니다.' });
      } else if (p.includes('작업 ID: T2')) {
        const buggy = fs.readFileSync(path.join(input.cwd, 'src/calc.js'), 'utf8').includes('a - b');
        write('src/calc.js', calc(buggy, true));
        write('test/mul.test.js', `const test = require('node:test');\nconst assert = require('node:assert');\nconst { mul } = require('../src/calc');\ntest('곱하기', () => assert.strictEqual(mul(2, 3), 6));\n`);
        s.emit({ type: 'message', message: '곱하기 기능을 구현했습니다.' });
      } else {
        write('package.json', JSON.stringify({ name: 'mock-app', version: '1.0.0', private: true, scripts: { test: 'node --test', build: 'node scripts/build.js' } }, null, 2) + '\n');
        write('scripts/build.js', `const fs = require('fs');\nfs.mkdirSync('dist', { recursive: true });\nfs.copyFileSync('src/calc.js', 'dist/calc.js');\nconsole.log('빌드 완료');\n`);
        write('src/calc.js', calc(scenario === 'fail-once' || scenario === 'always-bad', false));
        write('test/add.test.js', `const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/calc');\ntest('더하기', () => assert.strictEqual(add(2, 3), 5));\n`);
        write('README.md', '# mock-app\n\n설치: `npm install` / 테스트: `npm test`\n');
        s.emit({ type: 'message', message: '프로젝트 뼈대와 더하기 기능을 구현했습니다.' });
      }
      return { exitCode: 0, timedOut: false, cancelled: false };
    })();
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

function calc(buggy: boolean, withMul: boolean): string {
  return `function add(a, b) {\n  return ${buggy ? 'a - b' : 'a + b'};\n}\n${withMul ? 'function mul(a, b) {\n  return a * b;\n}\n' : ''}module.exports = { add${withMul ? ', mul' : ''} };\n`;
}
