import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { z, ZodTypeAny } from 'zod';
import { audit, Db } from './db';

export interface UserCtx {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  orgId: string;
  orgRole: string;
}
export interface AgentCtx {
  id: string;
  orgId: string;
  name: string;
}

export function parse<T extends ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || '입력'}: ${i.message}`).join(', ');
    throw new BadRequestException(`입력값이 올바르지 않습니다. (${msg})`);
  }
  return r.data;
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

let devSecret: string | undefined;
export function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('운영 환경에서는 16자 이상의 JWT_SECRET 환경변수가 필요합니다.');
  }
  if (!devSecret) {
    devSecret = randomToken();
    console.warn('[경고] JWT_SECRET이 없어 임시 비밀키를 사용합니다. 서버를 재시작하면 로그인이 풀립니다.');
  }
  return devSecret;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

export function signToken(payload: object, expiresInSec: number): string {
  return jwt.sign(payload, jwtSecret(), { algorithm: 'HS256', expiresIn: expiresInSec });
}
export function verifyToken<T = any>(token: string): T | undefined {
  try {
    return jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] }) as T;
  } catch {
    return undefined;
  }
}

function bearer(req: any): string | undefined {
  const h = req.headers?.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  return undefined;
}

@Injectable()
export class AuthService {
  constructor(private readonly db: Db) {}

  async userFromToken(token: string | undefined): Promise<UserCtx | undefined> {
    if (!token) return undefined;
    const p = verifyToken<{ sub: string; typ: string }>(token);
    if (!p || p.typ !== 'user') return undefined;
    const row = await this.db.one(
      `SELECT u.id, u.email, u.name, u.is_admin, m.organization_id, m.role
         FROM users u JOIN organization_members m ON m.user_id = u.id
        WHERE u.id = $1 AND u.disabled_at IS NULL
        ORDER BY m.created_at LIMIT 1`,
      [p.sub],
    );
    if (!row) return undefined;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      isAdmin: row.is_admin,
      orgId: row.organization_id,
      orgRole: row.role,
    };
  }

  async agentFromToken(token: string | undefined): Promise<AgentCtx | undefined> {
    if (!token || !token.startsWith('eumag_')) return undefined;
    const row = await this.db.one(
      `SELECT id, organization_id, name FROM desktop_agents WHERE token_hash = $1 AND revoked_at IS NULL`,
      [sha256(token)],
    );
    return row ? { id: row.id, orgId: row.organization_id, name: row.name } : undefined;
  }
}

@Injectable()
export class UserGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const user = await this.auth.userFromToken(bearer(req));
    if (!user) throw new UnauthorizedException('로그인이 필요합니다.');
    req.user = user;
    return true;
  }
}

@Injectable()
export class AgentGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const agent = await this.auth.agentFromToken(bearer(req));
    if (!agent) throw new UnauthorizedException('등록된 PC 엔진만 접근할 수 있습니다.');
    req.agent = agent;
    return true;
  }
}

export function requireWriter(user: UserCtx) {
  if (user.orgRole === 'viewer') throw new ForbiddenException('보기 전용 계정은 이 작업을 할 수 없습니다.');
}

/** 간단한 메모리 기반 시도 횟수 제한 (로그인·페어링 무차별 대입 방지) */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly max: number;
  constructor(
    max: number,
    private readonly windowMs: number,
  ) {
    // 자동 테스트에서만 RATE_LIMIT_MAX 로 한도를 올립니다.
    this.max = Number(process.env.RATE_LIMIT_MAX) || max;
  }
  check(key: string) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      throw new HttpException('시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.', 429);
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.hits.clear();
  }
}

const registerSchema = z.object({
  email: z.string().trim().email('이메일 형식이 아닙니다').max(200),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다').max(200),
  name: z.string().trim().min(1).max(60),
  organizationName: z.string().trim().min(1).max(80).optional(),
});
const loginSchema = z.object({ email: z.string().trim().max(200), password: z.string().max(200) });

@Controller('api/auth')
export class AuthController {
  private limiter = new RateLimiter(10, 5 * 60_000);
  constructor(private readonly db: Db) {}

  /** 가입 가능 여부. 첫 사용자는 항상 가능(관리자), 이후에는 ALLOW_SIGNUP=1 일 때만 가능 */
  @Get('status')
  async status() {
    const row = await this.db.one<{ n: string }>('SELECT count(*)::text AS n FROM users');
    const hasUsers = Number(row?.n || 0) > 0;
    return { hasUsers, signupOpen: !hasUsers || process.env.ALLOW_SIGNUP === '1' };
  }

  @Post('register')
  async register(@Body() body: unknown, @Req() req: any) {
    this.limiter.check(`reg:${req.ip}`);
    const input = parse(registerSchema, body);
    const result = await this.db.tx(async (q) => {
      await q.q('SELECT pg_advisory_xact_lock(727002)');
      const n = Number((await q.one('SELECT count(*)::text AS n FROM users'))!.n);
      if (n > 0 && process.env.ALLOW_SIGNUP !== '1') {
        throw new ForbiddenException('회원가입이 닫혀 있습니다. 관리자에게 문의하세요.');
      }
      if (await q.one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.email])) {
        throw new BadRequestException('이미 가입된 이메일입니다.');
      }
      const user = await q.one(
        `INSERT INTO users (email, password_hash, name, is_admin) VALUES ($1,$2,$3,$4) RETURNING id`,
        [input.email, hashPassword(input.password), input.name, n === 0],
      );
      const org = await q.one(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [
        input.organizationName || `${input.name}의 작업공간`,
      ]);
      await q.q(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'owner')`, [
        org.id,
        user.id,
      ]);
      await audit(q, { orgId: org.id, userId: user.id, action: 'user.register', ip: req.ip });
      return { userId: user.id as string };
    });
    return { token: signToken({ sub: result.userId, typ: 'user' }, 7 * 24 * 3600) };
  }

  @Post('login')
  async login(@Body() body: unknown, @Req() req: any) {
    const input = parse(loginSchema, body);
    this.limiter.check(`login:${req.ip}:${input.email.toLowerCase()}`);
    const user = await this.db.one(
      'SELECT id, password_hash FROM users WHERE lower(email) = lower($1) AND disabled_at IS NULL',
      [input.email],
    );
    if (!user || !verifyPassword(input.password, user.password_hash)) {
      await audit(this.db, { action: 'user.login_failed', detail: { email: input.email }, ip: req.ip });
      throw new UnauthorizedException('이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    await audit(this.db, { userId: user.id, action: 'user.login', ip: req.ip });
    return { token: signToken({ sub: user.id, typ: 'user' }, 7 * 24 * 3600) };
  }

  @Get('me')
  @UseGuards(UserGuard)
  async me(@Req() req: any) {
    const u: UserCtx = req.user;
    const org = await this.db.one('SELECT name FROM organizations WHERE id = $1', [u.orgId]);
    return { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, organization: { id: u.orgId, name: org?.name, role: u.orgRole } };
  }
}
