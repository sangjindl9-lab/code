import * as fs from 'fs';
import * as path from 'path';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 중앙 서버로 나가는(아웃바운드) HTTPS 요청만 사용합니다. 엔진은 어떤 포트도 열지 않습니다. */
export class ServerApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  async post<T = any>(pathname: string, body: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(this.baseUrl + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.read<T>(res);
  }

  async upload<T = any>(pathname: string, file: string, fields: Record<string, string>, timeoutMs = 30 * 60_000): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const blob = await fs.openAsBlob(file);
    form.append('file', blob, path.basename(file));
    const res = await fetch(this.baseUrl + pathname, {
      method: 'POST',
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.read<T>(res);
  }

  private async read<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 300) };
    }
    if (!res.ok) throw new ApiError(res.status, Array.isArray(json.message) ? json.message.join(', ') : json.message || `HTTP ${res.status}`);
    return json as T;
  }
}

/** 일시적 오류(네트워크, 5xx)는 간격을 늘려 가며 재시도합니다. 4xx 는 즉시 실패합니다. */
export async function withRetry<T>(fn: () => Promise<T>, opts: { tries?: number; signal?: AbortSignal } = {}): Promise<T> {
  const tries = opts.tries ?? 8;
  let delay = 500;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const permanent = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408;
      if (permanent || i >= tries || opts.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }
}
