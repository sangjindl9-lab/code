'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { api, useRealtime } from '@/lib/api';
import { fileSize, KIND_LABEL, Lamp, Notice, PROJECT_STATUS, providerState, Status, timeAgo } from '@/lib/ui';

export default function Dashboard() {
  const [d, setD] = useState<any>(null);
  const [notes, setNotes] = useState<any[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api('GET', '/api/dashboard').then(setD).catch((e) => setError(e.message));
    api('GET', '/api/notifications').then(setNotes).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  useRealtime(null, (m) => ['project', 'agents', 'notification', 'connected'].includes(m.type) && load());

  const unread = notes.filter((n) => !n.read_at);
  const online = d?.agents.filter((a: any) => a.status === 'online') ?? [];

  return (
    <Shell title="현황" action={<Link href="/new/" className="btn btn-primary btn-sm">새 프로그램 만들기</Link>}>
      {error && <Notice tone="stop">{error}</Notice>}
      {!d ? (
        <p className="text-mute">불러오는 중…</p>
      ) : (
        <div className="space-y-7">
          {/* 가장 먼저 볼 것: 내 PC 와 AI 가 지금 일할 수 있는 상태인가 */}
          <section aria-label="PC와 AI 상태" className="panel divide-y divide-line">
            {d.agents.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                <p>
                  <strong>연결된 PC가 없습니다.</strong> <span className="text-mute">프로그램을 만들려면 개발 엔진을 설치한 PC를 연결하세요.</span>
                </p>
                <Link href="/agents/" className="btn btn-sm">PC 연결하기</Link>
              </div>
            ) : (
              d.agents.map((a: any) => (
                <div key={a.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
                  <div className="flex min-w-40 items-center gap-2.5">
                    <Lamp tone={a.status === 'online' ? (a.paused ? 'wait' : 'go') : 'idle'} size={12} />
                    <div>
                      <p className="font-bold leading-tight">{a.name}</p>
                      <p className="text-sm text-mute">{a.status === 'online' ? (a.paused ? '일시정지' : '연결됨') : `꺼짐 (${timeAgo(a.last_seen_at)})`}</p>
                    </div>
                  </div>
                  {a.providers.map((p: any) => {
                    const s = providerState(p);
                    return (
                      <p key={p.key} className="text-sm">
                        <span className="font-semibold">{p.display_name}</span> <Status tone={s.tone}>{s.text}</Status>
                      </p>
                    );
                  })}
                </div>
              ))
            )}
          </section>

          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-5">
            {[
              ['전체', d.counts.total],
              ['진행 중', d.counts.active],
              ['확인 대기', d.counts.review],
              ['완료', d.counts.completed],
              ['실패', d.counts.failed],
            ].map(([k, v], i) => (
              <div key={k} className={`bg-panel px-4 py-3 ${i === 0 ? 'col-span-2 sm:col-span-1' : ''}`}>
                <dt className="text-sm text-mute">{k}</dt>
                <dd className="text-2xl font-bold">{v}</dd>
              </div>
            ))}
          </dl>

          {d.pendingApprovals.length > 0 && (
            <section>
              <h2 className="mb-2 text-lg font-bold">내 승인을 기다리는 일</h2>
              <ul className="panel divide-y divide-line">
                {d.pendingApprovals.map((a: any) => (
                  <li key={a.id}>
                    <Link href={`/project/?id=${a.project_id}`} className="flex items-center justify-between gap-3 p-4 hover:bg-sheet">
                      <span>
                        <span className="font-semibold">{a.title}</span>
                        <span className="block text-sm text-mute">{a.project_name}</span>
                      </span>
                      <Status tone="wait">확인하기</Status>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2 className="mb-2 text-lg font-bold">지금 실행 중인 작업</h2>
            {d.runningTasks.length === 0 ? (
              <p className="panel p-4 text-mute">{online.length ? '실행 중인 작업이 없습니다.' : 'PC가 연결되면 대기 중인 작업을 시작합니다.'}</p>
            ) : (
              <ul className="panel divide-y divide-line">
                {d.runningTasks.map((t: any) => (
                  <li key={t.id}>
                    <Link href={`/project/?id=${t.project_id}`} className="flex items-center gap-3 p-4 hover:bg-sheet">
                      <Lamp tone="live" size={12} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{t.title}</span>
                        <span className="block text-sm text-mute">
                          {t.project_name} / {t.kind === 'ai' ? t.provider_key : t.kind === 'verify' ? '자동 테스트' : '패키징'} / {timeAgo(t.started_at)} 시작
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="grid gap-7 lg:grid-cols-2">
            <section>
              <h2 className="mb-2 text-lg font-bold">최근 프로젝트</h2>
              {d.recentProjects.length === 0 ? (
                <p className="panel p-4 text-mute">
                  아직 프로젝트가 없습니다. <Link href="/new/" className="font-semibold text-cobalt underline">첫 프로그램을 만들어 보세요.</Link>
                </p>
              ) : (
                <ul className="panel divide-y divide-line">
                  {d.recentProjects.map((p: any) => (
                    <li key={p.id}>
                      <Link href={`/project/?id=${p.id}`} className="flex items-center justify-between gap-3 p-4 hover:bg-sheet">
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{p.name}</span>
                          <span className="text-sm text-mute">{KIND_LABEL[p.kind]} / {timeAgo(p.updated_at)}</span>
                        </span>
                        <Status tone={PROJECT_STATUS[p.status].tone}>{PROJECT_STATUS[p.status].label}</Status>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h2 className="mb-2 text-lg font-bold">최근 결과물</h2>
              {d.recentArtifacts.length === 0 ? (
                <p className="panel p-4 text-mute">테스트를 통과한 프로젝트의 결과물이 여기에 표시됩니다.</p>
              ) : (
                <ul className="panel divide-y divide-line">
                  {d.recentArtifacts.map((a: any) => (
                    <li key={a.id}>
                      <Link href={`/project/?id=${a.project_id}`} className="block p-4 hover:bg-sheet">
                        <span className="block truncate font-semibold">{a.filename}</span>
                        <span className="text-sm text-mute">{a.project_name} / {fileSize(a.size)} / {timeAgo(a.created_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {unread.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-lg font-bold">새 알림</h2>
                <button className="btn btn-sm" onClick={() => api('POST', '/api/notifications/read').then(load)}>모두 읽음</button>
              </div>
              <ul className="panel divide-y divide-line">
                {unread.slice(0, 8).map((n) => (
                  <li key={n.id}>
                    <Link href={n.project_id ? `/project/?id=${n.project_id}` : '/'} className="block p-4 hover:bg-sheet">
                      <span className="font-semibold">{n.title}</span>
                      <span className="block text-sm text-mute">{n.body} ({timeAgo(n.created_at)})</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Shell>
  );
}
