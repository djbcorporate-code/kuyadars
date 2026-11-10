import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Database } from "./db.js";
import type { Role } from "../shared/domain.js";

export type AuthenticatedUser = { id: string; email: string; fullName: string; roles: Role[] };
export type AppRequest = Request & { auth?: AuthenticatedUser; requestId?: string };

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeIpHash(ip: string | undefined): string | null {
  return ip ? sha256(`kuya-dars-ip:${ip}`) : null;
}

export function authMiddleware(db: Database) {
  return async (request: AppRequest, _response: Response, next: NextFunction) => {
    try {
      const token = request.cookies?.kd_session as string | undefined;
      if (!token) return next();
      const result = await db.query<{ id: string; email: string; full_name: string; roles: Role[] }>(
        `SELECT u.id,u.email,u.full_name,COALESCE(array_agg(ur.role_code) FILTER (WHERE ur.role_code IS NOT NULL),'{}') roles
         FROM sessions s JOIN users u ON u.id=s.user_id
         LEFT JOIN user_roles ur ON ur.user_id=u.id
         WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active
         GROUP BY u.id`, [sha256(token)],
      );
      if (result.rowCount) {
        const row = result.rows[0];
        request.auth = { id: row.id, email: row.email, fullName: row.full_name, roles: row.roles };
      }
      next();
    } catch (error) { next(error); }
  };
}

export function requireRole(...roles: Role[]) {
  return (request: AppRequest, response: Response, next: NextFunction) => {
    if (!request.auth) return response.status(401).json({ error: "AUTH_REQUIRED", message: "Sign in is required." });
    if (!request.auth.roles.some((role) => roles.includes(role))) {
      return response.status(403).json({ error: "FORBIDDEN", message: "Your role cannot perform this action." });
    }
    next();
  };
}

export function csrfMiddleware(request: AppRequest, response: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || !request.auth) return next();
  const header = request.get("x-csrf-token");
  const cookie = request.cookies?.kd_csrf as string | undefined;
  if (!header || !cookie || header !== cookie) {
    return response.status(403).json({ error: "CSRF_FAILED", message: "Refresh the page and try again." });
  }
  next();
}

export async function createSession(db: Database, userId: string, response: Response, secure: boolean) {
  const token = randomToken();
  const csrf = randomToken(24);
  await db.query(
    `INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES ($1,$2,$3,now()+interval '7 days')`,
    [userId, sha256(token), sha256(csrf)],
  );
  response.cookie("kd_session", token, { httpOnly: true, secure, sameSite: "lax", maxAge: 7 * 86400_000, path: "/" });
  response.cookie("kd_csrf", csrf, { httpOnly: false, secure, sameSite: "strict", maxAge: 7 * 86400_000, path: "/" });
  return csrf;
}

export async function audit(db: Database, request: AppRequest, action: string, entityType: string, entityId: string, beforeValue: unknown, afterValue: unknown, reason?: string) {
  await db.query(
    `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,before_value,after_value,reason,request_id,ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [request.auth?.id ?? null, action, entityType, entityId, beforeValue ? JSON.stringify(beforeValue) : null,
      afterValue ? JSON.stringify(afterValue) : null, reason ?? null, request.requestId ?? null, safeIpHash(request.ip)],
  );
}
