import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

export interface Q {
  q<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

function wrap(runner: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }): Q {
  return {
    async q(sql, params) {
      return (await runner.query(sql, params as any[])).rows;
    },
    async one(sql, params) {
      return (await runner.query(sql, params as any[])).rows[0];
    },
  };
}

@Injectable()
export class Db implements Q, OnModuleDestroy {
  readonly pool: Pool;
  private readonly base: Q;

  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL 환경변수가 필요합니다.');
    this.pool = new Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX || 10),
      ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
    });
    this.base = wrap(this.pool);
  }

  q<T = any>(sql: string, params?: unknown[]) {
    return this.base.q<T>(sql, params);
  }
  one<T = any>(sql: string, params?: unknown[]) {
    return this.base.one<T>(sql, params);
  }

  /** 트랜잭션. 콜백이 예외를 던지면 롤백합니다. */
  async tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(wrap(client));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** migrations/*.sql 을 순서대로 한 번씩만 적용합니다. */
  async migrate(): Promise<string[]> {
    const dir = [path.join(__dirname, '..', 'migrations'), path.join(__dirname, '..', '..', 'migrations')].find((d) =>
      fs.existsSync(d),
    );
    if (!dir) throw new Error('migrations 디렉터리를 찾을 수 없습니다.');
    const applied: string[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(727001)');
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        if (done.has(file)) continue;
        await client.query('BEGIN');
        try {
          await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
          applied.push(file);
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
      client.release();
    }
    return applied;
  }

  async onModuleDestroy() {
    await this.pool.end().catch(() => undefined);
  }
}

export async function audit(
  q: Q,
  e: {
    orgId?: string | null;
    userId?: string | null;
    agentId?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: unknown;
    ip?: string;
  },
) {
  await q.q(
    `INSERT INTO audit_logs (organization_id, user_id, agent_id, action, target_type, target_id, detail, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      e.orgId ?? null,
      e.userId ?? null,
      e.agentId ?? null,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      JSON.stringify(e.detail ?? {}),
      e.ip ?? null,
    ],
  );
}
