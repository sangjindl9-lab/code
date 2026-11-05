import { Injectable } from '@nestjs/common';
import type { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthService, UserCtx } from './auth';
import { Db } from './db';

/** 웹 화면으로 실시간 이벤트를 보내는 WebSocket 허브. 이벤트 원본은 항상 DB에 먼저 저장됩니다. */
@Injectable()
export class Hub {
  private channels = new Map<string, Set<WebSocket>>();
  private wss?: WebSocketServer;

  constructor(
    private readonly auth: AuthService,
    private readonly db: Db,
  ) {}

  attach(server: HttpServer) {
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
    this.wss.on('connection', (ws, req) => {
      let user: UserCtx | undefined;
      const mine = new Set<string>();
      const authTimer = setTimeout(() => !user && ws.close(4401, 'auth timeout'), 10_000);
      const join = (ch: string) => {
        mine.add(ch);
        if (!this.channels.has(ch)) this.channels.set(ch, new Set());
        this.channels.get(ch)!.add(ws);
      };
      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'auth') {
            user = await this.auth.userFromToken(String(msg.token || ''));
            if (!user) return ws.close(4401, 'unauthorized');
            clearTimeout(authTimer);
            join(`o:${user.orgId}`);
            ws.send(JSON.stringify({ type: 'ready' }));
          } else if (msg.type === 'subscribe' && user) {
            const ok = await this.db.one('SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2', [
              String(msg.projectId),
              user.orgId,
            ]);
            if (ok) join(`p:${msg.projectId}`);
          } else if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
          /* 잘못된 메시지는 무시 */
        }
      });
      ws.on('close', () => {
        clearTimeout(authTimer);
        for (const ch of mine) {
          const set = this.channels.get(ch);
          set?.delete(ws);
          if (set && set.size === 0) this.channels.delete(ch);
        }
      });
      ws.on('error', () => ws.close());
      void req;
    });
  }

  private send(channel: string, msg: unknown) {
    const set = this.channels.get(channel);
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  toProject(projectId: string, msg: unknown) {
    this.send(`p:${projectId}`, msg);
  }
  toOrg(orgId: string, msg: unknown) {
    this.send(`o:${orgId}`, msg);
  }

  close() {
    this.wss?.close();
    for (const set of this.channels.values()) for (const ws of set) ws.terminate();
    this.channels.clear();
  }
}
