'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { api, setToken } from '@/lib/api';
import { Notice, ROLE_LABEL } from '@/lib/ui';

const ROLES = ['planner', 'designer', 'backend', 'frontend', 'database', 'devops', 'fixer'];

export default function SettingsPage() {
  const [s, setS] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: 'go' | 'stop'; text: string } | null>(null);

  useEffect(() => {
    api('GET', '/api/settings').then((r) => {
      setS(r);
      setRoles(r.roleAssignments);
    }).catch((e) => setMsg({ tone: 'stop', text: e.message }));
    api('GET', '/api/auth/me').then(setMe).catch(() => undefined);
  }, []);

  async function save() {
    setMsg(null);
    try {
      const assignments = Object.fromEntries(Object.entries(roles).filter(([, v]) => v));
      await api('PUT', '/api/settings/role-assignments', { assignments: { '*': 'codex', ...assignments } });
      setMsg({ tone: 'go', text: '저장했습니다. 다음에 만드는 프로젝트부터 적용됩니다.' });
    } catch (e: any) {
      setMsg({ tone: 'stop', text: e.message });
    }
  }
  const providers: Array<{ key: string; display_name: string }> = s?.availableProviders?.length ? s.availableProviders : [{ key: 'codex', display_name: 'OpenAI Codex CLI' }];

  return (
    <Shell title="설정">
      <div className="max-w-2xl space-y-7">
        <section>
          <h2 className="mb-1 text-lg font-bold">역할별 AI 배정</h2>
          <p className="mb-3 text-[0.95rem] text-mute">각 역할을 어떤 AI 도구에 맡길지 정합니다. PC에 설치된 도구만 고를 수 있습니다.</p>
          {!s ? (
            <p className="text-mute">불러오는 중…</p>
          ) : (
            <div className="panel divide-y divide-line">
              <div className="flex items-center justify-between gap-3 p-3">
                <label htmlFor="role-default" className="font-semibold">기본 (지정하지 않은 역할)</label>
                <select id="role-default" className="field !w-auto" value={roles['*'] || 'codex'} onChange={(e) => setRoles({ ...roles, '*': e.target.value })}>
                  {providers.map((p) => <option key={p.key} value={p.key}>{p.display_name}</option>)}
                </select>
              </div>
              {ROLES.map((r) => (
                <div key={r} className="flex items-center justify-between gap-3 p-3">
                  <label htmlFor={`role-${r}`}>{ROLE_LABEL[r]}</label>
                  <select id={`role-${r}`} className="field !w-auto" value={roles[r] || ''} onChange={(e) => setRoles({ ...roles, [r]: e.target.value })}>
                    <option value="">기본을 따름</option>
                    {providers.map((p) => <option key={p.key} value={p.key}>{p.display_name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-primary mt-3" onClick={save} disabled={!s}>배정 저장</button>
          {msg && <div className="mt-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
        </section>

        <section>
          <h2 className="mb-2 text-lg font-bold">요금 보호</h2>
          <div className="panel space-y-2 p-4 text-[0.95rem]">
            <p><strong>종량제 AI API: {s?.meteredApiEnabled ? '켜짐' : '꺼짐'}</strong></p>
            <p className="text-mute">구독 계정으로 로그인한 AI 도구만 사용합니다. AI 도구가 API 키(종량제)로 로그인되어 있으면 PC 엔진이 실행을 거부합니다.</p>
            <p className="text-mute">결과물은 승인하기 전까지 외부에 배포되지 않으며, 클라우드 리소스 생성·결제는 수행하지 않습니다.</p>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-bold">계정</h2>
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <p>
              <strong>{me?.name}</strong> <span className="text-mute">{me?.email}</span>
              <span className="block text-sm text-mute">{me?.organization?.name}{me?.isAdmin ? ' / 관리자' : ''}</span>
            </p>
            <button className="btn btn-sm" onClick={() => { setToken(null); location.href = '/login/'; }}>로그아웃</button>
          </div>
        </section>
      </div>
    </Shell>
  );
}
