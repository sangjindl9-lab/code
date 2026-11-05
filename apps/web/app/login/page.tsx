'use client';
import { useEffect, useState } from 'react';
import { api, setToken } from '@/lib/api';
import { Notice } from '@/lib/ui';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [signupOpen, setSignupOpen] = useState(false);
  const [first, setFirst] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', name: '', organizationName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('GET', '/api/auth/status')
      .then((s) => {
        setSignupOpen(s.signupOpen);
        setFirst(!s.hasUsers);
        if (!s.hasUsers) setMode('register');
      })
      .catch((e) => setError(e.message));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = mode === 'login' ? { email: form.email, password: form.password } : { ...form, organizationName: form.organizationName || undefined };
      const r = await api('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/register', body);
      setToken(r.token);
      location.href = '/';
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <main className="mx-auto grid min-h-dvh max-w-5xl items-center gap-10 px-5 py-10 lg:grid-cols-[1.1fr_1fr]">
      <section>
        <img src="/icon.svg" alt="" width={56} height={56} className="mb-6 rounded-xl" />
        <h1 className="text-[2rem] font-bold leading-tight lg:text-[2.75rem]">
          휴대폰으로 요청하면
          <br />내 PC의 AI가 프로그램을 만듭니다
        </h1>
        <ol className="mt-8 space-y-3 text-[1.05rem] text-mute">
          {['만들 프로그램을 글로 설명합니다', 'PC에 설치한 엔진이 구독 중인 AI 도구로 코드를 작성합니다', '실제 테스트를 통과한 결과물만 내려받습니다'].map((t, i) => (
            <li key={t} className="flex gap-3">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink text-sm font-bold text-white">{i + 1}</span>
              {t}
            </li>
          ))}
        </ol>
      </section>

      <form onSubmit={submit} className="panel space-y-4 p-6 lg:p-8">
        <h2 className="text-xl font-bold">{mode === 'login' ? '로그인' : first ? '관리자 계정 만들기' : '회원가입'}</h2>
        {first && <Notice tone="info">처음 가입하는 계정이 관리자가 됩니다.</Notice>}
        {mode === 'register' && (
          <>
            <div>
              <label className="label" htmlFor="name">이름</label>
              <input id="name" className="field" required maxLength={60} value={form.name} onChange={set('name')} autoComplete="name" />
            </div>
            <div>
              <label className="label" htmlFor="org">회사·작업공간 이름 (선택)</label>
              <input id="org" className="field" maxLength={80} value={form.organizationName} onChange={set('organizationName')} autoComplete="organization" />
            </div>
          </>
        )}
        <div>
          <label className="label" htmlFor="email">이메일</label>
          <input id="email" type="email" className="field" required value={form.email} onChange={set('email')} autoComplete="email" inputMode="email" />
        </div>
        <div>
          <label className="label" htmlFor="pw">비밀번호{mode === 'register' && ' (8자 이상)'}</label>
          <input id="pw" type="password" className="field" required minLength={mode === 'register' ? 8 : 1} value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </div>
        {error && <Notice tone="stop">{error}</Notice>}
        <button className="btn btn-primary w-full" disabled={busy}>
          {busy ? '확인 중…' : mode === 'login' ? '로그인' : '계정 만들기'}
        </button>
        {signupOpen && !first && (
          <button type="button" className="w-full text-center text-sm font-semibold text-cobalt underline-offset-4 hover:underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? '계정이 없으면 회원가입' : '이미 계정이 있으면 로그인'}
          </button>
        )}
      </form>
    </main>
  );
}
