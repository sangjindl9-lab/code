#!/usr/bin/env node
import * as os from 'os';
import { ServerApi } from './api';
import { ENGINE_VERSION, engineHome, loadConfig, saveConfig, validateServerUrl } from './config';
import { buildAdapters, Engine, probeProviders } from './engine';
import { run, safeEnv } from './proc';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function toolVersion(cmd: string): Promise<string> {
  const r = await run(cmd, [], { cwd: process.cwd(), env: safeEnv(), shell: true, timeoutMs: 15_000 });
  return r.exitCode === 0 ? r.stdout.trim().split('\n')[0] : '없음';
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'pair') {
    const server = arg('server');
    const code = arg('code');
    if (!server || !code) throw new Error('사용법: eum-engine pair --server https://서버주소 --code XXXX-XXXX [--name PC이름]');
    const url = validateServerUrl(server);
    const name = arg('name') || os.hostname();
    const r = await new ServerApi(url).post('/api/agent/pair', { code, name, platform: `${os.platform()} ${os.release()}`, engineVersion: ENGINE_VERSION });
    saveConfig({ serverUrl: url, agentId: r.agentId, agentToken: r.token, agentTokenEnc: undefined, name });
    console.log(`등록 완료: "${r.organizationName}" 에 PC "${name}" 이(가) 연결되었습니다.`);
    console.log('이제 `eum-engine start` 로 엔진을 실행하세요.');
  } else if (cmd === 'start') {
    const engine = new Engine(loadConfig(), undefined, (s) => process.send?.({ type: 'status', status: s }));
    await engine.start();
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await engine.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('message', (m: any) => m?.type === 'stop' && shutdown());
    process.on('disconnect', shutdown);
  } else if (cmd === 'doctor') {
    const cfg = loadConfig();
    console.log(`EUM Desktop Engine ${ENGINE_VERSION}`);
    console.log(`설정 폴더: ${engineHome()}`);
    console.log(`서버: ${cfg.serverUrl || '(미등록)'}`);
    console.log(`작업 폴더: ${cfg.workspaceRoot}`);
    console.log(`Node.js: ${process.version}`);
    console.log(`Git: ${await toolVersion('git --version')}`);
    console.log(`npm: ${await toolVersion('npm --version')}`);
    console.log(`Docker: ${await toolVersion('docker --version')}`);
    for (const p of await probeProviders(buildAdapters(cfg))) {
      const state = !p.installed ? '미설치' : !p.authenticated ? '설치됨 · 로그인 필요' : p.executionPolicy.allowed ? '사용 가능' : `사용 불가 — ${p.executionPolicy.reason}`;
      console.log(`AI 도구 ${p.displayName}: ${state}${p.version ? ` (${p.version})` : ''}`);
    }
  } else if (cmd === 'config') {
    const key = process.argv[3];
    const value = process.argv[4];
    const allowed = ['workspaceRoot', 'maxConcurrency', 'cpuLimitPercent', 'minFreeMemMb', 'allowMeteredApi', 'enableMock', 'name'];
    if (!key) {
      const { agentToken, agentTokenEnc, ...rest } = loadConfig();
      console.log(JSON.stringify({ ...rest, agentToken: agentToken || agentTokenEnc ? '(저장됨)' : '(없음)' }, null, 2));
    } else if (!allowed.includes(key) || value === undefined) {
      throw new Error(`사용법: eum-engine config <${allowed.join('|')}> <값>`);
    } else {
      const parsed = ['maxConcurrency', 'cpuLimitPercent', 'minFreeMemMb'].includes(key) ? Number(value) : ['allowMeteredApi', 'enableMock'].includes(key) ? value === 'true' : value;
      saveConfig({ [key]: parsed } as any);
      console.log(`저장했습니다: ${key} = ${parsed}`);
    }
  } else {
    console.log(`EUM Desktop Engine ${ENGINE_VERSION}

사용법:
  eum-engine pair --server <서버주소> --code <연결코드>   PC 를 서버에 등록
  eum-engine start                                       엔진 실행 (작업 수신)
  eum-engine doctor                                      설치된 개발 도구·AI 도구 점검
  eum-engine config [키 값]                              설정 보기/변경`);
  }
}

main().catch((e) => {
  console.error(`오류: ${e.message}`);
  process.exit(1);
});
