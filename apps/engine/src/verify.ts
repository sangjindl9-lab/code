import * as fs from 'fs';
import * as path from 'path';
import { run, safeEnv } from './proc';

export interface CheckResult {
  category: 'install' | 'typecheck' | 'lint' | 'test' | 'build' | 'security';
  name: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  logTail: string;
}

interface PlannedCheck {
  category: CheckResult['category'];
  name: string;
  /** 엔진이 정한 고정 명령. AI 가 만든 문자열을 명령으로 쓰지 않습니다. */
  command: string;
  dir: string;
  timeoutMs: number;
}

const SCRIPT_ORDER: Array<[string, CheckResult['category'], string]> = [
  ['typecheck', 'typecheck', '타입 검사'],
  ['lint', 'lint', '린트'],
  ['test', 'test', '자동 테스트'],
  ['build', 'build', '빌드'],
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.venv', '__pycache__']);

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** package.json 이 있는 폴더를 찾습니다(루트 + 2단계 하위). 루트가 npm workspaces 면 루트만 사용합니다. */
export function findNodeDirs(root: string): string[] {
  const rootPkg = readJson(path.join(root, 'package.json'));
  if (rootPkg?.workspaces) return [root];
  const found: string[] = rootPkg ? [root] : [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const sub = path.join(dir, e.name);
      if (fs.existsSync(path.join(sub, 'package.json'))) found.push(sub);
      walk(sub, depth + 1);
    }
  };
  walk(root, 1);
  return found.slice(0, 12);
}

export function planChecks(root: string): PlannedCheck[] {
  const checks: PlannedCheck[] = [];
  for (const dir of findNodeDirs(root)) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg) continue;
    const label = path.relative(root, dir) || '.';
    const suffix = label === '.' ? '' : ` (${label})`;
    const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0 || !!pkg.workspaces;
    const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
    if (hasDeps)
      checks.push({
        category: 'install',
        name: `의존성 설치${suffix}`,
        command: hasLock ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund',
        dir,
        timeoutMs: 20 * 60_000,
      });
    const scripts: Record<string, string> = pkg.scripts || {};
    for (const [script, category, title] of SCRIPT_ORDER) {
      const body = scripts[script];
      if (!body || /no test specified/i.test(body)) continue;
      checks.push({
        category,
        name: `${title}${suffix}`,
        command: script === 'test' ? 'npm test' : `npm run ${script}`,
        dir,
        timeoutMs: 20 * 60_000,
      });
    }
    if (hasDeps)
      checks.push({ category: 'security', name: `의존성 취약점 검사${suffix}`, command: 'npm audit --audit-level=critical --omit=dev', dir, timeoutMs: 3 * 60_000 });
  }
  const py = ['pyproject.toml', 'requirements.txt', 'pytest.ini'].some((f) => fs.existsSync(path.join(root, f)));
  if (py && (fs.existsSync(path.join(root, 'tests')) || fs.existsSync(path.join(root, 'test')))) {
    checks.push({ category: 'test', name: '자동 테스트 (pytest)', command: `${process.platform === 'win32' ? 'python' : 'python3'} -m pytest -q`, dir: root, timeoutMs: 20 * 60_000 });
  }
  return checks;
}

const AUDIT_UNAVAILABLE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOAUDIT|ENOLOCK|audit endpoint returned an error|request to .* failed/i;

/** 실제 명령을 실행해 프로젝트를 검증합니다. 앞 단계(설치)가 실패하면 같은 폴더의 나머지는 건너뜁니다. */
export async function runChecks(
  root: string,
  opts: { signal?: AbortSignal; onLog?: (type: string, message: string) => void },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const broken = new Set<string>();
  for (const c of planChecks(root)) {
    if (opts.signal?.aborted) break;
    const cwd = path.relative(root, c.dir) || '.';
    if (broken.has(c.dir)) {
      results.push({ category: c.category, name: c.name, command: c.command, cwd, exitCode: null, status: 'skipped', durationMs: 0, logTail: '앞 단계(의존성 설치) 실패로 건너뜀' });
      continue;
    }
    opts.onLog?.('command', `$ ${c.command}   [${cwd}]`);
    const r = await run(c.command, [], {
      cwd: c.dir,
      env: safeEnv(),
      shell: true,
      timeoutMs: c.timeoutMs,
      signal: opts.signal,
      onLine: (_s, line) => opts.onLog?.('log', line),
    });
    if (r.aborted) break;
    let status: CheckResult['status'] = r.exitCode === 0 ? 'passed' : 'failed';
    let logTail = r.tail;
    if (r.timedOut) logTail += '\n[제한 시간 초과로 중단됨]';
    if (r.spawnError) logTail += `\n[실행 오류] ${r.spawnError}`;
    if (c.category === 'security' && status === 'failed' && AUDIT_UNAVAILABLE.test(r.tail)) {
      status = 'skipped';
      logTail += '\n[취약점 데이터베이스에 연결할 수 없어 검사를 건너뜀]';
    }
    if (c.category === 'install' && status === 'failed') broken.add(c.dir);
    results.push({ category: c.category, name: c.name, command: c.command, cwd, exitCode: r.exitCode, status, durationMs: r.durationMs, logTail: logTail.slice(-20_000) });
    opts.onLog?.(status === 'failed' ? 'error' : 'log', `→ ${c.name}: ${status === 'passed' ? '통과' : status === 'failed' ? `실패 (종료 코드 ${r.exitCode})` : '건너뜀'}`);
  }
  return results;
}
