import { spawn } from 'child_process';

export interface RunOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
  /** true 이면 셸을 거쳐 실행합니다. cmd 는 엔진이 정한 고정 문자열이어야 하며 AI·사용자 입력을 넣지 않습니다. */
  shell?: boolean;
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  /** stdout+stderr 의 마지막 부분 */
  tail: string;
  stdout: string;
  durationMs: number;
}

const MAX_LINE = 4000;
const MAX_TAIL = 40_000;
const MAX_STDOUT = 200_000;

/** 하위 프로세스에 넘길 환경변수. 엔진 자체의 비밀정보(EUM_*)는 전달하지 않습니다. */
export function safeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // NODE_TEST_CONTEXT 가 남아 있으면 하위 `node --test` 가 실패를 종료 코드로 알리지 않습니다.
  for (const [k, v] of Object.entries(process.env)) if (!/^EUM_/i.test(k) && k !== 'NODE_TEST_CONTEXT') env[k] = v;
  return { ...env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
}

/** 프로세스와 그 자식 프로세스를 모두 종료합니다. */
export function killTree(pid: number) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* 이미 종료됨 */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* 이미 종료됨 */
    }
  }, 3000).unref();
}

export function run(cmd: string, args: string[], opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let tail = '';
    let stdout = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    if (opts.signal?.aborted) {
      return resolve({ exitCode: null, timedOut: false, aborted: true, tail: '', stdout: '', durationMs: 0 });
    }
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? safeEnv(),
      shell: opts.shell ?? false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, timedOut, aborted, spawnError, tail, stdout, durationMs: Date.now() - started });
    };
    const onAbort = () => {
      aborted = true;
      if (child.pid) killTree(child.pid);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, opts.timeoutMs ?? 30 * 60_000);

    const pipe = (stream: 'stdout' | 'stderr') => {
      let buf = '';
      const emit = (line: string) => {
        const text = line.replace(/\r$/, '').slice(0, MAX_LINE);
        tail = (tail + text + '\n').slice(-MAX_TAIL);
        if (stream === 'stdout' && stdout.length < MAX_STDOUT) stdout += text + '\n';
        opts.onLine?.(stream, text);
      };
      child[stream]!.setEncoding('utf8');
      child[stream]!.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          emit(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        if (buf.length > MAX_LINE * 4) {
          emit(buf);
          buf = '';
        }
      });
      child[stream]!.on('end', () => buf && emit(buf));
    };
    pipe('stdout');
    pipe('stderr');

    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
    child.stdin!.on('error', () => undefined);
    if (opts.stdin !== undefined) child.stdin!.write(opts.stdin);
    child.stdin!.end();
  });
}

const METERED_KEYS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_API_KEY)$/i;

/**
 * AI 도구에 넘길 환경변수. 종량제 사용을 허용하지 않았다면 API 키 환경변수를 제거해,
 * 도구가 구독 로그인 대신 API 키(요금 발생)로 동작하는 일을 막습니다.
 */
export function aiEnv(allowMeteredApi: boolean): NodeJS.ProcessEnv {
  const env = safeEnv();
  if (!allowMeteredApi) for (const k of Object.keys(env)) if (METERED_KEYS.test(k)) delete env[k];
  return env;
}

/**
 * CLI 실행 방법을 정합니다. Windows 에서 npm 전역 설치본은 .cmd 파일이라 셸을 거쳐야 하므로,
 * 그 경우 공백·특수문자가 있는 인자를 큰따옴표로 감쌉니다. 인자는 모두 엔진이 정한 값이어야 합니다.
 */
export function cliInvocation(binary: string, args: string[], forceNoShell = false): { cmd: string; args: string[]; shell: boolean } {
  const needsShell = process.platform === 'win32' && !forceNoShell && !/\.exe$/i.test(binary);
  if (!needsShell) return { cmd: binary, args, shell: false };
  const quote = (a: string) => (/^[\w.\-:=\/\\]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
  return { cmd: quote(binary), args: args.map(quote), shell: true };
}
