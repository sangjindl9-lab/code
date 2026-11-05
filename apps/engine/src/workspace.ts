import * as fs from 'fs';
import * as path from 'path';
import { run, safeEnv } from './proc';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** target 이 root 안에 있는지 확인합니다. 밖이면 예외를 던집니다. (심볼릭 링크도 실제 경로로 확인) */
export function assertInside(root: string, target: string): string {
  const r = fs.realpathSync(path.resolve(root));
  let t = path.resolve(target);
  // 아직 없는 경로는 존재하는 가장 가까운 상위 폴더 기준으로 실제 경로를 계산
  let existing = t;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    rest.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  t = path.join(fs.realpathSync(existing), ...rest);
  if (t !== r && !t.startsWith(r + path.sep)) {
    throw new Error(`허용된 작업 폴더 밖의 경로입니다: ${target}`);
  }
  return t;
}

export function projectDir(workspaceRoot: string, projectId: string): string {
  if (!UUID.test(projectId)) throw new Error('프로젝트 ID 형식이 올바르지 않습니다.');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return assertInside(workspaceRoot, path.join(workspaceRoot, projectId));
}

const GIT_ID = ['-c', 'user.name=EUM Engine', '-c', 'user.email=engine@eum.local', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

export async function git(dir: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const r = await run('git', [...GIT_ID, ...args], { cwd: dir, env: safeEnv({ GIT_TERMINAL_PROMPT: '0' }), timeoutMs });
  if (r.spawnError) throw new Error(`git 을 실행할 수 없습니다: ${r.spawnError}`);
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} 실패 (${r.exitCode}): ${r.tail.slice(-500)}`);
  return r.stdout.trim();
}

const DEFAULT_GITIGNORE = `node_modules/
dist/
build/
.next/
out/
coverage/
.env
.env.local
*.log
__pycache__/
.venv/
.gradle/
`;

/** 프로젝트 작업 폴더와 Git 저장소를 준비합니다. */
export async function ensureRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    await git(dir, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(dir, '.gitignore'), DEFAULT_GITIGNORE);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', '[EUM] 프로젝트 작업 폴더 생성']);
  }
}

export const head = (dir: string) => git(dir, ['rev-parse', 'HEAD']);

/** 중단된 시도가 남긴 커밋되지 않은 변경을 버리고 마지막 체크포인트로 되돌립니다. (.gitignore 대상은 유지) */
export async function resetToCheckpoint(dir: string): Promise<void> {
  await git(dir, ['reset', '--hard', 'HEAD']);
  await git(dir, ['clean', '-fd']);
}

/** 변경사항을 모두 커밋하고 HEAD 를 반환합니다. 변경이 없으면 커밋하지 않습니다. */
export async function checkpoint(dir: string, message: string): Promise<string> {
  await git(dir, ['add', '-A']);
  const status = await git(dir, ['status', '--porcelain']);
  if (status) await git(dir, ['commit', '-m', message.slice(0, 200)]);
  return head(dir);
}

export async function changedFiles(dir: string, before: string, after: string): Promise<string[]> {
  if (before === after) return [];
  const out = await git(dir, ['-c', 'core.quotepath=false', 'diff', '--name-only', before, after]);
  return out ? out.split('\n').filter(Boolean) : [];
}
