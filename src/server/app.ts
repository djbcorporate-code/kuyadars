import { randomUUID } from "node:crypto";
import path from "node:path";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { z, ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import { inTransaction } from "./db.js";
import { ApiError } from "./errors.js";
import { OperationsService } from "./operations.js";
import { OrderService } from "./orders.js";
import { actionSchema, contactAttemptSchema, credentialsSchema, orderSchema, quoteSchema, registerSchema } from "./schemas.js";
import { audit, authMiddleware, createSession, csrfMiddleware, randomToken, requireRole, sha256, type AppRequest } from "./security.js";
import { PrivateStorage } from "./storage.js";
import { isOrderingOpen } from "../shared/domain.js";

const staffRoles = ["owner", "admin", "csr"] as const;
const adminRoles = ["owner", "admin"] as const;
const routeParam = (request: Request, key: string) => String(request.params[key]);

export function createApp(db: Database, config: AppConfig) {
  const app = express();
  const storage = new PrivateStorage(config);
  const orders = new OrderService(db, config);
  const operations = new OperationsService(db, config);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 } });
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  const orderLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: config.NODE_ENV === "development" ? false : {
      directives: { "img-src": ["'self'", "data:", "https://*.tile.openstreetmap.org"], "connect-src": ["'self'"] },
    },
  }));
  app.use(express.json({ limit: "300kb" }));
  app.use(cookieParser());
  app.use((request: AppRequest, response, next) => {
    request.requestId = request.get("x-request-id")?.slice(0, 100) || randomUUID();
    response.setHeader("x-request-id", request.requestId);
    next();
  });
  app.use(authMiddleware(db));
  app.use(csrfMiddleware);

  app.get("/api/health", async (_request, response) => {
    await db.query("SELECT 1");
    response.json({ status: "ok", time: new Date().toISOString() });
  });

  app.get("/api/catalog", async (_request, response) => {
    const [settings, products, coverage] = await Promise.all([
      db.query(`SELECT store_name,store_latitude,store_longitude,entrance_pin_verified,timezone,
        to_char(ordering_open,'HH24:MI') ordering_open,to_char(ordering_close,'HH24:MI') ordering_close,
        to_char(preparation_cutoff,'HH24:MI') preparation_cutoff,merchant_qr_object_key IS NOT NULL gcash_configured,
        free_radius_km,paid_zone_max_km,paid_zone_base_fee_centavos,extra_started_km_fee_centavos,daily_order_capacity,refund_sla_minutes
        FROM store_settings WHERE id=true`),
      db.query(`SELECT id,slug,name,description,price_centavos,active,promo_eligible,
        GREATEST(0,stock_on_hand-stock_reserved) available_stock FROM products WHERE active ORDER BY name`),
      db.query(`SELECT id,legislative_district,administrative_district,barangay,service_status
        FROM coverage_barangays ORDER BY administrative_district,barangay`),
    ]);
    const setting = settings.rows[0];
    const acceptingUntil = setting ? (setting.preparation_cutoff < setting.ordering_close ? setting.preparation_cutoff : setting.ordering_close) : null;
    response.json({
      settings: setting ? { ...setting, ordering_open: undefined, ordering_close: undefined,
        orderingOpen: setting.ordering_open, orderingClose: setting.ordering_close,
        preparationCutoff: setting.preparation_cutoff,
        orderOpenNow: isOrderingOpen(new Date(), setting.ordering_open, acceptingUntil), acceptingUntil,
        gcashQrUrl: setting.gcash_configured ? "/api/payment-qr" : null } : null,
      products: products.rows,
      coverage: coverage.rows,
    });
  });

  app.post("/api/auth/register", authLimiter, async (request, response) => {
    const input = registerSchema.parse(request.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const token = randomToken();
    try {
      const user = await inTransaction(db, async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO users(email,phone,full_name,password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
          [input.email.toLowerCase(), input.phone, input.fullName, passwordHash],
        );
        await client.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'customer')", [result.rows[0].id]);
        await client.query(
          `INSERT INTO verification_tokens(user_id,purpose,token_hash,expires_at) VALUES ($1,'verify_email',$2,now()+interval '24 hours')`,
          [result.rows[0].id, sha256(token)],
        );
        await client.query(
          `INSERT INTO notification_outbox(user_id,template,recipient,payload,idempotency_key)
           VALUES ($1,'verify_email',$2,$3,$4)`,
          [result.rows[0].id, input.email.toLowerCase(), JSON.stringify({ verifyUrl: `${config.APP_BASE_URL}/verify-email?token=${token}` }), `verify-email:${result.rows[0].id}`],
        );
        return result.rows[0];
      });
      const csrfToken = await createSession(db, user.id, response, config.isProduction);
      response.status(201).json({ ok: true, csrfToken, verificationPending: true });
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "23505") throw new ApiError(409, "ACCOUNT_EXISTS", "An account already uses this email.");
      throw error;
    }
  });

  app.post("/api/auth/login", authLimiter, async (request, response) => {
    const input = credentialsSchema.parse(request.body);
    const result = await db.query<{ id: string; password_hash: string; active: boolean }>("SELECT id,password_hash,active FROM users WHERE email=$1", [input.email.toLowerCase()]);
    const valid = result.rowCount && result.rows[0].active && await bcrypt.compare(input.password, result.rows[0].password_hash);
    if (!valid) throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    const csrfToken = await createSession(db, result.rows[0].id, response, config.isProduction);
    response.json({ ok: true, csrfToken });
  });

  app.get("/api/auth/me", (request: AppRequest, response) => {
    if (!request.auth) return response.status(401).json({ error: "AUTH_REQUIRED" });
    response.json({ user: request.auth });
  });

  app.post("/api/auth/logout", async (request: AppRequest, response) => {
    const token = request.cookies?.kd_session as string | undefined;
    if (token) await db.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", [sha256(token)]);
    response.clearCookie("kd_session");
    response.clearCookie("kd_csrf");
    response.json({ ok: true });
  });

  app.post("/api/auth/verify-email", authLimiter, async (request, response) => {
    const input = z.object({ token: z.string().min(20).max(200) }).parse(request.body);
    const updated = await inTransaction(db, async (client) => {
      const result = await client.query<{ id: string; user_id: string }>(
        `SELECT id,user_id FROM verification_tokens WHERE token_hash=$1 AND purpose='verify_email'
         AND used_at IS NULL AND expires_at>now() FOR UPDATE`, [sha256(input.token)],
      );
      if (!result.rowCount) return false;
      await client.query("UPDATE verification_tokens SET used_at=now() WHERE id=$1", [result.rows[0].id]);
      await client.query("UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1", [result.rows[0].user_id]);
      return true;
    });
    if (!updated) throw new ApiError(422, "TOKEN_INVALID", "Verification link is invalid or expired.");
    response.json({ ok: true });
  });

  app.post("/api/delivery/quote", orderLimiter, async (request, response) => {
    response.json(await orders.quote(quoteSchema.parse(request.body)));
  });

  app.post("/api/orders", orderLimiter, async (request: AppRequest, response) => {
    const result = await orders.create(orderSchema.parse(request.body), request.get("idempotency-key") ?? "", request);
    response.status(201).json(result);
  });

  app.get("/api/tracking/:token", orderLimiter, async (request, response) => {
    const tokenHash = sha256(routeParam(request, "token"));
    const result = await db.query(
      `SELECT o.id,o.reference,o.customer_name,o.review_status,o.payment_status,o.payment_method,o.fulfillment_status,
       o.delivery_status,o.refund_status,o.subtotal_centavos,o.discount_centavos,o.delivery_fee_centavos,o.total_centavos,
       o.verified_paid_centavos,o.outstanding_centavos,o.balance_resolution,o.distance_km,o.exception_code,o.exception_notes,
       o.refund_action_due_at,o.submitted_at,o.confirmed_at,o.delivered_at,o.version,
       json_build_object('barangay',a.barangay,'district',a.administrative_district,'street',a.street_address,'landmark',a.landmark,
         'latitude',a.latitude,'longitude',a.longitude,'needsCsrReview',a.needs_csr_review) address,
       COALESCE((SELECT json_agg(json_build_object('name',i.product_name_snapshot,'quantity',i.quantity,'unitPriceCentavos',i.unit_price_centavos)) FROM order_items i WHERE i.order_id=o.id),'[]') items,
       COALESCE((SELECT json_agg(json_build_object('domain',s.domain,'from',s.from_value,'to',s.to_value,'reason',s.reason,'at',s.created_at) ORDER BY s.created_at) FROM status_transitions s WHERE s.order_id=o.id),'[]') timeline,
       COALESCE((SELECT json_agg(json_build_object('id',r.id,'status',r.status,'requestedSlot',r.requested_slot,'expiresAt',r.expires_at,'requiresFreshPreparation',r.requires_fresh_preparation,'redeliveryFeeCentavos',r.redelivery_fee_centavos)) FROM reschedule_requests r WHERE r.order_id=o.id),'[]') reschedules
       FROM orders o JOIN delivery_addresses a ON a.order_id=o.id WHERE o.tracking_token_hash=$1`, [tokenHash],
    );
    if (!result.rowCount) throw new ApiError(404, "TRACKING_NOT_FOUND", "This secure tracking link is invalid.");
    response.setHeader("Cache-Control", "no-store");
    response.json({ order: result.rows[0] });
  });

  app.post("/api/tracking/:token/payment-evidence", orderLimiter, upload.single("receipt"), async (request, response) => {
    if (!request.file) throw new ApiError(422, "RECEIPT_REQUIRED", "Attach a JPEG, PNG, or PDF receipt.");
    const reference = z.string().trim().min(3).max(120).parse(request.body.reference);
    const tokenHash = sha256(routeParam(request, "token"));
    const order = await db.query<{ id: string; payment_status: string; payment_method: string }>("SELECT id,payment_status,payment_method FROM orders WHERE tracking_token_hash=$1", [tokenHash]);
    if (!order.rowCount) throw new ApiError(404, "TRACKING_NOT_FOUND", "This secure tracking link is invalid.");
    if (order.rows[0].payment_method !== "gcash_manual") throw new ApiError(422, "NOT_GCASH", "This order does not use manual GCash.");
    if (!['unpaid','short','rejected'].includes(order.rows[0].payment_status)) throw new ApiError(409, "PAYMENT_STATE_CONFLICT", "Payment evidence cannot be added in the current state.");
    const stored = await storage.put(request.file.buffer, request.file.mimetype, "payment-evidence");
    await inTransaction(db, async (client) => {
      const object = await client.query<{ id: string }>(
        `INSERT INTO private_objects(storage_key,original_name,content_type,byte_size,sha256,purpose,scan_status,retention_until)
         VALUES ($1,$2,$3,$4,$5,'payment_evidence',$6,now()+interval '2 years') RETURNING id`,
        [stored.storageKey, request.file!.originalname, request.file!.mimetype, request.file!.size, stored.sha256, stored.scanStatus],
      );
      const payment = await client.query<{ id: string }>("SELECT id FROM payments WHERE order_id=$1 ORDER BY created_at LIMIT 1", [order.rows[0].id]);
      await client.query(
        "INSERT INTO payment_evidence(payment_id,object_id,submitted_reference) VALUES ($1,$2,$3)",
        [payment.rows[0].id, object.rows[0].id, reference],
      );
      await client.query("UPDATE payments SET status='evidence_submitted',customer_reference=$1,version=version+1 WHERE id=$2", [reference, payment.rows[0].id]);
      await client.query("UPDATE orders SET payment_status='evidence_submitted',version=version+1 WHERE id=$1", [order.rows[0].id]);
      await client.query(
        `INSERT INTO status_transitions(order_id,domain,from_value,to_value,reason)
         VALUES ($1,'payment',$2,'evidence_submitted','Customer uploaded payment evidence; merchant verification still required')`,
        [order.rows[0].id, order.rows[0].payment_status],
      );
    });
    response.status(201).json({ ok: true, paymentStatus: "evidence_submitted", message: "Payment under review. Uploading proof does not verify payment." });
  });

  app.post("/api/tracking/:token/balance-choice", orderLimiter, async (request, response) => {
    const input = z.object({ choice: z.enum(["pay_online", "collect_on_delivery"]) }).parse(request.body);
    const updated = await db.query(
      `UPDATE orders SET balance_resolution=$1,version=version+1 WHERE tracking_token_hash=$2 AND payment_status='short' AND outstanding_centavos>0 RETURNING id`,
      [input.choice, sha256(routeParam(request, "token"))],
    );
    if (!updated.rowCount) throw new ApiError(409, "BALANCE_CHOICE_UNAVAILABLE", "No short-payment balance is awaiting a choice.");
    await db.query(
      `INSERT INTO status_transitions(order_id,domain,to_value,reason,metadata) VALUES ($1,'balance',$2,'Customer selected balance resolution',$3)`,
      [updated.rows[0].id, input.choice, JSON.stringify({ choice: input.choice })],
    );
    response.json({ ok: true, choice: input.choice });
  });

  app.get("/api/reschedule/:token", orderLimiter, async (request, response) => {
    const result = await db.query(
      `SELECT r.id,r.status,r.expires_at,r.requires_fresh_preparation,o.reference
       FROM reschedule_requests r JOIN orders o ON o.id=r.order_id WHERE r.token_hash=$1`, [sha256(routeParam(request, "token"))],
    );
    if (!result.rowCount) throw new ApiError(404, "RESCHEDULE_NOT_FOUND", "Reschedule link is invalid.");
    response.setHeader("Cache-Control", "no-store");
    response.json(result.rows[0]);
  });

  app.post("/api/reschedule/:token", orderLimiter, async (request, response) => {
    const input = z.object({ requestedSlot: z.iso.datetime(), notes: z.string().trim().max(500).optional() }).parse(request.body);
    if (new Date(input.requestedSlot) <= new Date()) throw new ApiError(422, "FUTURE_SLOT_REQUIRED", "Choose a future delivery slot.");
    const updated = await db.query(
      `UPDATE reschedule_requests SET status='requested',requested_slot=$1,customer_notes=$2,requested_at=now()
       WHERE token_hash=$3 AND status='link_issued' AND expires_at>now() RETURNING id`,
      [input.requestedSlot, input.notes ?? null, sha256(routeParam(request, "token"))],
    );
    if (!updated.rowCount) throw new ApiError(409, "RESCHEDULE_UNAVAILABLE", "This link is expired or already used.");
    response.json({ ok: true, message: "Request submitted for CSR approval. Fresh preparation is required." });
  });

  app.get("/api/customer/orders", requireRole("customer"), async (request: AppRequest, response) => {
    const result = await db.query(
      `SELECT reference,review_status,payment_status,fulfillment_status,delivery_status,total_centavos,submitted_at
       FROM orders WHERE user_id=$1 ORDER BY submitted_at DESC`, [request.auth!.id],
    );
    response.json({ orders: result.rows });
  });

  app.get("/api/csr/counters", requireRole(...staffRoles), async (_request, response) => {
    const result = await db.query(`SELECT
      count(*) FILTER (WHERE review_status IN ('awaiting_review','on_hold'))::int new_orders,
      count(*) FILTER (WHERE payment_status IN ('evidence_submitted','under_review','short'))::int payment_review,
      count(*) FILTER (WHERE payment_method='cod' AND payment_status='unpaid' AND review_status='approved')::int cod,
      count(*) FILTER (WHERE fulfillment_status='preparing')::int preparing,
      count(*) FILTER (WHERE fulfillment_status='ready')::int ready,
      count(*) FILTER (WHERE delivery_status='out_for_delivery')::int on_delivery,
      count(*) FILTER (WHERE delivery_status IN ('unreachable','rts','failed'))::int exceptions,
      count(*) FILTER (WHERE refund_status IN ('required','initiated','verified'))::int refunds,
      count(*) FILTER (WHERE delivery_status='delivered')::int completed
      FROM orders`);
    response.json(result.rows[0]);
  });

  app.get("/api/csr/orders", requireRole(...staffRoles), async (request, response) => {
    const queue = z.enum(["all","new","payment","cod","preparing","ready","delivery","exceptions","refunds","completed"]).catch("all").parse(request.query.queue);
    const filters: Record<string, string> = {
      all: "true", new: "o.review_status IN ('awaiting_review','on_hold')", payment: "o.payment_status IN ('evidence_submitted','under_review','short')",
      cod: "o.payment_method='cod' AND o.payment_status='unpaid'", preparing: "o.fulfillment_status='preparing'", ready: "o.fulfillment_status='ready'",
      delivery: "o.delivery_status='out_for_delivery'", exceptions: "o.delivery_status IN ('unreachable','rts','failed') OR o.exception_code IS NOT NULL",
      refunds: "o.refund_status IN ('required','initiated','verified')", completed: "o.delivery_status='delivered'",
    };
    const search = String(request.query.q ?? "").slice(0, 100);
    const result = await db.query(
      `SELECT o.*,a.barangay,a.administrative_district,a.street_address,a.landmark,a.latitude,a.longitude,
       (o.refund_status='required' AND o.refund_action_due_at<now()) refund_overdue
       FROM orders o JOIN delivery_addresses a ON a.order_id=o.id
       WHERE ${filters[queue]} AND ($1='' OR o.reference ILIKE '%'||$1||'%' OR o.customer_name ILIKE '%'||$1||'%' OR o.customer_phone ILIKE '%'||$1||'%')
       ORDER BY CASE WHEN o.refund_action_due_at IS NOT NULL THEN 0 ELSE 1 END,o.submitted_at DESC LIMIT 200`, [search],
    );
    response.setHeader("Cache-Control", "no-store");
    response.json({ orders: result.rows });
  });

  app.get("/api/csr/orders/:id", requireRole(...staffRoles), async (request, response) => {
    const result = await db.query(
      `SELECT o.*,row_to_json(a) address,
       COALESCE((SELECT json_agg(i ORDER BY i.id) FROM order_items i WHERE i.order_id=o.id),'[]') items,
       COALESCE((SELECT json_agg(p ORDER BY p.created_at) FROM payments p WHERE p.order_id=o.id),'[]') payments,
       COALESCE((SELECT json_agg(json_build_object('id',pe.id,'objectId',pe.object_id,'reference',pe.submitted_reference,'status',pe.review_status,'createdAt',pe.created_at)) FROM payment_evidence pe JOIN payments p ON p.id=pe.payment_id WHERE p.order_id=o.id),'[]') evidence,
       COALESCE((SELECT json_agg(s ORDER BY s.created_at) FROM status_transitions s WHERE s.order_id=o.id),'[]') transitions,
       COALESCE((SELECT json_agg(c ORDER BY c.attempted_at) FROM contact_attempts c WHERE c.order_id=o.id),'[]') contacts,
       COALESCE((SELECT json_agg(r ORDER BY r.created_at) FROM refunds r WHERE r.order_id=o.id),'[]') refunds,
       COALESCE((SELECT json_agg(rr ORDER BY rr.created_at) FROM reschedule_requests rr WHERE rr.order_id=o.id),'[]') reschedules
       FROM orders o JOIN delivery_addresses a ON a.order_id=o.id WHERE o.id=$1 GROUP BY o.id,a.order_id`, [routeParam(request, "id")],
    );
    if (!result.rowCount) throw new ApiError(404, "ORDER_NOT_FOUND", "Order was not found.");
    response.setHeader("Cache-Control", "no-store");
    response.json({ order: result.rows[0] });
  });

  app.post("/api/csr/orders/:id/actions", requireRole(...staffRoles), async (request: AppRequest, response) => {
    response.json(await operations.execute(routeParam(request, "id"), actionSchema.parse(request.body), request));
  });

  app.post("/api/csr/orders/:id/contact-attempts", requireRole(...staffRoles), async (request: AppRequest, response) => {
    const input = contactAttemptSchema.parse(request.body);
    const result = await db.query(
      `INSERT INTO contact_attempts(order_id,actor_id,channel,outcome,notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [routeParam(request, "id"), request.auth!.id, input.channel, input.outcome, input.notes ?? null],
    );
    response.status(201).json(result.rows[0]);
  });

  app.post("/api/csr/orders/:id/refund-evidence", requireRole(...staffRoles), upload.single("proof"), async (request: AppRequest, response) => {
    if (!request.file) throw new ApiError(422, "PROOF_REQUIRED", "Attach private refund proof.");
    const stored = await storage.put(request.file.buffer, request.file.mimetype, "refund-evidence");
    const result = await db.query<{ id: string }>(
      `INSERT INTO private_objects(storage_key,original_name,content_type,byte_size,sha256,purpose,scan_status,uploaded_by,retention_until)
       VALUES ($1,$2,$3,$4,$5,'refund_evidence',$6,$7,now()+interval '2 years') RETURNING id`,
      [stored.storageKey, request.file.originalname, request.file.mimetype, request.file.size, stored.sha256, stored.scanStatus, request.auth!.id],
    );
    response.status(201).json({ objectId: result.rows[0].id });
  });

  app.get("/api/private-objects/:id", requireRole(...staffRoles), async (request, response) => {
    const result = await db.query<{ storage_key: string; content_type: string; original_name: string }>(
      "SELECT storage_key,content_type,original_name FROM private_objects WHERE id=$1", [routeParam(request, "id")],
    );
    if (!result.rowCount) throw new ApiError(404, "OBJECT_NOT_FOUND", "Private object was not found.");
    response.setHeader("Content-Type", result.rows[0].content_type);
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(result.rows[0].original_name)}`);
    response.setHeader("Cache-Control", "private, no-store");
    response.send(await storage.get(result.rows[0].storage_key));
  });

  app.get("/api/secure-objects/:token", orderLimiter, async (request, response) => {
    const object = await inTransaction(db, async (client) => {
      const result = await client.query<{ id: string; storage_key: string; content_type: string; original_name: string }>(
        `SELECT t.id,o.storage_key,o.content_type,o.original_name FROM object_access_tokens t
         JOIN private_objects o ON o.id=t.object_id WHERE t.token_hash=$1 AND t.expires_at>now() AND t.access_count<t.max_accesses
         FOR UPDATE`, [sha256(routeParam(request, "token"))],
      );
      if (!result.rowCount) return null;
      await client.query("UPDATE object_access_tokens SET access_count=access_count+1 WHERE id=$1", [result.rows[0].id]);
      return result.rows[0];
    });
    if (!object) throw new ApiError(404, "PROOF_LINK_INVALID", "This controlled proof link is expired or has reached its view limit.");
    response.setHeader("Content-Type", object.content_type);
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(object.original_name)}`);
    response.setHeader("Cache-Control", "private, no-store");
    response.send(await storage.get(object.storage_key));
  });

  app.get("/api/payment-qr", async (_request, response) => {
    const result = await db.query<{ storage_key: string; content_type: string }>(
      `SELECT p.storage_key,p.content_type FROM store_settings s JOIN private_objects p ON p.storage_key=s.merchant_qr_object_key WHERE s.id=true`,
    );
    if (!result.rowCount) throw new ApiError(404, "GCASH_NOT_CONFIGURED", "Merchant QR is not configured.");
    response.setHeader("Content-Type", result.rows[0].content_type);
    response.setHeader("Cache-Control", "public, max-age=300");
    response.send(await storage.get(result.rows[0].storage_key));
  });

  const settingsSchema = z.object({
    orderingOpen: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    orderingClose: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    preparationCutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    dailyOrderCapacity: z.number().int().min(0).max(5000).optional(),
    refundSlaMinutes: z.number().int().min(1).max(120).optional(),
    entrancePinVerified: z.boolean().optional(),
    freeRadiusKm: z.number().min(0).max(100).optional(),
    paidZoneMaxKm: z.number().min(0).max(200).optional(),
    paidZoneBaseFeeCentavos: z.number().int().min(0).optional(),
    extraStartedKmFeeCentavos: z.number().int().min(0).optional(),
  });
  app.patch("/api/admin/settings", requireRole(...adminRoles), async (request: AppRequest, response) => {
    const input = settingsSchema.parse(request.body);
    const before = (await db.query("SELECT * FROM store_settings WHERE id=true")).rows[0];
    const result = await db.query(
      `UPDATE store_settings SET ordering_open=COALESCE($1,ordering_open),ordering_close=COALESCE($2,ordering_close),
       preparation_cutoff=COALESCE($3,preparation_cutoff),daily_order_capacity=COALESCE($4,daily_order_capacity),
       refund_sla_minutes=COALESCE($5,refund_sla_minutes),entrance_pin_verified=COALESCE($6,entrance_pin_verified),
       free_radius_km=COALESCE($7,free_radius_km),paid_zone_max_km=COALESCE($8,paid_zone_max_km),
       paid_zone_base_fee_centavos=COALESCE($9,paid_zone_base_fee_centavos),extra_started_km_fee_centavos=COALESCE($10,extra_started_km_fee_centavos),
       updated_by=$11,updated_at=now()
       WHERE id=true RETURNING *`,
      [input.orderingOpen ?? null, input.orderingClose ?? null, input.preparationCutoff ?? null, input.dailyOrderCapacity ?? null,
        input.refundSlaMinutes ?? null, input.entrancePinVerified ?? null, input.freeRadiusKm ?? null, input.paidZoneMaxKm ?? null,
        input.paidZoneBaseFeeCentavos ?? null, input.extraStartedKmFeeCentavos ?? null, request.auth!.id],
    );
    await audit(db, request, "update_settings", "store_settings", "primary", before, result.rows[0], "Admin settings update");
    response.json(result.rows[0]);
  });

  app.patch("/api/admin/products/:id", requireRole(...adminRoles), async (request: AppRequest, response) => {
    const input = z.object({ priceCentavos: z.number().int().min(0).optional(), active: z.boolean().optional(), promoEligible: z.boolean().optional(), stockOnHand: z.number().int().min(0).optional() }).parse(request.body);
    const productId = routeParam(request, "id");
    const before = (await db.query("SELECT * FROM products WHERE id=$1", [productId])).rows[0];
    if (!before) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product was not found.");
    if (input.stockOnHand != null && input.stockOnHand < before.stock_reserved) throw new ApiError(422, "STOCK_BELOW_RESERVED", "On-hand stock cannot be below reserved stock.");
    const result = await db.query(
      `UPDATE products SET price_centavos=COALESCE($1,price_centavos),active=COALESCE($2,active),promo_eligible=COALESCE($3,promo_eligible),
       stock_on_hand=COALESCE($4,stock_on_hand),version=version+1 WHERE id=$5 RETURNING *`,
      [input.priceCentavos ?? null, input.active ?? null, input.promoEligible ?? null, input.stockOnHand ?? null, productId],
    );
    await audit(db, request, "update_product", "product", productId, before, result.rows[0], "Admin product update");
    response.json(result.rows[0]);
  });

  app.patch("/api/admin/coverage/:id", requireRole(...adminRoles), async (request: AppRequest, response) => {
    const input = z.object({ serviceStatus: z.enum(["distance_based","blocked"]), notes: z.string().max(500).nullable().optional() }).parse(request.body);
    const coverageId = routeParam(request, "id");
    const before = (await db.query("SELECT * FROM coverage_barangays WHERE id=$1", [coverageId])).rows[0];
    if (!before) throw new ApiError(404, "BARANGAY_NOT_FOUND", "Barangay was not found.");
    const result = await db.query("UPDATE coverage_barangays SET service_status=$1,notes=COALESCE($2,notes),updated_at=now() WHERE id=$3 RETURNING *", [input.serviceStatus, input.notes ?? null, coverageId]);
    await audit(db, request, "update_coverage", "coverage_barangay", coverageId, before, result.rows[0], "Admin coverage update");
    response.json(result.rows[0]);
  });

  app.post("/api/admin/merchant-qr", requireRole(...adminRoles), upload.single("qr"), async (request: AppRequest, response) => {
    if (!request.file || !["image/jpeg","image/png"].includes(request.file.mimetype)) throw new ApiError(422, "QR_IMAGE_REQUIRED", "Attach an approved JPEG or PNG merchant QR.");
    const stored = await storage.put(request.file.buffer, request.file.mimetype, "merchant-qr");
    const object = await db.query<{ id: string }>(
      `INSERT INTO private_objects(storage_key,original_name,content_type,byte_size,sha256,purpose,scan_status,uploaded_by)
       VALUES ($1,$2,$3,$4,$5,'merchant_qr',$6,$7) RETURNING id`,
      [stored.storageKey, request.file.originalname, request.file.mimetype, request.file.size, stored.sha256, stored.scanStatus, request.auth!.id],
    );
    await db.query("UPDATE store_settings SET merchant_qr_object_key=$1,updated_by=$2,updated_at=now() WHERE id=true", [stored.storageKey, request.auth!.id]);
    await audit(db, request, "upload_merchant_qr", "private_object", object.rows[0].id, null, { configured: true }, "Approved merchant QR configured");
    response.status(201).json({ ok: true, objectId: object.rows[0].id });
  });

  app.post("/api/admin/staff", requireRole(...adminRoles), async (request: AppRequest, response) => {
    const input = registerSchema.extend({ role: z.enum(["admin","csr","rider"]) }).parse(request.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const result = await inTransaction(db, async (client) => {
      const user = await client.query<{ id: string }>(
        "INSERT INTO users(email,phone,full_name,password_hash,email_verified_at) VALUES ($1,$2,$3,$4,now()) RETURNING id",
        [input.email.toLowerCase(), input.phone, input.fullName, passwordHash],
      );
      await client.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)", [user.rows[0].id, input.role]);
      return user.rows[0];
    });
    await audit(db, request, "create_staff", "user", result.id, null, { email: input.email, role: input.role }, "Staff account created");
    response.status(201).json({ id: result.id, role: input.role });
  });

  app.get("/api/admin/audit", requireRole(...adminRoles), async (_request, response) => {
    const result = await db.query(
      `SELECT a.*,u.full_name actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 500`,
    );
    response.setHeader("Cache-Control", "no-store");
    response.json({ audit: result.rows });
  });

  if (config.NODE_ENV === "production") {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get(/^\/(?!api(?:\/|$)).*/, (_request, response) => response.sendFile(path.join(process.cwd(), "dist", "index.html")));
  }

  app.use((request, response) => response.status(404).json({ error: "NOT_FOUND", message: "Endpoint not found." }));
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const requestId = (request as AppRequest).requestId;
    if (error instanceof ZodError) return response.status(422).json({ error: "VALIDATION_ERROR", message: "Review the highlighted fields.", details: error.issues, requestId });
    if (error instanceof ApiError) return response.status(error.status).json({ error: error.code, message: error.message, details: error.details, requestId });
    if (error instanceof multer.MulterError) return response.status(422).json({ error: "UPLOAD_ERROR", message: error.message, requestId });
    console.error("Unhandled request error", { requestId, message: error instanceof Error ? error.message : String(error) });
    response.status(500).json({ error: "INTERNAL_ERROR", message: "The request could not be completed.", requestId });
  });
  return app;
}
