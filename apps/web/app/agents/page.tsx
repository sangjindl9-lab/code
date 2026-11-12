'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { api, useRealtime } from '@/lib/api';
import { Lamp, Notice, providerState, Status, timeAgo } from '@/lib/ui';

export default function AgentsPage() {
  const [agents, setAgents] = useState<any[] | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const [origin, setOrigin] = useState('');
  const load = useCallback(() => {
    api('GET', '/api/agents').then(setAgents).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    setOrigin(location.origin);
  }, [load]);
  useRealtime(null, (m) => {
    if (m.type === 'agents' || m.type === 'connected') {
      load();
      if (m.type === 'agents') setCode(null);
    }
  });

  const run = (fn: () => Promise<unknown>) => fn().then(load).catch((e) => setError(e.message));
  const cmd = code ? `eum-engine pair --server ${origin} --code ${code.code}` : '';

  return (
    <Shell title="PC 연결">
      <div className="max-w-3xl space-y-6">
        {error && <Notice tone="stop">{error}</Notice>}

        <section>
          <h2 className="mb-2 text-lg font-bold">연결된 PC</h2>
          {!agents ? (
            <p className="text-mute">불러오는 중…</p>
          ) : agents.length === 0 ? (
            <p className="panel p-4 text-mute">아직 연결된 PC가 없습니다. 아래 순서대로 개발 엔진을 설치하고 연결하세요.</p>
          ) : (
            <ul className="space-y-3">
              {agents.map((a) => (
                <li key={a.id} className="panel p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <Lamp tone={a.status === 'online' ? (a.paused ? 'wait' : 'go') : 'idle'} size={12} />
                      <div>
                        <p className="text-[1.05rem] font-bold leading-tight">{a.name}</p>
                        <p className="text-sm text-mute">
                          {a.status === 'online' ? (a.paused ? '연결됨 / 일시정지' : '연결됨') : `꺼짐 / 마지막 접속 ${timeAgo(a.last_seen_at)}`}
                          {a.platform ? ` / ${a.platform}` : ''}
                          {a.engine_version ? ` / 엔진 ${a.engine_version}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button className="btn btn-sm" onClick={() => run(() => api('POST', `/api/agents/${a.id}/pause`, { paused: !a.paused }))}>
                        {a.paused ? '작업 다시 받기' : '일시정지'}
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => confirm(`"${a.name}" 연결을 해제할까요? 이 PC는 더 이상 작업을 받지 못합니다.`) && run(() => api('DELETE', `/api/agents/${a.id}`))}>
                        연결 해제
                      </button>
                    </div>
                  </div>
                  {a.system_info?.cpus && (
                    <p className="mt-2 text-sm text-mute">
                      CPU {a.system_info.cpus}코어 (사용률 {a.system_info.cpuPercent ?? 0}%) / 메모리 {Math.round((a.system_info.freeMemMb ?? 0) / 1024)}GB 여유 / 동시 작업 {a.max_concurrency}개
                    </p>
                  )}
                  <ul className="mt-3 divide-y divide-line border-t border-line">
                    {a.providers.map((p: any) => {
                      const s = providerState(p);
                      return (
                        <li key={p.key} className="py-2.5">
                          <p className="flex flex-wrap items-center gap-x-3">
                            <span className="font-semibold">{p.display_name}</span>
                            <Status tone={s.tone}>{s.text}</Status>
                            {p.version && <span className="text-sm text-mute">{p.version}</span>}
                            {p.execution_policy?.billing === 'subscription' && <span className="text-sm text-mute">구독 계정</span>}
                          </p>
                          {p.execution_policy?.reason && <p className="mt-0.5 text-sm text-mute">{p.execution_policy.reason}</p>}
                        </li>
                      );
                    })}
                    {a.providers.length === 0 && <li className="py-2.5 text-sm text-mute">엔진이 AI 도구 상태를 아직 보내지 않았습니다.</li>}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-lg font-bold">새 PC 연결하기</h2>
          <ol className="panel divide-y divide-line">
            <li className="p-4">
              <p className="font-semibold">1. PC에 개발 엔진을 설치합니다</p>
              <p className="mt-1 text-[0.95rem] text-mute">Node.js 20 이상과 Git이 필요합니다. 저장소를 내려받은 폴더에서 <code className="font-mono">scripts\install-engine.ps1</code> 을 실행하세요.</p>
            </li>
            <li className="p-4">
              <p className="font-semibold">2. PC에서 AI 도구에 로그인합니다</p>
              <p className="mt-1 text-[0.95rem] text-mute">쓰려는 도구만 설치하고 본인의 구독 계정으로 로그인합니다. 로그인 정보는 PC에만 남고 서버로 전송되지 않습니다.</p>
              <ul className="mt-2 space-y-1 text-[0.95rem] text-mute">
                <li>Claude: <code className="font-mono">npm install -g @anthropic-ai/claude-code</code> 후 <code className="font-mono">claude</code> 실행 → 구독 계정 선택</li>
                <li>GPT: <code className="font-mono">npm install -g @openai/codex</code> 후 <code className="font-mono">codex login</code></li>
                <li>Gemini: antigravity.google/download 에서 Antigravity CLI 설치 후 <code className="font-mono">agy</code> 실행</li>
              </ul>
            </li>
            <li className="p-4">
              <p className="font-semibold">3. 연결 코드를 발급해 PC에 입력합니다</p>
              {code ? (
                <div className="mt-2 space-y-2">
                  <p className="font-mono text-3xl font-bold tracking-widest">{code.code}</p>
                  <p className="text-sm text-mute">10분 안에 한 번만 쓸 수 있습니다. PC의 명령 창에 아래 명령을 붙여 넣으세요.</p>
                  <pre className="overflow-x-auto rounded-lg bg-console p-3 font-mono text-sm text-white">{cmd}</pre>
                  <div className="flex gap-2">
                    <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(cmd)}>명령 복사</button>
                    <button className="btn btn-sm" onClick={() => setCode(null)}>닫기</button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-primary btn-sm mt-2" onClick={() => api('POST', '/api/agents/pairing-code').then(setCode).catch((e) => setError(e.message))}>연결 코드 발급</button>
              )}
            </li>
            <li className="p-4">
              <p className="font-semibold">4. 엔진을 실행합니다</p>
              <p className="mt-1 text-[0.95rem] text-mute">저장소 폴더에서 <code className="font-mono">powershell -ExecutionPolicy Bypass -File scripts\engine-background.ps1 install</code> 을 실행하면 창 없이 백그라운드로 돌고 PC 로그인 때 자동 시작됩니다. (창에서 직접 보려면 <code className="font-mono">eum-engine start</code>) 위 목록에 PC가 "연결됨"으로 표시되면 끝입니다. PC는 서버로 나가는 연결만 사용하므로 공유기 설정을 바꿀 필요가 없습니다.</p>
            </li>
          </ol>
        </section>
      </div>
    </Shell>
  );
}
