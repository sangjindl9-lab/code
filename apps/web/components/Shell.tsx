'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, useRealtime } from '@/lib/api';

const NAV = [
  { href: '/', label: '현황', icon: 'M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10' },
  { href: '/projects/', label: '프로젝트', icon: 'M4 5h16M4 12h16M4 19h16' },
  { href: '/new/', label: '새로 만들기', icon: 'M12 5v14M5 12h14' },
  { href: '/agents/', label: 'PC 연결', icon: 'M4 5h16v11H4zM9 20h6M12 16v4' },
  { href: '/settings/', label: '설정', icon: 'M12 9a3 3 0 100 6 3 3 0 000-6zM4 12h2M18 12h2M12 4v2M12 18v2' },
];

function Icon({ d }: { d: string }) {
  return (
    <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

/** 로그인 확인 + 내비게이션(PC: 왼쪽 레일, 휴대폰: 아래 탭) */
export default function Shell({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const [me, setMe] = useState<any>(null);
  const [unread, setUnread] = useState(0);

  const loadUnread = useCallback(() => {
    api('GET', '/api/notifications').then((n: any[]) => setUnread(n.filter((x) => !x.read_at).length)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!getToken()) {
      location.href = '/login/';
      return;
    }
    api('GET', '/api/auth/me').then(setMe).catch(() => undefined);
    loadUnread();
  }, [loadUnread]);
  useRealtime(null, (m) => m.type === 'notification' && loadUnread());

  if (!me) return <div className="grid min-h-dvh place-items-center text-mute">불러오는 중…</div>;
  const active = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href.replace(/\/$/, '')));

  return (
    <div className="mx-auto flex min-h-dvh max-w-[1280px]">
      <nav aria-label="주 메뉴" className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line px-3 py-5 lg:flex">
        <Link href="/" className="mb-6 flex items-center gap-2.5 px-2">
          <img src="/icon.svg" alt="" width={32} height={32} className="rounded-lg" />
          <span className="text-[1.05rem] font-bold leading-tight">
            EUM 공장
            <span className="block text-xs font-medium text-mute">{me.organization?.name}</span>
          </span>
        </Link>
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active(n.href) ? 'page' : undefined}
            className={`mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 font-semibold ${active(n.href) ? 'bg-ink text-white' : 'text-ink hover:bg-white'}`}
          >
            <Icon d={n.icon} />
            {n.label}
            {n.href === '/' && unread > 0 && <span className="ml-auto rounded-full bg-stop px-2 text-xs text-white">{unread}</span>}
          </Link>
        ))}
        <p className="mt-auto px-2 text-sm text-mute">{me.name}</p>
      </nav>

      <div className="min-w-0 flex-1 pb-24 lg:pb-10">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-sheet/95 px-4 py-3 backdrop-blur lg:px-8 lg:py-5">
          <h1 className="truncate text-xl font-bold lg:text-2xl">{title}</h1>
          {action}
        </header>
        <main className="px-4 py-5 lg:px-8 lg:py-7">{children}</main>
      </div>

      <nav aria-label="주 메뉴" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] lg:hidden">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active(n.href) ? 'page' : undefined}
            className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[0.7rem] font-semibold ${active(n.href) ? 'text-cobalt' : 'text-mute'}`}
          >
            <Icon d={n.icon} />
            {n.label}
            {n.href === '/' && unread > 0 && <span className="absolute right-[26%] top-1.5 h-2.5 w-2.5 rounded-full bg-stop" />}
          </Link>
        ))}
      </nav>
    </div>
  );
}
