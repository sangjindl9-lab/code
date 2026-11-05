'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { api, useRealtime } from '@/lib/api';
import { KIND_LABEL, MODE_LABEL, Notice, PROJECT_STATUS, Status, timeAgo } from '@/lib/ui';

const FILTERS: Array<[string, string, string[]]> = [
  ['all', '전체', []],
  ['active', '진행 중', ['running', 'awaiting_approval', 'review']],
  ['completed', '완료', ['completed']],
  ['failed', '실패·취소', ['failed', 'cancelled']],
];

export default function ProjectsPage() {
  const [list, setList] = useState<any[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api('GET', '/api/projects').then(setList).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useRealtime(null, (m) => m.type === 'project' && load());
  const want = FILTERS.find((f) => f[0] === filter)![2];
  const shown = (list || []).filter((p) => !want.length || want.includes(p.status));

  return (
    <Shell title="프로젝트" action={<Link href="/new/" className="btn btn-primary btn-sm">새 프로그램 만들기</Link>}>
      {error && <Notice tone="stop">{error}</Notice>}
      <div role="tablist" aria-label="상태로 걸러 보기" className="mb-4 flex gap-2 overflow-x-auto">
        {FILTERS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)} className={`btn btn-sm ${filter === key ? '!border-ink !bg-ink !text-white' : ''}`}>
            {label}
          </button>
        ))}
      </div>
      {!list ? (
        <p className="text-mute">불러오는 중…</p>
      ) : shown.length === 0 ? (
        <p className="panel p-5 text-mute">{list.length ? '이 상태의 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다. 만들고 싶은 프로그램을 설명해 보세요.'}</p>
      ) : (
        <ul className="panel divide-y divide-line">
          {shown.map((p) => (
            <li key={p.id}>
              <Link href={`/project/?id=${p.id}`} className="grid gap-x-4 gap-y-1 p-4 hover:bg-sheet sm:grid-cols-[1fr_auto_auto] sm:items-center">
                <span className="min-w-0">
                  <span className="block truncate text-[1.05rem] font-bold">{p.name}</span>
                  <span className="text-sm text-mute">{KIND_LABEL[p.kind]} / {MODE_LABEL[p.automation_mode]} / {timeAgo(p.created_at)} 요청</span>
                </span>
                <span className="text-sm text-mute">작업 {p.task_done}/{p.task_total}</span>
                <span className="sm:w-36 sm:text-right"><Status tone={PROJECT_STATUS[p.status].tone}>{PROJECT_STATUS[p.status].label}</Status></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
