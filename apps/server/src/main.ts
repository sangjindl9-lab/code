import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from './app.module';
import { jwtSecret } from './auth';
import { Db } from './db';
import { Pipeline } from './pipeline';
import { Hub } from './realtime';

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
  app: NestExpressApplication;
}

function findWebDir(): string | undefined {
  const candidates = [
    process.env.WEB_DIR,
    path.join(process.cwd(), 'apps', 'web', 'out'),
    path.join(__dirname, '..', '..', '..', 'web', 'out'),
    path.join(__dirname, '..', '..', 'web', 'out'),
  ].filter(Boolean) as string[];
  return candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
}

export async function startServer(opts: { port?: number; host?: string; quiet?: boolean } = {}): Promise<RunningServer> {
  jwtSecret(); // 운영 환경에서 비밀키가 없으면 즉시 중단
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: opts.quiet ? ['error'] : ['error', 'warn', 'log'],
    bodyParser: false,
  });
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
  app.disable('x-powered-by');
  app.use(express.json({ limit: '12mb' }));
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  if (process.env.CORS_ORIGIN) app.enableCors({ origin: process.env.CORS_ORIGIN.split(',') });

  const db = app.get(Db);
  const applied = await db.migrate();
  if (applied.length && !opts.quiet) console.log(`[DB] 마이그레이션 적용: ${applied.join(', ')}`);

  const webDir = findWebDir();
  if (webDir) {
    app.use(express.static(webDir, { extensions: ['html'], maxAge: '1h', setHeaders: (res, p) => {
      if (p.endsWith('.html') || p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    } }));
  } else if (!opts.quiet) {
    console.warn('[웹] 빌드된 웹 화면(apps/web/out)을 찾지 못했습니다. API만 제공합니다.');
  }

  await app.init();
  const pipeline = app.get(Pipeline);
  const hub = app.get(Hub);
  // 재시작 후 상태 정합성 검사: 임대가 만료된 작업을 복구합니다.
  await pipeline.reap();
  const timer = setInterval(() => pipeline.reap().catch((e) => console.error('[복구 작업 오류]', e.message)), Math.min(15_000, pipeline.leaseSec * 500));

  const port = opts.port ?? Number(process.env.PORT || 4000);
  const server = await app.listen(port, opts.host ?? '0.0.0.0');
  hub.attach(server);
  const actual = (server.address() as any).port as number;
  if (!opts.quiet) console.log(`EUM Control Server 실행 중: http://localhost:${actual}`);
  return {
    app,
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    async close() {
      clearInterval(timer);
      hub.close();
      await app.close();
    },
  };
}

if (require.main === module) {
  startServer().catch((e) => {
    console.error('서버 시작 실패:', e);
    process.exit(1);
  });
}
