'use client';
import { useState } from 'react';
import Shell from '@/components/Shell';
import { api } from '@/lib/api';
import { Notice } from '@/lib/ui';

const KINDS = [
  ['web', '웹', '브라우저에서 쓰는 프로그램'],
  ['pc', 'PC', 'Windows에서 실행하는 프로그램'],
  ['android', 'Android', '휴대폰 앱'],
  ['api', 'API 서버', '화면 없는 서버 프로그램'],
  ['integrated', '통합형', '웹 화면과 서버를 함께'],
];
const MODES = [
  ['manual', '수동 승인', 'AI 작업을 하나씩 승인한 뒤 실행합니다.'],
  ['semi', '반자동 (권장)', '개발·테스트는 자동으로 진행하고, 위험한 작업과 최종 결과는 승인받습니다.'],
  ['auto', '자동 개발', '기획부터 빌드까지 자동으로 진행합니다. 최종 결과는 승인받습니다.'],
];
const PLATFORMS = ['Windows', 'Android', '웹 브라우저', 'Linux 서버'];
const EXAMPLE = '전기통신공사업체에서 사용할 ERP를 만들어줘. 공사등록, 계약, 자재발주, 검측, 기성관리, 정산 기능이 필요해.';

export default function NewProjectPage() {
  const [f, setF] = useState({ name: '', description: '', kind: 'web', platforms: ['웹 브라우저'] as string[], urls: '', priority: 'normal', automationMode: 'semi' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const referenceUrls = f.urls.split(/\s+/).map((s) => s.trim()).filter(Boolean);
      const r = await api('POST', '/api/projects', { name: f.name, description: f.description, kind: f.kind, platforms: f.platforms, referenceUrls, priority: f.priority, automationMode: f.automationMode });
      location.href = `/project/?id=${r.id}`;
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }
  const toggle = (p: string) => setF({ ...f, platforms: f.platforms.includes(p) ? f.platforms.filter((x) => x !== p) : [...f.platforms, p] });

  return (
    <Shell title="새 프로그램 만들기">
      <form onSubmit={submit} className="max-w-2xl space-y-6">
        <div>
          <label className="label" htmlFor="name">프로젝트명</label>
          <input id="name" className="field" required maxLength={100} placeholder="예: 전기공사 ERP" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div>
          <div className="flex items-end justify-between">
            <label className="label" htmlFor="desc">어떤 프로그램인가요?</label>
            <button type="button" className="mb-1 text-sm font-semibold text-cobalt underline-offset-4 hover:underline" onClick={() => setF({ ...f, description: EXAMPLE, name: f.name || '전기통신공사 ERP' })}>
              예시 넣기
            </button>
          </div>
          <textarea id="desc" className="field min-h-44" required minLength={10} maxLength={20000} placeholder="필요한 기능, 사용하는 사람, 화면 구성을 아는 만큼 적어 주세요." value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <p className="mt-1 text-sm text-mute">자세히 적을수록 원하는 결과에 가까워집니다. 부족한 부분은 AI가 가정을 세우고 기획 문서에 적어 둡니다.</p>
        </div>

        <fieldset>
          <legend className="label">프로그램 종류</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {KINDS.map(([v, label, hint]) => (
              <label key={v} className={`flex cursor-pointer items-start gap-3 rounded-lg border bg-panel p-3 ${f.kind === v ? 'border-cobalt ring-1 ring-cobalt' : 'border-line'}`}>
                <input type="radio" name="kind" className="mt-1 accent-cobalt" checked={f.kind === v} onChange={() => setF({ ...f, kind: v })} />
                <span>
                  <span className="font-semibold">{label}</span>
                  <span className="block text-sm text-mute">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="label">실행 플랫폼</legend>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((p) => (
              <label key={p} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border bg-panel px-3 ${f.platforms.includes(p) ? 'border-cobalt' : 'border-line'}`}>
                <input type="checkbox" className="accent-cobalt" checked={f.platforms.includes(p)} onChange={() => toggle(p)} />
                {p}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="label">AI 자동화 수준</legend>
          <div className="space-y-2">
            {MODES.map(([v, label, hint]) => (
              <label key={v} className={`flex cursor-pointer items-start gap-3 rounded-lg border bg-panel p-3 ${f.automationMode === v ? 'border-cobalt ring-1 ring-cobalt' : 'border-line'}`}>
                <input type="radio" name="mode" className="mt-1 accent-cobalt" checked={f.automationMode === v} onChange={() => setF({ ...f, automationMode: v })} />
                <span>
                  <span className="font-semibold">{label}</span>
                  <span className="block text-sm text-mute">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="prio">개발 우선순위</label>
            <select id="prio" className="field" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              <option value="high">높음 — 다른 프로젝트보다 먼저</option>
              <option value="normal">보통</option>
              <option value="low">낮음</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="urls">참고 URL (선택)</label>
            <input id="urls" className="field" placeholder="https://… (여러 개는 띄어쓰기로 구분)" value={f.urls} onChange={(e) => setF({ ...f, urls: e.target.value })} inputMode="url" />
          </div>
        </div>

        {error && <Notice tone="stop">{error}</Notice>}
        <button className="btn btn-primary w-full sm:w-auto" disabled={busy}>{busy ? '요청하는 중…' : '제작 요청하기'}</button>
        <p className="text-sm text-mute">요청하면 연결된 PC에서 기획 → 개발 → 테스트 → 패키징 순서로 진행합니다. 결과물은 승인하기 전까지 어디에도 배포되지 않습니다.</p>
      </form>
    </Shell>
  );
}
