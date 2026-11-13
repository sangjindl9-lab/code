import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AgentCtx, parse, requireWriter, UserCtx } from './auth';
import { audit, Db, Q } from './db';
import {
  devPrompt,
  FailureInfo,
  fixPrompt,
  implementAllPrompt,
  PLAN_REQUIRED_FILES,
  planPrompt,
  ProjectBrief,
} from './prompts';
import { Hub } from './realtime';

type After = Array<() => void>;

export const VERIFY_CATEGORIES = ['typecheck', 'lint', 'test', 'build'];
const DEV_ROLES = ['designer', 'backend', 'frontend', 'database', 'devops'];

const tasksJsonSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(40),
        title: z.string().trim().min(1).max(200),
        role: z.string().optional(),
        description: z.string().max(8000).default(''),
        dependsOn: z.array(z.string()).default([]),
        targetFiles: z.array(z.string().max(300)).max(100).default([]),
        doneWhen: z.string().max(4000).default(''),
        testWhen: z.string().max(4000).default(''),
      }),
    )
    .min(1)
    .max(15),
});
type PlannedTask = z.infer<typeof tasksJsonSchema>['tasks'][number];

/** TASKS.json 을 검증합니다. 형식 오류·알 수 없는 의존성·순환 의존이 있으면 사유를 반환합니다. */
export function parseTasksJson(text: string | undefined): { tasks?: PlannedTask[]; error?: string } {
  if (!text) return { error: 'TASKS.json 내용이 전달되지 않았습니다.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e: any) {
    return { error: `JSON 형식 오류: ${e.message}` };
  }
  const r = tasksJsonSchema.safeParse(raw);
  if (!r.success) return { error: `형식 오류: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}` };
  const tasks = r.data.tasks;
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) return { error: `작업 ID 중복: ${t.id}` };
    ids.add(t.id);
  }
  for (const t of tasks)
    for (const d of t.dependsOn) {
      if (!ids.has(d)) return { error: `알 수 없는 선행 작업: ${t.id} → ${d}` };
      if (d === t.id) return { error: `자기 자신에 의존: ${t.id}` };
    }
  // 순환 의존 검사 (위상 정렬)
  const indeg = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const t of tasks)
      if (t.dependsOn.includes(id)) {
        indeg.set(t.id, indeg.get(t.id)! - 1);
        if (indeg.get(t.id) === 0) queue.push(t.id);
      }
  }
  if (seen !== tasks.length) return { error: '작업 간 순환 의존이 있습니다.' };
  return { tasks };
}

export const completeSchema = z.object({
  attemptNo: z.number().int().positive(),
  exitCode: z.number().int().nullable().default(null),
  error: z.string().max(20000).optional(),
  /** 구독 사용량 한도 등: 이 초가 지난 뒤 다시 시도 (시도 횟수를 소모하지 않음) */
  retryAfterSec: z.number().int().min(0).max(86400).optional(),
  cancelled: z.boolean().optional(),
  gitBefore: z.string().max(80).optional(),
  gitAfter: z.string().max(80).optional(),
  workspacePath: z.string().max(1000).optional(),
  changedFiles: z.array(z.string().max(1000)).max(5000).default([]),
  files: z.record(z.string(), z.object({ exists: z.boolean(), content: z.string().max(400_000).optional() })).default({}),
  tests: z
    .array(
      z.object({
        category: z.string().max(40),
        name: z.string().max(200),
        command: z.string().max(1000),
        cwd: z.string().max(1000).default('.'),
        exitCode: z.number().int().nullable(),
        status: z.enum(['passed', 'failed', 'skipped']),
        durationMs: z.number().int().nonnegative().default(0),
        logTail: z.string().max(40000).default(''),
      }),
    )
    .max(200)
    .default([]),
});
export type CompleteBody = z.infer<typeof completeSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, '프로젝트명을 입력하세요').max(100),
  description: z.string().trim().min(10, '프로그램 설명을 10자 이상 입력하세요').max(20000),
  kind: z.enum(['web', 'pc', 'android', 'api', 'integrated']),
  platforms: z.array(z.string().max(40)).max(10).default([]),
  referenceUrls: z.array(z.string().url().max(500)).max(10).default([]),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  automationMode: z.enum(['manual', 'semi', 'auto']).default('semi'),
  /** true: TASKS.json 의 작업마다 별도 AI 세션(큰 프로젝트용). false(기본): 한 세션에서 전체 구현 */
  splitTasks: z.boolean().default(false),
});

const clean = (s: string) => s.replace(/\u0000/g, '');

@Injectable()
export class Pipeline {
  readonly leaseSec = Math.max(5, Number(process.env.LEASE_SEC || 60));

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
  ) {}

  // ───────────────────────── 공통 ─────────────────────────

  private async providerFor(q: Q, orgId: string, role: string): Promise<string> {
    const row = await q.one('SELECT provider_key FROM ai_role_assignments WHERE organization_id = $1 AND role = $2', [
      orgId,
      role,
    ]);
    if (row) return row.provider_key;
    const def = await q.one(`SELECT provider_key FROM ai_role_assignments WHERE organization_id = $1 AND role = '*'`, [
      orgId,
    ]);
    return def?.provider_key || 'codex';
  }

  private async brief(q: Q, projectId: string): Promise<ProjectBrief & { orgId: string; maxFix: number; mode: string; status: string; splitTasks: boolean }> {
    const p = await q.one('SELECT * FROM projects WHERE id = $1', [projectId]);
    return {
      name: p.name,
      description: p.description,
      kind: p.kind,
      platforms: p.platforms,
      referenceUrls: p.reference_urls,
      orgId: p.organization_id,
      maxFix: p.max_fix_attempts,
      mode: p.automation_mode,
      splitTasks: p.split_tasks === true,
      status: p.status,
    };
  }

  private async notify(q: Q, after: After, orgId: string, projectId: string, type: string, title: string, body = '') {
    await q.q('INSERT INTO notifications (organization_id, project_id, type, title, body) VALUES ($1,$2,$3,$4,$5)', [
      orgId,
      projectId,
      type,
      title,
      body,
    ]);
    after.push(() => this.hub.toOrg(orgId, { type: 'notification', projectId, kind: type, title, body }));
  }

  private ping(after: After, orgId: string, projectId: string) {
    after.push(() => {
      this.hub.toProject(projectId, { type: 'project', projectId });
      this.hub.toOrg(orgId, { type: 'project', projectId });
    });
  }

  private async insertTask(
    q: Q,
    t: {
      projectId: string;
      seq: number;
      key: string;
      title: string;
      role: string;
      kind: 'ai' | 'verify' | 'package';
      providerKey?: string | null;
      prompt?: string | null;
      spec?: unknown;
      timeoutSec: number;
      maxAttempts?: number;
      dependsOn: string[];
    },
  ): Promise<string> {
    const row = await q.one(
      `INSERT INTO ai_tasks (project_id, seq, key, title, role, kind, provider_key, prompt, spec, timeout_sec, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        t.projectId,
        t.seq,
        t.key,
        t.title,
        t.role,
        t.kind,
        t.providerKey ?? null,
        t.prompt ?? null,
        JSON.stringify(t.spec ?? {}),
        t.timeoutSec,
        t.maxAttempts ?? 3,
      ],
    );
    for (const d of t.dependsOn)
      await q.q('INSERT INTO ai_task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2)', [row.id, d]);
    return row.id;
  }

  // ───────────────────────── 프로젝트 생성 ─────────────────────────

  async createProject(user: UserCtx, raw: unknown, ip?: string): Promise<{ id: string }> {
    requireWriter(user);
    const input = parse(createProjectSchema, raw);
    const after: After = [];
    const id = await this.db.tx(async (q) => {
      const p = await q.one(
        `INSERT INTO projects (organization_id, created_by, name, description, kind, platforms, reference_urls, priority, automation_mode, split_tasks, max_fix_attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           COALESCE((SELECT (value #>> '{}')::int FROM system_settings WHERE key = 'default_max_fix_attempts'), 3))
         RETURNING id`,
        [
          user.orgId,
          user.id,
          input.name,
          input.description,
          input.kind,
          input.platforms,
          input.referenceUrls,
          input.priority,
          input.automationMode,
          input.splitTasks,
        ],
      );
      await q.q(`INSERT INTO project_requirements (project_id, source_type, content) VALUES ($1,'text',$2)`, [
        p.id,
        input.description,
      ]);
      await q.q('INSERT INTO git_repositories (project_id) VALUES ($1)', [p.id]);
      const b: ProjectBrief = { ...input };
      const plan = await this.insertTask(q, {
        projectId: p.id,
        seq: 10,
        key: 'plan',
        title: '요구사항 분석 및 기획',
        role: 'planner',
        kind: 'ai',
        providerKey: await this.providerFor(q, user.orgId, 'planner'),
        prompt: planPrompt(b),
        spec: { requiredFiles: PLAN_REQUIRED_FILES, collectFiles: ['docs/TASKS.json'], requireChanges: true },
        timeoutSec: 1800,
        dependsOn: [],
      });
      const impl = await this.insertTask(q, {
        projectId: p.id,
        seq: 100,
        key: 'implement',
        title: '프로그램 구현',
        role: 'backend',
        kind: 'ai',
        providerKey: await this.providerFor(q, user.orgId, 'backend'),
        prompt: implementAllPrompt(b),
        spec: { requireChanges: true, placeholder: true },
        timeoutSec: 3 * 3600,
        dependsOn: [plan],
      });
      const verify = await this.insertTask(q, {
        projectId: p.id,
        seq: 1000,
        key: 'verify-1',
        title: '자동 테스트 및 빌드 검증',
        role: 'reviewer',
        kind: 'verify',
        timeoutSec: 1800,
        maxAttempts: 2,
        dependsOn: [impl],
      });
      await this.insertTask(q, {
        projectId: p.id,
        seq: 9999,
        key: 'package',
        title: '소스코드 ZIP 패키징',
        role: 'devops',
        kind: 'package',
        timeoutSec: 600,
        dependsOn: [verify],
      });
      await audit(q, { orgId: user.orgId, userId: user.id, action: 'project.create', targetType: 'project', targetId: p.id, ip });
      await this.advance(q, p.id, after);
      return p.id as string;
    });
    after.forEach((f) => f());
    return { id };
  }

  // ───────────────────────── 상태 전이 ─────────────────────────

  /** 선행 작업이 끝난 작업을 대기열에 올리고, 프로젝트 상태를 다시 계산합니다. */
  async advance(q: Q, projectId: string, after: After) {
    const p = await this.brief(q, projectId);
    if (p.status === 'cancelled' || p.status === 'completed') return;
    const ready = await q.q(
      `SELECT t.id, t.kind, t.title FROM ai_tasks t
        WHERE t.project_id = $1 AND t.status = 'blocked'
          AND NOT EXISTS (SELECT 1 FROM ai_task_dependencies d JOIN ai_tasks dt ON dt.id = d.depends_on_task_id
                           WHERE d.task_id = t.id AND dt.status <> 'succeeded')`,
      [projectId],
    );
    for (const t of ready) {
      if (p.mode === 'manual' && t.kind === 'ai') {
        await q.q(`UPDATE ai_tasks SET status = 'awaiting_approval' WHERE id = $1`, [t.id]);
        await q.q(
          `INSERT INTO approvals (project_id, task_id, kind, title, detail) VALUES ($1,$2,'task',$3,$4)`,
          [projectId, t.id, `작업 실행 승인: ${t.title}`, 'AI가 이 작업을 실행하려고 합니다. 승인하면 PC 엔진이 작업을 시작합니다.'],
        );
        await this.notify(q, after, p.orgId, projectId, 'approval', `[${p.name}] 승인 요청`, t.title);
      } else {
        await q.q(`UPDATE ai_tasks SET status = 'queued' WHERE id = $1`, [t.id]);
      }
    }
    const s = await q.one(
      `SELECT count(*) FILTER (WHERE status = 'failed' AND superseded_by IS NULL)::int AS failed,
              count(*) FILTER (WHERE status = 'awaiting_approval')::int AS waiting,
              count(*) FILTER (WHERE status IN ('queued','running'))::int AS active,
              count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM ai_tasks WHERE project_id = $1`,
      [projectId],
    );
    let next: string;
    if (s.failed > 0) next = 'failed';
    else if (s.waiting + s.active + s.blocked + s.cancelled === 0) next = 'review';
    else if (s.waiting > 0 && s.active === 0) next = 'awaiting_approval';
    else next = 'running';
    if (next !== p.status) {
      await q.q('UPDATE projects SET status = $2, updated_at = now() WHERE id = $1', [projectId, next]);
      if (next === 'failed') {
        await this.notify(q, after, p.orgId, projectId, 'failed', `[${p.name}] 제작 실패`, '실패 사유를 확인한 뒤 다시 시도할 수 있습니다.');
      }
      if (next === 'review') {
        const has = await q.one(`SELECT 1 FROM approvals WHERE project_id = $1 AND kind = 'final' AND status = 'pending'`, [projectId]);
        if (!has)
          await q.q(
            `INSERT INTO approvals (project_id, kind, title, detail) VALUES ($1,'final',$2,$3)`,
            [projectId, '최종 결과물 승인', '테스트 결과와 결과물을 확인한 뒤 승인하세요. 승인 전에는 외부에 배포되지 않습니다.'],
          );
        await this.notify(q, after, p.orgId, projectId, 'review', `[${p.name}] 제작 완료 — 승인 대기`, '테스트를 통과했고 결과물이 준비되었습니다.');
      }
    } else {
      await q.q('UPDATE projects SET updated_at = now() WHERE id = $1', [projectId]);
    }
    this.ping(after, p.orgId, projectId);
  }

  // ───────────────────────── PC 엔진: 작업 임대 ─────────────────────────

  async claim(agent: AgentCtx, providers: string[]) {
    const after: After = [];
    const out = await this.db.tx(async (q) => {
      const a = await q.one('SELECT paused FROM desktop_agents WHERE id = $1 AND revoked_at IS NULL', [agent.id]);
      if (!a || a.paused) return null;
      // 이 PC 에서 한도에 걸린 AI 도구가 맡고 있는 대기 작업은, 쓸 수 있는 다른 도구로 넘깁니다.
      const limited = await q.q(
        `SELECT key FROM ai_providers WHERE agent_id = $1 AND limited_until > now()`,
        [agent.id],
      );
      for (const { key } of limited as any[]) {
        const alt = await this.fallbackProvider(q, agent.id, key);
        if (!alt || !providers.includes(alt)) continue;
        await q.q(
          `UPDATE ai_tasks t SET provider_key = $3, not_before = NULL, result = COALESCE(t.result, '{}'::jsonb) || jsonb_build_object('switchedFrom', $4::text, 'switchedTo', $3::text)
             FROM projects p WHERE p.id = t.project_id AND p.organization_id = $1 AND (p.agent_id IS NULL OR p.agent_id = $2)
              AND t.status = 'queued' AND t.kind = 'ai' AND t.provider_key = $4`,
          [agent.orgId, agent.id, alt, key],
        );
      }
      const cand = await q.one(
        `SELECT t.id, t.project_id FROM ai_tasks t JOIN projects p ON p.id = t.project_id
          WHERE p.organization_id = $1 AND p.status = 'running' AND t.status = 'queued'
            AND (t.not_before IS NULL OR t.not_before <= now())
            AND (p.agent_id IS NULL OR p.agent_id = $2)
            AND (t.kind <> 'ai' OR t.provider_key = ANY($3::text[]))
            AND NOT EXISTS (SELECT 1 FROM ai_tasks r WHERE r.project_id = t.project_id AND r.status = 'running')
          ORDER BY CASE p.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.priority DESC, t.seq, t.created_at
          LIMIT 1 FOR UPDATE OF t, p SKIP LOCKED`,
        [agent.orgId, agent.id, providers],
      );
      if (!cand) return null;
      // 프로젝트 행 잠금을 잡은 뒤 새 스냅샷으로 다시 확인 (같은 프로젝트의 동시 실행 방지)
      if (await q.one(`SELECT 1 FROM ai_tasks WHERE project_id = $1 AND status = 'running'`, [cand.project_id])) return null;
      const t = await q.one(
        `UPDATE ai_tasks SET status = 'running', attempt_count = attempt_count + 1, lease_agent_id = $2,
                lease_expires_at = now() + make_interval(secs => $3), cancel_requested = false,
                started_at = COALESCE(started_at, now()), finished_at = NULL
          WHERE id = $1 RETURNING *`,
        [cand.id, agent.id, this.leaseSec],
      );
      await q.q(`INSERT INTO ai_task_attempts (task_id, attempt_no, agent_id) VALUES ($1,$2,$3)`, [t.id, t.attempt_count, agent.id]);
      const p = await q.one(
        `UPDATE projects SET agent_id = COALESCE(agent_id, $2), updated_at = now() WHERE id = $1 RETURNING id, name, kind, organization_id`,
        [t.project_id, agent.id],
      );
      await q.q('UPDATE git_repositories SET agent_id = $2 WHERE project_id = $1 AND agent_id IS NULL', [t.project_id, agent.id]);
      this.ping(after, p.organization_id, p.id);
      return {
        task: {
          id: t.id,
          key: t.key,
          title: t.title,
          role: t.role,
          kind: t.kind,
          providerKey: t.provider_key,
          prompt: t.prompt,
          spec: t.spec,
          attemptNo: t.attempt_count,
          timeoutSec: t.timeout_sec,
          leaseSec: this.leaseSec,
        },
        project: { id: p.id, name: p.name, kind: p.kind },
      };
    });
    after.forEach((f) => f());
    return out;
  }

  async heartbeat(agent: AgentCtx, taskId: string, attemptNo: number) {
    const row = await this.db.one(
      `UPDATE ai_tasks SET lease_expires_at = now() + make_interval(secs => $4)
        WHERE id = $1 AND status = 'running' AND lease_agent_id = $2 AND attempt_count = $3
        RETURNING cancel_requested`,
      [taskId, agent.id, attemptNo, this.leaseSec],
    );
    if (!row) return { lost: true, cancel: true };
    return { lost: false, cancel: row.cancel_requested as boolean };
  }

  async appendEvents(
    agent: AgentCtx,
    taskId: string,
    attemptNo: number,
    events: Array<{ seq: number; type: string; message: string; data?: unknown }>,
  ) {
    const at = await this.db.one(
      `SELECT t.project_id FROM ai_task_attempts a JOIN ai_tasks t ON t.id = a.task_id
        WHERE a.task_id = $1 AND a.attempt_no = $2 AND a.agent_id = $3`,
      [taskId, attemptNo, agent.id],
    );
    if (!at) throw new NotFoundException('해당 작업 시도를 찾을 수 없습니다.');
    const payload = events.map((e) => ({
      seq: e.seq,
      type: e.type.slice(0, 40),
      message: clean(e.message).slice(0, 8000),
      data: e.data ?? null,
    }));
    const rows = await this.db.q(
      `INSERT INTO ai_execution_events (project_id, task_id, attempt_no, seq, type, message, data)
       SELECT $1, $2, $3, e.seq, e.type, e.message, e.data
         FROM jsonb_to_recordset($4::jsonb) AS e(seq int, type text, message text, data jsonb)
       ON CONFLICT (task_id, attempt_no, seq) DO NOTHING
       RETURNING id, task_id, attempt_no, seq, type, message, data, created_at`,
      [at.project_id, taskId, attemptNo, clean(JSON.stringify(payload))],
    );
    rows.sort((a, b) => a.seq - b.seq);
    for (const r of rows) this.hub.toProject(at.project_id, { type: 'event', event: toEvent(r) });
    return { stored: rows.length };
  }

  // ───────────────────────── PC 엔진: 완료 보고와 판정 ─────────────────────────

  /**
   * 엔진이 보고한 "사실"(종료 코드, 변경 파일, 테스트 명령 결과, 업로드된 결과물)로 서버가 성공 여부를 판정합니다.
   * AI 가 "완료했다"고 응답한 것만으로는 성공 처리하지 않습니다.
   */
  async complete(agent: AgentCtx, taskId: string, body: CompleteBody) {
    const after: After = [];
    const out = await this.db.tx(async (q) => {
      const t = await q.one('SELECT * FROM ai_tasks WHERE id = $1 FOR UPDATE', [taskId]);
      if (!t) throw new NotFoundException('작업을 찾을 수 없습니다.');
      if (t.status !== 'running' || t.lease_agent_id !== agent.id || t.attempt_count !== body.attemptNo) {
        return { accepted: false, reason: '이미 처리되었거나 임대가 만료된 작업입니다.' };
      }
      const p = await this.brief(q, t.project_id);
      if (body.workspacePath || body.gitAfter) {
        await q.q(
          `UPDATE git_repositories SET local_path = COALESCE($2, local_path), head_commit = COALESCE($3, head_commit), updated_at = now() WHERE project_id = $1`,
          [t.project_id, body.workspacePath ?? null, body.gitAfter ?? null],
        );
      }

      let ok = false;
      let reason = '';
      let switchedTo: string | undefined;
      const cancelled = body.cancelled || t.cancel_requested;

      if (cancelled) {
        reason = '사용자가 작업을 취소했습니다.';
      } else if (t.kind === 'ai') {
        const required: string[] = t.spec?.requiredFiles || [];
        const missing = required.filter((f) => !body.files[f]?.exists);
        const needChanges = t.spec?.requireChanges !== false; // 모든 AI 작업은 실제 변경이 있어야 통과 (빈손 '완료' 차단)
        if (body.exitCode !== 0) reason = body.error || `AI 도구가 오류로 종료되었습니다. (종료 코드 ${body.exitCode})`;
        else if (missing.length) reason = `필수 산출물이 생성되지 않았습니다: ${missing.join(', ')}`;
        else if (needChanges && body.changedFiles.length === 0) reason = 'AI는 완료했다고 응답했지만 실제로 변경된 파일이 없습니다.';
        else ok = true;
      } else if (t.kind === 'verify') {
        const run = await q.one(
          `INSERT INTO test_runs (project_id, task_id, attempt_no, status, git_commit, summary)
           VALUES ($1,$2,$3,'unverified',$4,'{}') ON CONFLICT (task_id, attempt_no) DO NOTHING RETURNING id`,
          [t.project_id, t.id, body.attemptNo, body.gitAfter ?? body.gitBefore ?? null],
        );
        const real = body.tests.filter((r) => VERIFY_CATEGORIES.includes(r.category) && r.status !== 'skipped');
        const failed = body.tests.filter((r) => r.status === 'failed');
        if (body.exitCode !== 0 && body.tests.length === 0) reason = body.error || '검증을 실행하지 못했습니다.';
        else if (failed.length) reason = `검증 실패: ${failed.map((f) => f.name).join(', ')}`;
        else if (real.length === 0) reason = '실행할 수 있는 자동 테스트·빌드 명령이 없어 검증되지 않았습니다.';
        else ok = true;
        if (run) {
          let i = 0;
          for (const r of body.tests)
            await q.q(
              `INSERT INTO test_results (test_run_id, ord, category, name, command, cwd, exit_code, status, duration_ms, log_tail)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [run.id, i++, r.category, r.name, r.command, r.cwd, r.exitCode, r.status, r.durationMs, clean(r.logTail)],
            );
          await q.q('UPDATE test_runs SET status = $2, summary = $3 WHERE id = $1', [
            run.id,
            ok ? 'passed' : failed.length ? 'failed' : 'unverified',
            JSON.stringify({
              total: body.tests.length,
              passed: body.tests.filter((r) => r.status === 'passed').length,
              failed: failed.length,
              skipped: body.tests.filter((r) => r.status === 'skipped').length,
            }),
          ]);
        }
      } else if (t.kind === 'package') {
        const art = await q.one('SELECT 1 FROM build_artifacts WHERE task_id = $1 LIMIT 1', [t.id]);
        if (body.exitCode !== 0) reason = body.error || '패키징에 실패했습니다.';
        else if (!art) reason = '결과물 파일이 서버에 업로드되지 않았습니다.';
        else ok = true;
        await q.q(`UPDATE build_jobs SET status = $2, finished_at = now() WHERE task_id = $1 AND status = 'running'`, [
          t.id,
          ok ? 'succeeded' : 'failed',
        ]);
      }

      await q.q(
        `UPDATE ai_task_attempts SET status = $3, exit_code = $4, error = $5, git_before = $6, git_after = $7,
                changed_files = $8, finished_at = now() WHERE task_id = $1 AND attempt_no = $2`,
        [
          t.id,
          body.attemptNo,
          cancelled ? 'cancelled' : ok ? 'succeeded' : 'failed',
          body.exitCode,
          ok ? null : clean(reason).slice(0, 20000),
          body.gitBefore ?? null,
          body.gitAfter ?? null,
          JSON.stringify(body.changedFiles.slice(0, 2000)),
        ],
      );

      const finish = (status: string, extra: Record<string, unknown> = {}) =>
        q.q(
          `UPDATE ai_tasks SET status = $2, result = $3, lease_agent_id = NULL, lease_expires_at = NULL,
                  finished_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END WHERE id = $1`,
          [t.id, status, JSON.stringify({ reason, changedFiles: body.changedFiles.length, ...extra })],
        );

      if (cancelled) {
        await finish('cancelled');
      } else if (ok) {
        await finish('succeeded');
        if (t.key === 'plan') await this.expandPlan(q, after, t, p, body.files['docs/TASKS.json']?.content);
      } else if (t.kind === 'verify' && (body.tests.length > 0 || body.exitCode === 0)) {
        await this.onVerifyFailed(q, after, t, p, body);
      } else if (t.kind === 'ai' && body.retryAfterSec) {
        // 구독 사용량 한도: 시도 횟수를 소모하지 않습니다. 같은 PC 에 쓸 수 있는 다른 AI 도구가 있으면 즉시 넘기고, 없으면 초기화 시각까지 보류합니다.
        const sec = Math.max(60, body.retryAfterSec);
        const resumeAt = new Date(Date.now() + sec * 1000);
        await q.q(`UPDATE ai_providers SET limited_until = now() + make_interval(secs => $3) WHERE agent_id = $1 AND key = $2`, [agent.id, t.provider_key, sec]);
        const alt = await this.fallbackProvider(q, agent.id, t.provider_key);
        if (alt) {
          switchedTo = alt;
          await finish('queued', { retrying: true, switchedFrom: t.provider_key, switchedTo: alt });
          await q.q(`UPDATE ai_tasks SET max_attempts = max_attempts + 1, provider_key = $2, not_before = NULL WHERE id = $1`, [t.id, alt]);
          await this.notify(q, after, p.orgId, t.project_id, 'info', `[${p.name}] AI 도구 전환`, `${t.provider_key} 사용량 한도에 도달해 ${t.title} 작업을 ${alt} 로 넘겨 계속 진행합니다.`);
        } else {
          await finish('queued', { retrying: true, rateLimited: true, resumeAt: resumeAt.toISOString() });
          await q.q(`UPDATE ai_tasks SET max_attempts = max_attempts + 1, not_before = now() + make_interval(secs => $2) WHERE id = $1`, [t.id, sec]);
          const when = resumeAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: true });
          await this.notify(q, after, p.orgId, t.project_id, 'warning', `[${p.name}] AI 사용량 한도 도달`, `${t.title}: ${reason.slice(0, 300)}\n대신 쓸 수 있는 다른 AI 도구가 없어 ${when} 이후 자동으로 다시 시작합니다.`);
        }
      } else if (t.attempt_count < t.max_attempts) {
        await finish('queued', { retrying: true });
      } else {
        await finish('failed');
      }
      await this.advance(q, t.project_id, after);
      return { accepted: true, ok, reason, switchedTo };
    });
    after.forEach((f) => f());
    return out;
  }

  /** 같은 PC 에서 지금 쓸 수 있는(설치·로그인·정책 허용·한도 아님) 다른 AI 도구. 코드 작업 적합도 순으로 고릅니다. */
  private async fallbackProvider(q: Q, agentId: string, except: string): Promise<string | undefined> {
    const rows = await q.q(
      `SELECT key FROM ai_providers WHERE agent_id = $1 AND key <> $2 AND key <> 'mock' AND installed AND authenticated
          AND (execution_policy->>'allowed') = 'true' AND (limited_until IS NULL OR limited_until <= now())`,
      [agentId, except],
    );
    const order = ['claude', 'codex', 'antigravity'];
    const keys = rows.map((r: any) => r.key as string).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    return keys[0];
  }

  /** 기획 결과(TASKS.json)를 실제 개발 작업으로 분할합니다. 형식이 잘못되면 단일 구현 작업으로 진행합니다. */
  private async expandPlan(q: Q, after: After, planTask: any, p: Awaited<ReturnType<Pipeline['brief']>>, text?: string) {
    if (!p.splitTasks) return; // 기본: 한 세션에서 전체 구현 (TASKS.json 은 구현 세션이 체크리스트로 사용)
    const parsed = parseTasksJson(text);
    if (!parsed.tasks) {
      await this.notify(q, after, p.orgId, planTask.project_id, 'info', `[${p.name}] 작업 분할 생략`, `TASKS.json 을 사용할 수 없어 단일 구현 작업으로 진행합니다. (${parsed.error})`);
      return;
    }
    const placeholder = await q.one(`SELECT id FROM ai_tasks WHERE project_id = $1 AND key = 'implement' AND status = 'blocked'`, [
      planTask.project_id,
    ]);
    const verify = await q.one(`SELECT id FROM ai_tasks WHERE project_id = $1 AND key = 'verify-1'`, [planTask.project_id]);
    if (!placeholder || !verify) return;
    await q.q('DELETE FROM ai_tasks WHERE id = $1', [placeholder.id]);
    const idMap = new Map<string, string>();
    const pending = [...parsed.tasks];
    let n = 0;
    // 선행 작업이 먼저 삽입되도록 위상 순서로 생성
    while (pending.length) {
      const i = pending.findIndex((t) => t.dependsOn.every((d) => idMap.has(d)));
      const t = pending.splice(i, 1)[0];
      n++;
      const role = DEV_ROLES.includes(t.role || '') ? t.role! : 'backend';
      const id = await this.insertTask(q, {
        projectId: planTask.project_id,
        seq: 100 + n,
        key: `dev-${n}`,
        title: t.title,
        role,
        kind: 'ai',
        providerKey: await this.providerFor(q, p.orgId, role),
        prompt: devPrompt(p, t, n, parsed.tasks.length),
        spec: { planId: t.id, targetFiles: t.targetFiles, doneWhen: t.doneWhen, testWhen: t.testWhen, requireChanges: true },
        timeoutSec: 3600,
        dependsOn: t.dependsOn.length ? t.dependsOn.map((d) => idMap.get(d)!) : [planTask.id],
      });
      idMap.set(t.id, id);
      await q.q('INSERT INTO ai_task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2)', [verify.id, id]);
    }
    const ver = await q.one(`SELECT COALESCE(max(version),0)+1 AS v FROM project_versions WHERE project_id = $1 AND kind = 'tasks'`, [
      planTask.project_id,
    ]);
    await q.q(`INSERT INTO project_versions (project_id, version, kind, content) VALUES ($1,$2,'tasks',$3)`, [
      planTask.project_id,
      ver.v,
      JSON.stringify({ tasks: parsed.tasks }),
    ]);
  }

  /** 검증 실패 시 실패 정보를 담은 수정 작업과 재검증 작업을 만듭니다. 한도를 넘으면 실패로 확정하고 사용자에게 보고합니다. */
  private async onVerifyFailed(q: Q, after: After, t: any, p: Awaited<ReturnType<Pipeline['brief']>>, body: CompleteBody) {
    const fixCount = (await q.one(`SELECT count(*)::int AS n FROM ai_tasks WHERE project_id = $1 AND key LIKE 'fix-%'`, [t.project_id])).n;
    const failures: FailureInfo[] = body.tests.filter((r) => r.status === 'failed');
    const result = { reason: failures.length ? `검증 실패: ${failures.map((f) => f.name).join(', ')}` : '검증 가능한 테스트 없음' };
    if (fixCount >= p.maxFix) {
      await q.q(
        `UPDATE ai_tasks SET status = 'failed', result = $2, lease_agent_id = NULL, lease_expires_at = NULL, finished_at = now() WHERE id = $1`,
        [t.id, JSON.stringify({ ...result, exhausted: true, reason: `${result.reason} — 자동 수정 ${p.maxFix}회를 모두 사용했습니다.` })],
      );
      return;
    }
    const round = fixCount + 1;
    const fix = await this.insertTask(q, {
      projectId: t.project_id,
      seq: 1000 + round * 10,
      key: `fix-${round}`,
      title: `오류 자동 수정 (${round}/${p.maxFix})`,
      role: 'fixer',
      kind: 'ai',
      providerKey: await this.providerFor(q, p.orgId, 'fixer'),
      prompt: fixPrompt(p, failures, round, p.maxFix, failures.length === 0),
      spec: { requireChanges: true, failures: failures.map((f) => ({ name: f.name, command: f.command, exitCode: f.exitCode })) },
      timeoutSec: 3600,
      dependsOn: [],
    });
    const verify = await this.insertTask(q, {
      projectId: t.project_id,
      seq: 1000 + round * 10 + 5,
      key: `verify-${round + 1}`,
      title: `재검증 (${round}차 수정 후)`,
      role: 'reviewer',
      kind: 'verify',
      timeoutSec: 1800,
      maxAttempts: 2,
      dependsOn: [fix],
    });
    await q.q('UPDATE ai_task_dependencies SET depends_on_task_id = $2 WHERE depends_on_task_id = $1', [t.id, verify]);
    await q.q(
      `UPDATE ai_tasks SET status = 'failed', superseded_by = $2, result = $3, lease_agent_id = NULL, lease_expires_at = NULL, finished_at = now() WHERE id = $1`,
      [t.id, verify, JSON.stringify(result)],
    );
  }

  /** 시도 실패(임대 만료·엔진 재시작)를 처리합니다. 재시도 한도 안이면 다시 대기열로 보냅니다. */
  private async loseAttempt(q: Q, after: After, t: any, error: string) {
    await q.q(
      `UPDATE ai_task_attempts SET status = 'lost', error = $3, finished_at = now() WHERE task_id = $1 AND attempt_no = $2 AND status = 'running'`,
      [t.id, t.attempt_count, error],
    );
    const status = t.cancel_requested ? 'cancelled' : t.attempt_count < t.max_attempts ? 'queued' : 'failed';
    await q.q(
      `UPDATE ai_tasks SET status = $2, result = $3, lease_agent_id = NULL, lease_expires_at = NULL,
              finished_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END WHERE id = $1`,
      [t.id, status, JSON.stringify({ reason: error, retrying: status === 'queued' })],
    );
    await this.advance(q, t.project_id, after);
  }

  /** PC 엔진이 재시작되면, 그 엔진이 실행 중이던 작업은 프로세스가 사라진 것이므로 즉시 복구합니다. */
  async recover(agent: AgentCtx) {
    const after: After = [];
    const n = await this.db.tx(async (q) => {
      const rows = await q.q(`SELECT * FROM ai_tasks WHERE status = 'running' AND lease_agent_id = $1 FOR UPDATE`, [agent.id]);
      for (const t of rows) await this.loseAttempt(q, after, t, 'PC 엔진이 재시작되어 실행 중이던 작업이 중단되었습니다.');
      return rows.length;
    });
    after.forEach((f) => f());
    return { recovered: n };
  }

  /** 임대가 만료된 작업을 복구하고, 응답 없는 PC 를 오프라인으로 표시합니다. 서버 시작 시와 주기적으로 실행됩니다. */
  async reap() {
    const after: After = [];
    const n = await this.db.tx(async (q) => {
      const rows = await q.q(
        `SELECT * FROM ai_tasks WHERE status = 'running' AND lease_expires_at < now() FOR UPDATE SKIP LOCKED`,
      );
      for (const t of rows) await this.loseAttempt(q, after, t, 'PC 엔진의 응답이 끊겨 작업 임대가 만료되었습니다.');
      const off = await q.q(
        `UPDATE desktop_agents SET status = 'offline' WHERE status = 'online' AND last_seen_at < now() - make_interval(secs => $1) RETURNING organization_id`,
        [Math.max(30, this.leaseSec)],
      );
      for (const o of off) after.push(() => this.hub.toOrg(o.organization_id, { type: 'agents' }));
      return rows.length;
    });
    after.forEach((f) => f());
    return n;
  }

  // ───────────────────────── 사용자 조작 ─────────────────────────

  async decideApproval(user: UserCtx, approvalId: string, approve: boolean, ip?: string) {
    requireWriter(user);
    const after: After = [];
    await this.db.tx(async (q) => {
      const a = await q.one(
        `SELECT a.*, p.organization_id FROM approvals a JOIN projects p ON p.id = a.project_id WHERE a.id = $1 FOR UPDATE OF a`,
        [approvalId],
      );
      if (!a || a.organization_id !== user.orgId) throw new NotFoundException('승인 요청을 찾을 수 없습니다.');
      if (a.status !== 'pending') throw new BadRequestException('이미 처리된 승인 요청입니다.');
      await q.q(`UPDATE approvals SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [
        a.id,
        approve ? 'approved' : 'rejected',
        user.id,
      ]);
      await audit(q, {
        orgId: user.orgId,
        userId: user.id,
        action: approve ? 'approval.approve' : 'approval.reject',
        targetType: 'approval',
        targetId: a.id,
        detail: { kind: a.kind, projectId: a.project_id },
        ip,
      });
      if (a.kind === 'task') {
        if (approve) {
          await q.q(`UPDATE ai_tasks SET status = 'queued' WHERE id = $1 AND status = 'awaiting_approval'`, [a.task_id]);
          await this.advance(q, a.project_id, after);
        } else {
          await this.cancelInTx(q, after, a.project_id, user.orgId);
        }
      } else if (a.kind === 'final') {
        await q.q(`UPDATE projects SET status = $2, updated_at = now() WHERE id = $1 AND status = 'review'`, [
          a.project_id,
          approve ? 'completed' : 'failed',
        ]);
        this.ping(after, user.orgId, a.project_id);
      }
    });
    after.forEach((f) => f());
    return { ok: true };
  }

  private async cancelInTx(q: Q, after: After, projectId: string, orgId: string) {
    await q.q(
      `UPDATE ai_tasks SET status = 'cancelled', finished_at = now() WHERE project_id = $1 AND status IN ('blocked','queued','awaiting_approval')`,
      [projectId],
    );
    await q.q(`UPDATE ai_tasks SET cancel_requested = true WHERE project_id = $1 AND status = 'running'`, [projectId]);
    await q.q(`UPDATE approvals SET status = 'rejected', decided_at = now() WHERE project_id = $1 AND status = 'pending'`, [projectId]);
    await q.q(`UPDATE projects SET status = 'cancelled', updated_at = now() WHERE id = $1`, [projectId]);
    this.ping(after, orgId, projectId);
  }

  async cancelProject(user: UserCtx, projectId: string, ip?: string) {
    requireWriter(user);
    const after: After = [];
    await this.db.tx(async (q) => {
      const p = await q.one('SELECT status FROM projects WHERE id = $1 AND organization_id = $2 FOR UPDATE', [projectId, user.orgId]);
      if (!p) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
      if (['completed', 'cancelled'].includes(p.status)) throw new BadRequestException('이미 종료된 프로젝트입니다.');
      await this.cancelInTx(q, after, projectId, user.orgId);
      await audit(q, { orgId: user.orgId, userId: user.id, action: 'project.cancel', targetType: 'project', targetId: projectId, ip });
    });
    after.forEach((f) => f());
    return { ok: true };
  }

  /** 실패한 프로젝트를 다시 시도합니다. 검증 한도 소진으로 실패했다면 자동 수정 횟수를 추가로 부여합니다. */
  async retryProject(user: UserCtx, projectId: string, ip?: string) {
    requireWriter(user);
    const after: After = [];
    await this.db.tx(async (q) => {
      const p = await q.one('SELECT status, max_fix_attempts FROM projects WHERE id = $1 AND organization_id = $2 FOR UPDATE', [
        projectId,
        user.orgId,
      ]);
      if (!p) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
      if (p.status !== 'failed') throw new ForbiddenException('실패한 프로젝트만 다시 시도할 수 있습니다.');
      const failed = await q.q(`SELECT id, kind FROM ai_tasks WHERE project_id = $1 AND status = 'failed' AND superseded_by IS NULL`, [projectId]);
      if (failed.length === 0) throw new BadRequestException('다시 시도할 작업이 없습니다. (최종 반려된 프로젝트는 새로 제작하세요)');
      const extra = failed.some((t) => t.kind === 'verify') ? 3 : 0;
      await q.q(`UPDATE projects SET status = 'running', max_fix_attempts = max_fix_attempts + $2, updated_at = now() WHERE id = $1`, [
        projectId,
        extra,
      ]);
      await q.q(
        `UPDATE ai_tasks SET status = 'queued', max_attempts = attempt_count + 3, cancel_requested = false, finished_at = NULL, result = '{}'
          WHERE project_id = $1 AND status = 'failed' AND superseded_by IS NULL`,
        [projectId],
      );
      await audit(q, { orgId: user.orgId, userId: user.id, action: 'project.retry', targetType: 'project', targetId: projectId, ip });
      await this.advance(q, projectId, after);
    });
    after.forEach((f) => f());
    return { ok: true };
  }
}

export function toEvent(r: any) {
  return {
    id: Number(r.id),
    taskId: r.task_id,
    attemptNo: r.attempt_no,
    seq: r.seq,
    type: r.type,
    message: r.message,
    data: r.data,
    createdAt: r.created_at,
  };
}
