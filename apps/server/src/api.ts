import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { diskStorage } from 'multer';
import { z } from 'zod';
import {
  AgentCtx,
  AgentGuard,
  parse,
  randomToken,
  RateLimiter,
  requireWriter,
  sha256,
  signToken,
  UserCtx,
  UserGuard,
  verifyToken,
} from './auth';
import { audit, Db } from './db';
import { completeSchema, Pipeline, toEvent } from './pipeline';
import { Hub } from './realtime';

export const storageDir = () => path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), 'data', 'storage'));
const uuid = new ParseUUIDPipe();

// ═════════════════════════ 프로젝트 ═════════════════════════

@Controller('api')
@UseGuards(UserGuard)
export class ProjectsController {
  constructor(
    private readonly db: Db,
    private readonly pipeline: Pipeline,
  ) {}

  @Get('dashboard')
  async dashboard(@Req() req: any) {
    const u: UserCtx = req.user;
    const [counts, agents, running, approvals, artifacts, recent] = await Promise.all([
      this.db.one(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status IN ('running','awaiting_approval'))::int AS active,
                count(*) FILTER (WHERE status = 'review')::int AS review,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM projects WHERE organization_id = $1`,
        [u.orgId],
      ),
      this.agentList(u.orgId),
      this.db.q(
        `SELECT t.id, t.title, t.kind, t.provider_key, t.started_at, p.id AS project_id, p.name AS project_name
           FROM ai_tasks t JOIN projects p ON p.id = t.project_id
          WHERE p.organization_id = $1 AND t.status = 'running' ORDER BY t.started_at`,
        [u.orgId],
      ),
      this.db.q(
        `SELECT a.id, a.kind, a.title, a.requested_at, p.id AS project_id, p.name AS project_name
           FROM approvals a JOIN projects p ON p.id = a.project_id
          WHERE p.organization_id = $1 AND a.status = 'pending' ORDER BY a.requested_at`,
        [u.orgId],
      ),
      this.db.q(
        `SELECT b.id, b.filename, b.size, b.sha256, b.created_at, p.id AS project_id, p.name AS project_name
           FROM build_artifacts b JOIN projects p ON p.id = b.project_id
          WHERE p.organization_id = $1 ORDER BY b.created_at DESC LIMIT 5`,
        [u.orgId],
      ),
      this.db.q(
        `SELECT id, name, kind, status, updated_at FROM projects WHERE organization_id = $1 ORDER BY updated_at DESC LIMIT 6`,
        [u.orgId],
      ),
    ]);
    return { counts, agents, runningTasks: running, pendingApprovals: approvals, recentArtifacts: artifacts, recentProjects: recent };
  }

  async agentList(orgId: string) {
    const agents = await this.db.q(
      `SELECT id, name, platform, engine_version, status, paused, max_concurrency, system_info, last_seen_at, created_at
         FROM desktop_agents WHERE organization_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
      [orgId],
    );
    const providers = await this.db.q(
      `SELECT pr.id, pr.agent_id, pr.key, pr.display_name, pr.installed, pr.authenticated, pr.version, pr.execution_policy, pr.usage_status,
              COALESCE((SELECT jsonb_object_agg(c.capability, c.supported) FROM ai_provider_capabilities c WHERE c.provider_id = pr.id), '{}') AS capabilities
         FROM ai_providers pr JOIN desktop_agents a ON a.id = pr.agent_id
        WHERE a.organization_id = $1 AND a.revoked_at IS NULL ORDER BY pr.key`,
      [orgId],
    );
    return agents.map((a) => ({ ...a, providers: providers.filter((p) => p.agent_id === a.id) }));
  }

  @Get('projects')
  async list(@Req() req: any) {
    const u: UserCtx = req.user;
    return this.db.q(
      `SELECT p.id, p.name, p.kind, p.status, p.priority, p.automation_mode, p.created_at, p.updated_at,
              (SELECT count(*)::int FROM ai_tasks t WHERE t.project_id = p.id AND t.superseded_by IS NULL) AS task_total,
              (SELECT count(*)::int FROM ai_tasks t WHERE t.project_id = p.id AND t.status = 'succeeded') AS task_done
         FROM projects p WHERE p.organization_id = $1 ORDER BY p.created_at DESC LIMIT 200`,
      [u.orgId],
    );
  }

  @Post('projects')
  create(@Req() req: any, @Body() body: unknown) {
    return this.pipeline.createProject(req.user, body, req.ip);
  }

  @Get('projects/:id')
  async detail(@Req() req: any, @Param('id', uuid) id: string) {
    const u: UserCtx = req.user;
    const project = await this.db.one(
      `SELECT p.*, a.name AS agent_name, a.status AS agent_status
         FROM projects p LEFT JOIN desktop_agents a ON a.id = p.agent_id
        WHERE p.id = $1 AND p.organization_id = $2`,
      [id, u.orgId],
    );
    if (!project) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
    const [tasks, deps, approvals, runs, results, artifacts, repo] = await Promise.all([
      this.db.q(
        `SELECT id, seq, key, title, role, kind, provider_key, status, attempt_count, max_attempts, cancel_requested,
                superseded_by, result, spec - 'failures' AS spec, created_at, started_at, finished_at
           FROM ai_tasks WHERE project_id = $1 ORDER BY seq, created_at`,
        [id],
      ),
      this.db.q(
        `SELECT d.task_id, d.depends_on_task_id FROM ai_task_dependencies d JOIN ai_tasks t ON t.id = d.task_id WHERE t.project_id = $1`,
        [id],
      ),
      this.db.q(`SELECT id, task_id, kind, title, detail, status, requested_at, decided_at FROM approvals WHERE project_id = $1 ORDER BY requested_at DESC LIMIT 50`, [id]),
      this.db.q(`SELECT id, task_id, attempt_no, status, git_commit, summary, created_at FROM test_runs WHERE project_id = $1 ORDER BY created_at DESC`, [id]),
      this.db.q(
        `SELECT r.test_run_id, r.ord, r.category, r.name, r.command, r.cwd, r.exit_code, r.status, r.duration_ms, r.log_tail
           FROM test_results r JOIN test_runs tr ON tr.id = r.test_run_id WHERE tr.project_id = $1 ORDER BY r.ord`,
        [id],
      ),
      this.db.q(`SELECT id, kind, filename, size, sha256, git_commit, created_at FROM build_artifacts WHERE project_id = $1 ORDER BY created_at DESC`, [id]),
      this.db.one('SELECT local_path, head_commit, default_branch FROM git_repositories WHERE project_id = $1', [id]),
    ]);
    return {
      project,
      repository: repo,
      tasks: tasks.map((t) => ({ ...t, depends_on: deps.filter((d) => d.task_id === t.id).map((d) => d.depends_on_task_id) })),
      approvals,
      testRuns: runs.map((r) => ({ ...r, results: results.filter((x) => x.test_run_id === r.id) })),
      artifacts,
    };
  }

  @Get('projects/:id/events')
  async events(
    @Req() req: any,
    @Param('id', uuid) id: string,
    @Query('afterId') afterId?: string,
    @Query('taskId') taskId?: string,
    @Query('tail') tail?: string,
  ) {
    const u: UserCtx = req.user;
    if (!(await this.db.one('SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2', [id, u.orgId])))
      throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
    const params: unknown[] = [id];
    let where = 'project_id = $1';
    if (taskId) {
      params.push(await uuid.transform(taskId, { type: 'query' }));
      where += ` AND task_id = $${params.length}`;
    }
    if (afterId && /^\d+$/.test(afterId)) {
      params.push(afterId);
      where += ` AND id > $${params.length}`;
    }
    const limit = Math.min(1000, Math.max(1, Number(tail) || 500));
    const rows =
      tail && !afterId
        ? (await this.db.q(`SELECT * FROM ai_execution_events WHERE ${where} ORDER BY id DESC LIMIT ${limit}`, params)).reverse()
        : await this.db.q(`SELECT * FROM ai_execution_events WHERE ${where} ORDER BY id LIMIT ${limit}`, params);
    return rows.map(toEvent);
  }

  @Post('projects/:id/cancel')
  cancel(@Req() req: any, @Param('id', uuid) id: string) {
    return this.pipeline.cancelProject(req.user, id, req.ip);
  }

  @Post('projects/:id/retry')
  retry(@Req() req: any, @Param('id', uuid) id: string) {
    return this.pipeline.retryProject(req.user, id, req.ip);
  }

  @Post('approvals/:id/decide')
  decide(@Req() req: any, @Param('id', uuid) id: string, @Body() body: unknown) {
    const { approve } = parse(z.object({ approve: z.boolean() }), body);
    return this.pipeline.decideApproval(req.user, id, approve, req.ip);
  }

  @Get('notifications')
  async notifications(@Req() req: any) {
    const u: UserCtx = req.user;
    return this.db.q(
      `SELECT id, project_id, type, title, body, read_at, created_at FROM notifications WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [u.orgId],
    );
  }

  @Post('notifications/read')
  async readAll(@Req() req: any) {
    await this.db.q('UPDATE notifications SET read_at = now() WHERE organization_id = $1 AND read_at IS NULL', [req.user.orgId]);
    return { ok: true };
  }

  // ── 설정: 역할별 AI 배정 ──

  @Get('settings')
  async settings(@Req() req: any) {
    const u: UserCtx = req.user;
    const [assignments, providers, metered] = await Promise.all([
      this.db.q('SELECT role, provider_key FROM ai_role_assignments WHERE organization_id = $1', [u.orgId]),
      this.db.q(
        `SELECT DISTINCT pr.key, pr.display_name FROM ai_providers pr JOIN desktop_agents a ON a.id = pr.agent_id
          WHERE a.organization_id = $1 AND a.revoked_at IS NULL AND pr.installed ORDER BY pr.key`,
        [u.orgId],
      ),
      this.db.one(`SELECT value FROM system_settings WHERE key = 'metered_api_enabled'`),
    ]);
    return {
      roleAssignments: Object.fromEntries(assignments.map((a) => [a.role, a.provider_key])),
      availableProviders: providers,
      meteredApiEnabled: metered?.value === true,
    };
  }

  @Put('settings/role-assignments')
  async setRoles(@Req() req: any, @Body() body: unknown) {
    const u: UserCtx = req.user;
    if (!['owner', 'admin'].includes(u.orgRole)) throw new ForbiddenException('관리자만 변경할 수 있습니다.');
    const { assignments } = parse(
      z.object({ assignments: z.record(z.string().regex(/^(\*|[a-z]{2,20})$/), z.string().regex(/^[a-z0-9-]{2,30}$/)) }),
      body,
    );
    await this.db.tx(async (q) => {
      for (const [role, key] of Object.entries(assignments))
        await q.q(
          `INSERT INTO ai_role_assignments (organization_id, role, provider_key) VALUES ($1,$2,$3)
           ON CONFLICT (organization_id, role) DO UPDATE SET provider_key = EXCLUDED.provider_key, updated_at = now()`,
          [u.orgId, role, key],
        );
      await audit(q, { orgId: u.orgId, userId: u.id, action: 'settings.role_assignments', detail: assignments, ip: req.ip });
    });
    return { ok: true };
  }

  // ── PC 연결 관리 ──

  @Get('agents')
  agents(@Req() req: any) {
    return this.agentList(req.user.orgId);
  }

  @Post('agents/pairing-code')
  async pairingCode(@Req() req: any) {
    const u: UserCtx = req.user;
    requireWriter(u);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(8);
    const raw = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const row = await this.db.one(
      `INSERT INTO agent_pairing_codes (organization_id, created_by, code_hash, expires_at)
       VALUES ($1,$2,$3, now() + interval '10 minutes') RETURNING expires_at`,
      [u.orgId, u.id, sha256(raw)],
    );
    await audit(this.db, { orgId: u.orgId, userId: u.id, action: 'agent.pairing_code', ip: req.ip });
    return { code, expiresAt: row.expires_at };
  }

  @Post('agents/:id/pause')
  async pause(@Req() req: any, @Param('id', uuid) id: string, @Body() body: unknown) {
    const u: UserCtx = req.user;
    requireWriter(u);
    const { paused } = parse(z.object({ paused: z.boolean() }), body);
    const row = await this.db.one('UPDATE desktop_agents SET paused = $3 WHERE id = $1 AND organization_id = $2 RETURNING id', [id, u.orgId, paused]);
    if (!row) throw new NotFoundException('PC를 찾을 수 없습니다.');
    await audit(this.db, { orgId: u.orgId, userId: u.id, action: paused ? 'agent.pause' : 'agent.resume', targetType: 'agent', targetId: id, ip: req.ip });
    return { ok: true };
  }

  @Delete('agents/:id')
  async revoke(@Req() req: any, @Param('id', uuid) id: string) {
    const u: UserCtx = req.user;
    if (!['owner', 'admin'].includes(u.orgRole)) throw new ForbiddenException('관리자만 PC 연결을 해제할 수 있습니다.');
    const row = await this.db.one(
      `UPDATE desktop_agents SET revoked_at = now(), status = 'offline' WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL RETURNING id`,
      [id, u.orgId],
    );
    if (!row) throw new NotFoundException('PC를 찾을 수 없습니다.');
    await audit(this.db, { orgId: u.orgId, userId: u.id, action: 'agent.revoke', targetType: 'agent', targetId: id, ip: req.ip });
    return { ok: true };
  }

  // ── 결과물 다운로드 링크 ──

  @Post('artifacts/:id/link')
  async link(@Req() req: any, @Param('id', uuid) id: string) {
    const u: UserCtx = req.user;
    const a = await this.db.one(
      `SELECT b.id FROM build_artifacts b JOIN projects p ON p.id = b.project_id WHERE b.id = $1 AND p.organization_id = $2`,
      [id, u.orgId],
    );
    if (!a) throw new NotFoundException('결과물을 찾을 수 없습니다.');
    await audit(this.db, { orgId: u.orgId, userId: u.id, action: 'artifact.download', targetType: 'artifact', targetId: id, ip: req.ip });
    return { url: `/api/download/${id}?token=${signToken({ typ: 'dl', aid: id }, 300)}` };
  }
}

// ═════════════════════════ 공개 엔드포인트 ═════════════════════════

const pairSchema = z.object({
  code: z.string().trim().min(8).max(12),
  name: z.string().trim().min(1).max(60),
  platform: z.string().max(60).optional(),
  engineVersion: z.string().max(40).optional(),
});

@Controller('api')
export class PublicController {
  private limiter = new RateLimiter(10, 10 * 60_000);
  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
  ) {}

  @Get('health')
  async health() {
    await this.db.one('SELECT 1');
    return { ok: true, service: 'eum-control-server', time: new Date().toISOString() };
  }

  /** PC 엔진 등록: 웹에서 발급한 일회용 연결 코드를 엔진 토큰으로 교환합니다. */
  @Post('agent/pair')
  async pair(@Body() body: unknown, @Req() req: any) {
    this.limiter.check(`pair:${req.ip}`);
    const input = parse(pairSchema, body);
    const raw = input.code.replace(/-/g, '').toUpperCase();
    const token = `eumag_${randomToken(32)}`;
    const out = await this.db.tx(async (q) => {
      const c = await q.one(
        `UPDATE agent_pairing_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING organization_id, created_by`,
        [sha256(raw)],
      );
      if (!c) throw new BadRequestException('연결 코드가 올바르지 않거나 만료되었습니다. 웹에서 새 코드를 발급하세요.');
      const a = await q.one(
        `INSERT INTO desktop_agents (organization_id, name, token_hash, platform, engine_version, status, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,'online', now()) RETURNING id`,
        [c.organization_id, input.name, sha256(token), input.platform ?? null, input.engineVersion ?? null],
      );
      const org = await q.one('SELECT name FROM organizations WHERE id = $1', [c.organization_id]);
      await audit(q, { orgId: c.organization_id, userId: c.created_by, agentId: a.id, action: 'agent.pair', detail: { name: input.name }, ip: req.ip });
      return { agentId: a.id as string, orgId: c.organization_id as string, organizationName: org.name as string };
    });
    this.hub.toOrg(out.orgId, { type: 'agents' });
    return { token, agentId: out.agentId, organizationName: out.organizationName };
  }

  @Get('download/:id')
  async download(@Param('id', uuid) id: string, @Query('token') token: string, @Res() res: any) {
    const p = verifyToken<{ typ: string; aid: string }>(String(token || ''));
    if (!p || p.typ !== 'dl' || p.aid !== id) throw new ForbiddenException('다운로드 링크가 만료되었습니다. 다시 시도하세요.');
    const a = await this.db.one('SELECT filename, size, storage_key FROM build_artifacts WHERE id = $1', [id]);
    const file = a && path.join(storageDir(), a.storage_key);
    if (!a || !file.startsWith(storageDir() + path.sep) || !fs.existsSync(file)) throw new NotFoundException('결과물 파일이 서버에 없습니다.');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(a.size));
    res.setHeader('Content-Disposition', `attachment; filename="download.zip"; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    fs.createReadStream(file).pipe(res);
  }
}

// ═════════════════════════ PC 엔진 전용 API ═════════════════════════

const providerSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{2,30}$/),
  displayName: z.string().max(60),
  installed: z.boolean(),
  authenticated: z.boolean(),
  version: z.string().max(80).nullable().optional(),
  capabilities: z.record(z.string(), z.boolean()).default({}),
  executionPolicy: z.record(z.string(), z.unknown()).default({}),
  usageStatus: z.record(z.string(), z.unknown()).default({}),
});
const agentHeartbeatSchema = z.object({
  platform: z.string().max(60).optional(),
  engineVersion: z.string().max(40).optional(),
  maxConcurrency: z.number().int().min(1).max(8).default(1),
  systemInfo: z.record(z.string(), z.unknown()).default({}),
  providers: z.array(providerSchema).max(20).default([]),
});
const eventsSchema = z.object({
  attemptNo: z.number().int().positive(),
  events: z
    .array(z.object({ seq: z.number().int().nonnegative(), type: z.string().max(40), message: z.string().max(20000), data: z.unknown().optional() }))
    .min(1)
    .max(500),
});

@Controller('api/agent')
@UseGuards(AgentGuard)
export class AgentApiController {
  constructor(
    private readonly db: Db,
    private readonly pipeline: Pipeline,
    private readonly hub: Hub,
  ) {}

  @Post('heartbeat')
  async heartbeat(@Req() req: any, @Body() body: unknown) {
    const agent: AgentCtx = req.agent;
    const input = parse(agentHeartbeatSchema, body);
    const row = await this.db.tx(async (q) => {
      const prev = await q.one('SELECT status FROM desktop_agents WHERE id = $1 FOR UPDATE', [agent.id]);
      const a = await q.one(
        `UPDATE desktop_agents SET status = 'online', last_seen_at = now(), platform = COALESCE($2, platform),
                engine_version = COALESCE($3, engine_version), max_concurrency = $4, system_info = $5
          WHERE id = $1 RETURNING paused`,
        [agent.id, input.platform ?? null, input.engineVersion ?? null, input.maxConcurrency, JSON.stringify(input.systemInfo)],
      );
      for (const p of input.providers) {
        const pr = await q.one(
          `INSERT INTO ai_providers (agent_id, key, display_name, installed, authenticated, version, execution_policy, usage_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (agent_id, key) DO UPDATE SET display_name = EXCLUDED.display_name, installed = EXCLUDED.installed,
             authenticated = EXCLUDED.authenticated, version = EXCLUDED.version, execution_policy = EXCLUDED.execution_policy,
             usage_status = EXCLUDED.usage_status, updated_at = now()
           RETURNING id`,
          [agent.id, p.key, p.displayName, p.installed, p.authenticated, p.version ?? null, JSON.stringify(p.executionPolicy), JSON.stringify(p.usageStatus)],
        );
        for (const [cap, supported] of Object.entries(p.capabilities))
          await q.q(
            `INSERT INTO ai_provider_capabilities (provider_id, capability, supported) VALUES ($1,$2,$3)
             ON CONFLICT (provider_id, capability) DO UPDATE SET supported = EXCLUDED.supported`,
            [pr.id, cap.slice(0, 60), supported],
          );
      }
      if (input.providers.length)
        await q.q('DELETE FROM ai_providers WHERE agent_id = $1 AND NOT (key = ANY($2::text[]))', [agent.id, input.providers.map((p) => p.key)]);
      return { paused: a.paused as boolean, changed: prev?.status !== 'online' || input.providers.length > 0 };
    });
    if (row.changed) this.hub.toOrg(agent.orgId, { type: 'agents' });
    return { paused: row.paused };
  }

  @Post('recover')
  recover(@Req() req: any) {
    return this.pipeline.recover(req.agent);
  }

  @Post('claim')
  async claim(@Req() req: any, @Body() body: unknown) {
    const { providers } = parse(z.object({ providers: z.array(z.string().max(30)).max(20).default([]) }), body);
    return (await this.pipeline.claim(req.agent, providers)) ?? { task: null };
  }

  @Post('tasks/:id/heartbeat')
  taskHeartbeat(@Req() req: any, @Param('id', uuid) id: string, @Body() body: unknown) {
    const { attemptNo } = parse(z.object({ attemptNo: z.number().int().positive() }), body);
    return this.pipeline.heartbeat(req.agent, id, attemptNo);
  }

  @Post('tasks/:id/events')
  events(@Req() req: any, @Param('id', uuid) id: string, @Body() body: unknown) {
    const input = parse(eventsSchema, body);
    return this.pipeline.appendEvents(req.agent, id, input.attemptNo, input.events);
  }

  @Post('tasks/:id/complete')
  complete(@Req() req: any, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.pipeline.complete(req.agent, id, parse(completeSchema, body));
  }

  /** 결과물 업로드. 서버가 직접 SHA-256 을 계산해 엔진이 보고한 값과 대조합니다. */
  @Post('tasks/:id/artifacts')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = path.join(storageDir(), 'tmp');
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomToken(8)}.upload`),
      }),
      limits: { fileSize: Number(process.env.MAX_ARTIFACT_MB || 500) * 1024 * 1024, files: 1 },
    }),
  )
  async upload(@Req() req: any, @Param('id', uuid) id: string, @UploadedFile() file: Express.Multer.File, @Body() body: any) {
    const agent: AgentCtx = req.agent;
    if (!file) throw new BadRequestException('파일이 없습니다.');
    try {
      const meta = parse(
        z.object({
          attemptNo: z.coerce.number().int().positive(),
          kind: z.enum(['source_zip']),
          filename: z.string().min(1).max(200),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          gitCommit: z.string().max(80).optional(),
        }),
        body,
      );
      const t = await this.db.one(
        `SELECT id, project_id FROM ai_tasks WHERE id = $1 AND kind = 'package' AND status = 'running' AND lease_agent_id = $2 AND attempt_count = $3`,
        [id, agent.id, meta.attemptNo],
      );
      if (!t) throw new ForbiddenException('이 작업에 결과물을 올릴 권한이 없습니다.');
      const actual = await new Promise<string>((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file.path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
      });
      if (actual !== meta.sha256) throw new BadRequestException('업로드된 파일의 해시가 엔진이 보고한 값과 다릅니다.');
      const key = path.join(t.project_id, `${actual}.zip`);
      const dest = path.join(storageDir(), key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(file.path, dest);
      const filename = meta.filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
      const art = await this.db.tx(async (q) => {
        let job = await q.one(`SELECT id FROM build_jobs WHERE task_id = $1 AND status = 'running'`, [t.id]);
        if (!job)
          job = await q.one(`INSERT INTO build_jobs (project_id, task_id, kind, git_commit) VALUES ($1,$2,$3,$4) RETURNING id`, [
            t.project_id,
            t.id,
            meta.kind,
            meta.gitCommit ?? null,
          ]);
        // 같은 내용(해시)의 결과물은 한 번만 기록합니다.
        return q.one(
          `INSERT INTO build_artifacts (build_job_id, project_id, task_id, kind, filename, size, sha256, storage_key, git_commit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (project_id, kind, sha256) DO UPDATE SET task_id = EXCLUDED.task_id, build_job_id = EXCLUDED.build_job_id
           RETURNING id, sha256, size`,
          [job.id, t.project_id, t.id, meta.kind, filename, file.size, actual, key, meta.gitCommit ?? null],
        );
      });
      await audit(this.db, { orgId: agent.orgId, agentId: agent.id, action: 'artifact.upload', targetType: 'artifact', targetId: art.id, detail: { sha256: actual, size: file.size } });
      return { id: art.id, sha256: actual, size: Number(art.size) };
    } finally {
      fs.rm(file.path, { force: true }, () => undefined);
    }
  }
}
