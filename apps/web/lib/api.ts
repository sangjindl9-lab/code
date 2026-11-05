'use client';
import { useEffect, useRef } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';
const KEY = 'eum_token';

export const getToken = () => (typeof window === 'undefined' ? null : window.localStorage.getItem(KEY));
export const setToken = (t: string | null) => (t ? window.localStorage.setItem(KEY, t) : window.localStorage.removeItem(KEY));

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.');
  }
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* JSON 아님 */
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      setToken(null);
      if (!location.pathname.startsWith('/login')) location.href = '/login/';
    }
    const msg = Array.isArray(json?.message) ? json.message.join(', ') : json?.message;
    throw new ApiError(res.status, msg || `요청을 처리하지 못했습니다. (${res.status})`);
  }
  return json as T;
}

export const downloadUrl = (path: string) => API_BASE + path;

/** 서버의 실시간 알림(WebSocket)을 받습니다. 끊기면 자동으로 다시 연결합니다. */
export function useRealtime(projectId: string | null, onMessage: (msg: any) => void) {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const token = getToken();
      if (!token || closed) return;
      const base = API_BASE ? new URL(API_BASE) : location;
      ws = new WebSocket(`${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}/ws`);
      ws.onopen = () => ws!.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.type === 'ready') {
          retry = 1000;
          if (projectId) ws!.send(JSON.stringify({ type: 'subscribe', projectId }));
          handler.current({ type: 'connected' });
        } else handler.current(msg);
      };
      ws.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    const ping = setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 25000);
    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(ping);
      ws?.close();
    };
  }, [projectId]);
}
