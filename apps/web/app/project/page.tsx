'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Shell from '@/components/Shell';
import { api, downloadUrl, useRealtime } from '@/lib/api';
import { dateTime, duration, fileSize, KIND_LABEL, Lamp, MODE_LABEL, Notice, PROJECT_STATUS, ROLE_LABEL, Status, TASK_STATUS, timeAgo, type Tone } from '@/lib/ui';

interface Ev {
  id: number;
  taskId: string;
  attemptNo: number;
  seq: number;
  type: string;
  message: string;
  createdAt: string;
}

const EV_STYLE: Record<string, string> = {
  error: 'text-[#ff9a8f]',
  command: 'text-[#8fc1ff]',
  file: 'text-[#8fe0b8]',
  message: 'text-white',
  system: 'text-[#f3d27a]',
  usage: 'text-[#9aa7c2]',
  reasoning: 'text-[#9aa7c2] italic',
};

function taskTone(t: any): { label: string; tone: Tone } {
  if (t.status === 'failed' && t.superseded_by) return { label: '실패 → 자동 수정함', tone: 'idle' };
  if (t.status === 'queued' && t.result?.rateLimited)
    return { label: `AI 사용량 한도 — ${t.result.resumeAt ? new Date(t.result.resumeAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '잠시'} 후 자동 재개`, tone: 'wait' };
  if (t.status === 'queued' && t.result?.retrying) return { label: '다시 시도 대기', tone: 'wait' };
  return TASK_STATUS[t.status];
}

function ProjectView() {
  const id = useSearchParams().get('id');
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [events, setEvents] = useState<Ev[]>([]);
  const [busy, setBusy] = useState('');
  const consoleRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const load = useCallback(() => {
    if (!id) return;
    api('GET', `/api/projects/${id}`).then(setD).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  // 보고 있는 작업: 사용자가 고르지 않았으면 실행 중인 작업(없으면 마지막으로 진행된 작업)을 따라갑니다.
  const currentId = useMemo(() => {
    if (!d) return null;
    if (!follow && selected) return selected;
    const running = d.tasks.find((t: any) => t.status === 'running');
    const last = [...d.tasks].reverse().find((t: any) => t.started_at);
    return (running || last || d.tasks[0])?.id ?? null;
  }, [d, follow, selected]);
  const current = d?.tasks.find((t: any) => t.id === currentId);

  useEffect(() => {
    if (!id || !currentId) return;
    let stale = false;
    setEvents([]);
    stick.current = true;
    api('GET', `/api/projects/${id}/events?taskId=${currentId}&tail=600`).then((list: Ev[]) => !stale && setEvents(list)).catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [id, currentId]);

  useRealtime(id, (m) => {
    if (m.type === 'project' || m.type === 'connected' || m.type === 'agents') load();
    if (m.type === 'event' && m.event.taskId === currentId)
      setEvents((prev) => (prev.some((e) => e.id === m.event.id) ? prev : [...prev, m.event].sort((a, b) => a.id - b.id).slice(-1500)));
  });

  useEffect(() => {
    const el = consoleRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError('');
    try {
      await fn();
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  async function download(artifactId: string) {
    await act(`dl-${artifactId}`, async () => {
      const { url } = await api('POST', `/api/artifacts/${artifactId}/link`);
      location.href = downloadUrl(url);
    });
  }

  if (!id) return <Notice tone="stop">프로젝트를 찾을 수 없습니다. <Link href="/projects/" className="underline">목록으로 돌아가기</Link></Notice>;
  if (!d) return error ? <Notice tone="stop">{error}</Notice> : <p className="text-mute">불러오는 중…</p>;

  const p = d.project;
  const st = PROJECT_STATUS[p.status];
  const pending = d.approvals.filter((a: any) => a.status === 'pending');
  const visibleTasks = d.tasks;
  const done = d.tasks.filter((t: any) => t.status === 'succeeded').length;
  const total = d.tasks.filter((t: any) => !t.superseded_by).length;
  const failedTask = d.tasks.find((t: any) => t.status === 'failed' && !t.superseded_by);
  const rateLimitedTask = d.tasks.find((t: any) => t.status === 'queued' && t.result?.rateLimited && t.result?.resumeAt && new Date(t.result.resumeAt) > new Date());
  const waitingPc = !rateLimitedTask && p.status === 'running' && !d.tasks.some((t: any) => t.status === 'running') && d.tasks.some((t: any) => t.status === 'queued');
  const latestRun = d.testRuns[0];
  const fixes = d.tasks.filter((t: any) => t.key.startsWith('fix-'));
  const curRuns = current ? d.testRuns.filter((r: any) => r.task_id === current.id) : [];
  const lastAttempt = events.length ? events[events.length - 1].attemptNo : 0;

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold">{p.name}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-mute">
            <Status tone={st.tone}>{st.label}</Status>
            <span>{KIND_LABEL[p.kind]}</span>
            <span>{MODE_LABEL[p.automation_mode]}</span>
            <span>작업 {done}/{total}</span>
            {p.agent_name && <span>담당 PC: {p.agent_name}{p.agent_status !== 'online' && ' (꺼짐)'}</span>}
          </p>
        </div>
        <div className="flex gap-2">
          {p.status === 'failed' && failedTask && (
            <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => act('retry', () => api('POST', `/api/projects/${id}/retry`))}>다시 시도</button>
          )}
          {['running', 'awaiting_approval', 'review', 'failed'].includes(p.status) && (
            <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => confirm('이 프로젝트의 제작을 중단할까요? 실행 중인 작업도 멈춥니다.') && act('cancel', () => api('POST', `/api/projects/${id}/cancel`))}>
              제작 중단
            </button>
          )}
        </div>
      </section>

      <details className="panel px-4 py-3">
        <summary className="cursor-pointer font-semibold">요청 내용 보기</summary>
        <p className="mt-2 whitespace-pre-wrap text-[0.95rem]">{p.description}</p>
      </details>

      {error && <Notice tone="stop">{error}</Notice>}
      {rateLimitedTask && (
        <Notice tone="wait">
          <strong>AI 구독 사용량 한도에 도달했습니다.</strong> 「{rateLimitedTask.title}」은(는) {new Date(rateLimitedTask.result.resumeAt).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 이후 자동으로 다시 시작합니다. 재시도 횟수는 소모되지 않습니다.
        </Notice>
      )}
      {waitingPc && (
        <Notice tone="wait">
          <strong>PC를 기다리고 있습니다.</strong>{' '}
          {p.agent_name ? `담당 PC "${p.agent_name}"가 다른 작업을 끝내거나 엔진이 켜지면 이어서 진행합니다. 이 단계에 배정된 AI 도구가 그 PC에서 "사용 가능"인지도 확인하세요.` : '연결된 PC가 없거나, 이 단계에 배정된 AI 도구가 PC에서 "사용 가능" 상태가 아닙니다. PC가 다른 작업 중이면 순서를 기다립니다.'}{' '}
          <Link href="/agents/" className="font-semibold underline">PC 연결 상태 확인</Link>
        </Notice>
      )}
      {p.status === 'failed' && failedTask && (
        <Notice tone="stop">
          <strong>「{failedTask.title}」에서 실패했습니다.</strong> {failedTask.result?.reason}
        </Notice>
      )}

      {pending.map((a: any) => (
        <section key={a.id} className="rounded-xl border-2 border-wait bg-wait-wash p-4">
          <h3 className="text-lg font-bold">{a.title}</h3>
          <p className="mt-1 text-[0.95rem]">{a.detail}</p>
          {a.kind === 'final' && (
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-[0.95rem] sm:grid-cols-2">
              <div><dt className="inline text-mute">구현 작업 </dt><dd className="inline font-semibold">{d.tasks.filter((t: any) => t.kind === 'ai' && t.status === 'succeeded').length}개 완료</dd></div>
              <div><dt className="inline text-mute">테스트 </dt><dd className="inline font-semibold">{latestRun ? `${latestRun.summary.passed}개 통과, ${latestRun.summary.failed}개 실패, ${latestRun.summary.skipped}개 건너뜀` : '기록 없음'}</dd></div>
              <div><dt className="inline text-mute">자동 수정 </dt><dd className="inline font-semibold">{fixes.length ? `${fixes.length}회 (아래 작업 목록에서 확인)` : '없음'}</dd></div>
              <div><dt className="inline text-mute">결과물 </dt><dd className="inline font-semibold">{d.artifacts.length}개</dd></div>
            </dl>
          )}
          <div className="mt-3 flex gap-2">
            <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => act(a.id, () => api('POST', `/api/approvals/${a.id}/decide`, { approve: true }))}>승인</button>
            <button className="btn btn-sm" disabled={!!busy} onClick={() => confirm(a.kind === 'final' ? '결과물을 반려할까요? 프로젝트가 실패로 처리됩니다.' : '반려하면 프로젝트 제작이 중단됩니다. 계속할까요?') && act(a.id, () => api('POST', `/api/approvals/${a.id}/decide`, { approve: false }))}>
              반려
            </button>
          </div>
        </section>
      ))}

      {d.artifacts.length > 0 && (
        <section>
          <h3 className="mb-2 text-lg font-bold">결과물</h3>
          <ul className="panel divide-y divide-line">
            {d.artifacts.map((a: any) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{a.filename}</p>
                  <p className="text-sm text-mute">소스코드 ZIP / {fileSize(a.size)} / {dateTime(a.created_at)}</p>
                  <p className="mt-1 break-all font-mono text-xs text-mute">SHA-256 {a.sha256}</p>
                </div>
                <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => download(a.id)}>내려받기</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 생산 라인: 왼쪽은 공정(작업) 순서, 오른쪽은 선택한 공정의 실제 실행 기록 */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <section aria-label="작업 순서">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-lg font-bold">작업 순서</h3>
            {!follow && <button className="text-sm font-semibold text-cobalt underline-offset-4 hover:underline" onClick={() => setFollow(true)}>실행 중인 작업 따라가기</button>}
          </div>
          <ol className="relative">
            <span aria-hidden className="absolute bottom-5 left-[1.05rem] top-5 w-0.5 bg-line" />
            {visibleTasks.map((t: any) => {
              const s = taskTone(t);
              const on = t.id === currentId;
              return (
                <li key={t.id} className="relative">
                  <button
                    onClick={() => { setSelected(t.id); setFollow(false); }}
                    aria-current={on ? 'step' : undefined}
                    className={`flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left ${on ? 'bg-panel shadow-[0_0_0_1.5px_var(--color-cobalt)]' : 'hover:bg-panel/70'}`}
                  >
                    <span className="relative z-[1] mt-0.5 grid h-[1.15rem] w-[1.15rem] shrink-0 place-items-center rounded-full bg-sheet">
                      <Lamp tone={s.tone} size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block font-semibold leading-snug ${t.superseded_by ? 'text-mute line-through decoration-1' : ''}`}>{t.title}</span>
                      <span className="block text-sm text-mute">
                        {ROLE_LABEL[t.role] || t.role}
                        {t.kind === 'ai' && t.provider_key ? ` / ${t.provider_key}` : ''} / {s.label}
                        {t.attempt_count > 1 ? ` / ${t.attempt_count}번째 시도` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-label="실행 기록" className="min-w-0">
          {current && (
            <>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-lg font-bold">{current.title}</h3>
                <p className="text-sm text-mute">
                  {current.started_at ? `${dateTime(current.started_at)} 시작` : '아직 시작 전'}
                  {current.finished_at ? ` / ${timeAgo(current.finished_at)} 종료` : ''}
                </p>
              </div>
              {current.result?.reason && current.status !== 'succeeded' && (
                <div className="mb-2"><Notice tone={current.status === 'failed' && !current.superseded_by ? 'stop' : 'wait'}>{current.result.reason}</Notice></div>
              )}
              {current.kind === 'ai' && current.spec?.doneWhen && (
                <p className="mb-2 text-sm text-mute">완료 조건: {current.spec.doneWhen}</p>
              )}
              <div
                ref={consoleRef}
                onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
                role="log"
                aria-live="off"
                className="h-[26rem] overflow-auto rounded-xl bg-console p-3 font-mono text-[0.8rem] leading-relaxed text-[#c9d4ea]"
              >
                {events.length === 0 ? (
                  <p className="text-[#7f8cab]">{current.status === 'running' ? '로그를 기다리는 중…' : current.started_at ? '기록된 로그가 없습니다.' : '이 작업은 아직 시작하지 않았습니다.'}</p>
                ) : (
                  events.map((e, i) => (
                    <div key={e.id}>
                      {i > 0 && events[i - 1].attemptNo !== e.attemptNo && <div className="my-2 border-t border-dashed border-[#3a4868] pt-2 text-[#f3d27a]">— {e.attemptNo}번째 시도 —</div>}
                      <div className={`whitespace-pre-wrap break-words ${EV_STYLE[e.type] || ''} ${e.attemptNo !== lastAttempt ? 'opacity-60' : ''}`}>{e.message}</div>
                    </div>
                  ))
                )}
              </div>

              {curRuns.map((r: any) => (
                <div key={r.id} className="mt-4">
                  <h4 className="mb-1.5 font-bold">
                    실제 실행한 검증 명령{' '}
                    <span className="text-sm font-medium text-mute">({r.summary.passed ?? 0}개 통과, {r.summary.failed ?? 0}개 실패{r.summary.skipped ? `, ${r.summary.skipped}개 건너뜀` : ''})</span>
                  </h4>
                  {r.results.length === 0 ? (
                    <p className="panel p-3 text-mute">실행할 수 있는 테스트·빌드 명령을 찾지 못했습니다.</p>
                  ) : (
                    <ul className="panel divide-y divide-line">
                      {r.results.map((x: any) => (
                        <li key={x.ord}>
                          <details>
                            <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 p-3">
                              <Lamp tone={x.status === 'passed' ? 'go' : x.status === 'failed' ? 'stop' : 'idle'} />
                              <span className="font-semibold">{x.name}</span>
                              <code className="font-mono text-sm text-mute">{x.command}</code>
                              <span className="ml-auto text-sm text-mute">
                                {x.status === 'skipped' ? '건너뜀' : `종료 코드 ${x.exit_code} / ${duration(x.duration_ms)}`}
                              </span>
                            </summary>
                            <pre className="max-h-80 overflow-auto bg-console p-3 font-mono text-xs leading-relaxed text-[#c9d4ea]">{x.log_tail || '(출력 없음)'}</pre>
                          </details>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </>
          )}
        </section>
      </div>

      {d.repository?.local_path && (
        <p className="text-sm text-mute">
          소스 위치(담당 PC): <span className="break-all font-mono">{d.repository.local_path}</span>
          {d.repository.head_commit && <> / 커밋 <span className="font-mono">{d.repository.head_commit.slice(0, 8)}</span></>}
        </p>
      )}
    </div>
  );
}

export default function ProjectPage() {
  return (
    <Shell title="프로젝트" action={<Link href="/projects/" className="btn btn-sm">목록</Link>}>
      <Suspense fallback={<p className="text-mute">불러오는 중…</p>}>
        <ProjectView />
      </Suspense>
    </Shell>
  );
}
