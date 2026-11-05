'use client';
import type { ReactNode } from 'react';

export type Tone = 'go' | 'wait' | 'stop' | 'idle' | 'live';

export const PROJECT_STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: '제작 중', tone: 'live' },
  awaiting_approval: { label: '승인 대기', tone: 'wait' },
  review: { label: '결과 확인 대기', tone: 'wait' },
  completed: { label: '완료', tone: 'go' },
  failed: { label: '실패', tone: 'stop' },
  cancelled: { label: '취소됨', tone: 'idle' },
};
export const TASK_STATUS: Record<string, { label: string; tone: Tone }> = {
  blocked: { label: '앞 작업 대기', tone: 'idle' },
  awaiting_approval: { label: '승인 대기', tone: 'wait' },
  queued: { label: 'PC 대기 중', tone: 'wait' },
  running: { label: '실행 중', tone: 'live' },
  succeeded: { label: '완료', tone: 'go' },
  failed: { label: '실패', tone: 'stop' },
  cancelled: { label: '취소됨', tone: 'idle' },
};
export const KIND_LABEL: Record<string, string> = { web: '웹', pc: 'PC', android: 'Android', api: 'API 서버', integrated: '통합형' };
export const ROLE_LABEL: Record<string, string> = {
  planner: '기획',
  designer: '디자인',
  backend: '백엔드',
  frontend: '프론트엔드',
  database: '데이터베이스',
  reviewer: '검증',
  security: '보안',
  devops: '빌드',
  fixer: '오류 수정',
};
export const MODE_LABEL: Record<string, string> = { manual: '수동 승인', semi: '반자동', auto: '자동 개발' };

const TONE_BG: Record<Tone, string> = { go: 'bg-go', wait: 'bg-wait', stop: 'bg-stop', idle: 'bg-line', live: 'bg-cobalt' };
const TONE_TEXT: Record<Tone, string> = { go: 'text-go', wait: 'text-wait', stop: 'text-stop', idle: 'text-mute', live: 'text-cobalt' };

/** 공정 신호등 */
export function Lamp({ tone, size = 10 }: { tone: Tone; size?: number }) {
  return <span aria-hidden className={`inline-block shrink-0 rounded-full ${TONE_BG[tone]} ${tone === 'live' ? 'lamp-live' : ''}`} style={{ width: size, height: size }} />;
}
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${TONE_TEXT[tone]}`}>
      <Lamp tone={tone} />
      {children}
    </span>
  );
}

export function Notice({ tone, children }: { tone: 'stop' | 'wait' | 'go' | 'info'; children: ReactNode }) {
  const cls = { stop: 'bg-stop-wash border-stop/30', wait: 'bg-wait-wash border-wait/30', go: 'bg-go-wash border-go/30', info: 'bg-cobalt-wash border-cobalt/20' }[tone];
  return (
    <div role={tone === 'stop' ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 text-[0.95rem] ${cls}`}>
      {children}
    </div>
  );
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return '-';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
}
export const dateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
export function fileSize(n: number | string): string {
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

export function providerState(p: any): { tone: 'go' | 'wait' | 'stop'; text: string } {
  if (!p.installed) return { tone: 'stop', text: '설치 안 됨' };
  if (!p.authenticated) return { tone: 'wait', text: '로그인 필요' };
  if (p.execution_policy?.allowed === false) return { tone: 'wait', text: '실행 제한' };
  return { tone: 'go', text: '사용 가능' };
}

