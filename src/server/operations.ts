import type { z } from "zod";
import type { actionSchema } from "./schemas.js";
import type { AppRequest } from "./security.js";
import { randomToken, safeIpHash, sha256 } from "./security.js";
import type { AppConfig } from "./config.js";
import type { Database, DbClient } from "./db.js";
import { inTransaction } from "./db.js";
import { ApiError } from "./errors.js";
import { assertMayConfirm, assertMayDeliver, assertMayPrepare, assertTransition } from "../shared/transitions.js";
import { refundDeadline, type OrderState } from "../shared/domain.js";

type Action = z.infer<typeof actionSchema>;
type LockedOrder = {
  id: string;
  reference: string;
  customer_email: string;
  review_status: OrderState["reviewStatus"];
  payment_status: OrderState["paymentStatus"];
  payment_method: OrderState["paymentMethod"];
  fulfillment_status: OrderState["fulfillmentStatus"];
  delivery_status: OrderState["deliveryStatus"];
  refund_status: OrderState["refundStatus"];
  verified_paid_centavos: number;
  outstanding_centavos: number;
  total_centavos: number;
  balance_resolution: "pay_online" | "collect_on_delivery" | null;
  version: number;
};

function toState(order: LockedOrder): OrderState {
  return {
    reviewStatus: order.review_status,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    fulfillmentStatus: order.fulfillment_status,
    deliveryStatus: order.delivery_status,
    refundStatus: order.refund_status,
    verifiedPaidCentavos: order.verified_paid_centavos,
    totalCentavos: order.total_centavos,
    balanceResolution: order.balance_resolution,
  };
}

async function transition(client: DbClient, order: LockedOrder, domain: "review" | "payment" | "fulfillment" | "delivery" | "refund", to: string, actorId: string, reason: string) {
  const column = `${domain}_status`;
  const from = order[column as keyof LockedOrder] as string;
  assertTransition(domain, from as never, to);
  await client.query(`UPDATE orders SET ${column}=$1 WHERE id=$2`, [to, order.id]);
  await client.query(
    `INSERT INTO status_transitions(order_id,domain,from_value,to_value,reason,actor_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [order.id, domain, from, to, reason, actorId],
  );
  (order as unknown as Record<string, unknown>)[column] = to;
}

async function commitInventory(client: DbClient, orderId: string, actorId: string) {
  const reservations = await client.query<{ id: string; product_id: string; quantity: number; state: string }>(
    "SELECT id,product_id,quantity,state FROM inventory_reservations WHERE order_id=$1 FOR UPDATE", [orderId],
  );
  if (!reservations.rowCount || reservations.rows.some((row) => row.state !== "reserved")) {
    throw new ApiError(409, "RESERVATION_UNAVAILABLE", "Inventory is no longer reserved. Record a stock-out or ask the customer to retry.");
  }
  for (const reservation of reservations.rows) {
    const updated = await client.query(
      `UPDATE products SET stock_on_hand=stock_on_hand-$1,stock_reserved=stock_reserved-$1,version=version+1
       WHERE id=$2 AND stock_on_hand>=$1 AND stock_reserved>=$1 RETURNING id`, [reservation.quantity, reservation.product_id],
    );
    if (!updated.rowCount) throw new ApiError(409, "INVENTORY_CONFLICT", "Inventory changed while accepting this order.");
    await client.query("UPDATE inventory_reservations SET state='committed',updated_at=now() WHERE id=$1", [reservation.id]);
    await client.query(
      "INSERT INTO inventory_events(product_id,order_id,actor_id,on_hand_delta,reserved_delta,reason) VALUES ($1,$2,$3,$4,$4,'Order accepted')",
      [reservation.product_id, orderId, actorId, -reservation.quantity],
    );
  }
}

async function releaseInventory(client: DbClient, orderId: string, actorId: string, reason: string) {
  const reservations = await client.query<{ id: string; product_id: string; quantity: number }>(
    "SELECT id,product_id,quantity FROM inventory_reservations WHERE order_id=$1 AND state='reserved' FOR UPDATE", [orderId],
  );
  for (const reservation of reservations.rows) {
    await client.query("UPDATE products SET stock_reserved=GREATEST(0,stock_reserved-$1),version=version+1 WHERE id=$2", [reservation.quantity, reservation.product_id]);
    await client.query("UPDATE inventory_reservations SET state='released',updated_at=now() WHERE id=$1", [reservation.id]);
    await client.query(
      "INSERT INTO inventory_events(product_id,order_id,actor_id,reserved_delta,reason) VALUES ($1,$2,$3,$4,$5)",
      [reservation.product_id, orderId, actorId, -reservation.quantity, reason],
    );
  }
}

export class OperationsService {
  constructor(private readonly db: Database, private readonly config: AppConfig) {}

  async execute(orderId: string, action: Action, request: AppRequest) {
    if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Sign in is required.");
    const actorId = request.auth.id;
    const actorRoles = request.auth.roles;
    return inTransaction(this.db, async (client) => {
      const result = await client.query<LockedOrder>("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [orderId]);
      if (!result.rowCount) throw new ApiError(404, "ORDER_NOT_FOUND", "Order was not found.");
      const order = result.rows[0];
      if (order.version !== action.expectedVersion) throw new ApiError(409, "STALE_ORDER", "Another CSR updated this order. Refresh before retrying.");
      const before = { ...order };

      switch (action.action) {
        case "hold":
          await transition(client, order, "review", "on_hold", actorId, action.reason);
          break;
        case "approve": {
          await transition(client, order, "review", "approved", actorId, action.reason);
          assertMayConfirm(toState(order));
          await commitInventory(client, order.id, actorId);
          await transition(client, order, "fulfillment", "confirmed", actorId, action.reason);
          await client.query("UPDATE orders SET confirmed_at=now() WHERE id=$1", [order.id]);
          await client.query(
            `INSERT INTO notification_outbox(order_id,template,recipient,payload,idempotency_key)
             VALUES ($1,'order_confirmed',$2,$3,$4) ON CONFLICT DO NOTHING`,
            [order.id, order.customer_email, JSON.stringify({ reference: order.reference }), `order-confirmed:${order.id}`],
          );
          break;
        }
        case "reject":
          await transition(client, order, "review", "rejected", actorId, action.reason);
          if (order.fulfillment_status === "submitted") await transition(client, order, "fulfillment", "cancelled", actorId, action.reason);
          await releaseInventory(client, order.id, actorId, "Order rejected");
          if (order.verified_paid_centavos > 0) await this.requireRefund(client, order, actorId, action.reason);
          break;
        case "start_preparing":
          assertMayPrepare(toState(order));
          await transition(client, order, "fulfillment", "preparing", actorId, action.reason);
          break;
        case "mark_ready":
          await transition(client, order, "fulfillment", "ready", actorId, action.reason);
          await transition(client, order, "delivery", "ready_for_dispatch", actorId, action.reason);
          break;
        case "dispatch":
          await transition(client, order, "delivery", "out_for_delivery", actorId, action.reason);
          break;
        case "mark_unreachable":
          await transition(client, order, "delivery", "unreachable", actorId, action.reason);
          break;
        case "confirm_rts": {
          if (!action.returnedAt) throw new ApiError(422, "RETURN_TIME_REQUIRED", "Record when the food physically returned to the shop.");
          const returnedAt = new Date(action.returnedAt);
          if (returnedAt > new Date()) throw new ApiError(422, "INVALID_RETURN_TIME", "Return time cannot be in the future.");
          await transition(client, order, "delivery", "rts", actorId, action.reason);
          await client.query(
            `INSERT INTO rts_records(order_id,unreachable_recorded_at,physically_returned_at,recorded_by,notes)
             VALUES ($1,(SELECT max(created_at) FROM status_transitions WHERE order_id=$1 AND domain='delivery' AND to_value='unreachable'),$2,$3,$4)`,
            [order.id, returnedAt, actorId, action.reason],
          );
          const token = randomToken(32);
          const reschedule = await client.query<{ id: string }>(
            `INSERT INTO reschedule_requests(order_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '48 hours') RETURNING id`,
            [order.id, sha256(token)],
          );
          await client.query(
            `INSERT INTO notification_outbox(order_id,template,recipient,payload,idempotency_key)
             VALUES ($1,'rts_reschedule',$2,$3,$4)`,
            [order.id, order.customer_email, JSON.stringify({ reference: order.reference, rescheduleUrl: `${this.config.APP_BASE_URL}/reschedule/${token}` }), `rts-reschedule:${reschedule.rows[0].id}`],
          );
          break;
        }
        case "mark_delivered":
          assertMayDeliver(toState(order), action.riderConfirmed === true);
          if (!action.riderName) throw new ApiError(422, "RIDER_NAME_REQUIRED", "Record the rider who confirmed delivery.");
          if (order.payment_method === "cod" || (order.payment_status === "short" && order.outstanding_centavos > 0)) {
            if (action.amountCentavos !== order.outstanding_centavos) throw new ApiError(422, "COLLECTION_AMOUNT_MISMATCH", "Record the exact outstanding amount collected.");
            await transition(client, order, "payment", "collected", actorId, "Collected on delivery");
            await client.query(
              `UPDATE orders SET verified_paid_centavos=total_centavos,outstanding_centavos=0 WHERE id=$1;
               UPDATE payments SET status='collected',amount_verified_centavos=amount_expected_centavos,verified_at=now(),verified_by=$2 WHERE order_id=$1`,
              [order.id, actorId],
            );
          } else if (order.payment_status !== "verified") throw new ApiError(422, "PAYMENT_NOT_COMPLETE", "Payment must be verified or collected before delivery completion.");
          await transition(client, order, "delivery", "delivered", actorId, action.reason);
          await transition(client, order, "fulfillment", "completed", actorId, action.reason);
          await client.query(
            "UPDATE orders SET rider_confirmation_name=$1,rider_confirmation_notes=$2,rider_confirmed_at=now(),delivered_at=now() WHERE id=$3",
            [action.riderName, action.riderNotes ?? null, order.id],
          );
          break;
        case "verify_payment": {
          if (order.payment_method !== "gcash_manual") throw new ApiError(422, "NOT_GCASH", "Only manual GCash payments use verification.");
          if (action.amountCentavos !== order.total_centavos) throw new ApiError(422, "AMOUNT_MISMATCH", "Use the short-payment action when the verified amount is below the total.");
          if (!action.merchantReference) throw new ApiError(422, "MERCHANT_REFERENCE_REQUIRED", "Record the merchant transaction reference.");
          const evidence = await client.query("SELECT 1 FROM payment_evidence pe JOIN payments p ON p.id=pe.payment_id WHERE p.order_id=$1 AND pe.review_status='pending'", [order.id]);
          if (!evidence.rowCount) throw new ApiError(422, "EVIDENCE_REQUIRED", "A pending receipt is required, but it does not itself verify payment.");
          if (order.payment_status === "evidence_submitted") await transition(client, order, "payment", "under_review", actorId, "Merchant transaction review started");
          await transition(client, order, "payment", "verified", actorId, action.reason);
          await client.query(
            `UPDATE payments SET status='verified',amount_verified_centavos=$1,verified_merchant_reference=$2,verified_at=now(),verified_by=$3,version=version+1 WHERE order_id=$4;
             UPDATE payment_evidence SET review_status='accepted',reviewed_by=$3,reviewed_at=now(),review_notes=$5 WHERE payment_id IN (SELECT id FROM payments WHERE order_id=$4) AND review_status='pending';
             UPDATE orders SET verified_paid_centavos=$1,outstanding_centavos=0 WHERE id=$4`,
            [action.amountCentavos, action.merchantReference, actorId, order.id, action.reason],
          );
          break;
        }
        case "record_short_payment": {
          const amount = action.amountCentavos;
          if (!amount || amount >= order.total_centavos) throw new ApiError(422, "INVALID_SHORT_AMOUNT", "Verified short amount must be above zero and below the total.");
          if (!action.merchantReference) throw new ApiError(422, "MERCHANT_REFERENCE_REQUIRED", "Record the merchant transaction reference.");
          if (order.payment_status === "evidence_submitted") await transition(client, order, "payment", "under_review", actorId, "Merchant transaction review started");
          await transition(client, order, "payment", "short", actorId, action.reason);
          await client.query(
            `UPDATE payments SET status='short',amount_verified_centavos=$1,verified_merchant_reference=$2,verified_at=now(),verified_by=$3,version=version+1 WHERE order_id=$4;
             UPDATE payment_evidence SET review_status='accepted',reviewed_by=$3,reviewed_at=now(),review_notes=$5 WHERE payment_id IN (SELECT id FROM payments WHERE order_id=$4) AND review_status='pending';
             UPDATE orders SET verified_paid_centavos=$1,outstanding_centavos=total_centavos-$1,balance_resolution=NULL WHERE id=$4`,
            [amount, action.merchantReference, actorId, order.id, action.reason],
          );
          break;
        }
        case "record_stockout":
          if (!["submitted", "confirmed", "preparing"].includes(order.fulfillment_status)) throw new ApiError(422, "INVALID_STOCKOUT_STATE", "This order cannot be marked stock-out now.");
          await transition(client, order, "fulfillment", "stock_out", actorId, action.reason);
          await releaseInventory(client, order.id, actorId, "Stock-out recorded");
          await client.query("UPDATE orders SET stockout_recorded_at=now() WHERE id=$1", [order.id]);
          if (order.verified_paid_centavos > 0) await this.requireRefund(client, order, actorId, action.reason);
          break;
        case "initiate_refund": {
          if (order.refund_status !== "required") throw new ApiError(422, "REFUND_NOT_REQUIRED", "This order has no refund awaiting initiation.");
          if (!action.amountCentavos || action.amountCentavos > order.verified_paid_centavos) throw new ApiError(422, "INVALID_REFUND_AMOUNT", "Refund cannot exceed the verified paid amount.");
          if (!action.merchantReference || !action.transactionTime || !action.evidenceObjectId) throw new ApiError(422, "REFUND_DOCUMENTATION_REQUIRED", "Reference, transaction time, and private proof are required.");
          await transition(client, order, "refund", "initiated", actorId, action.reason);
          const updated = await client.query(
            `UPDATE refunds SET status='initiated',amount_centavos=$1,initiated_at=now(),initiated_by=$2,merchant_reference=$3,
             transaction_time=$4,evidence_object_id=$5,version=version+1 WHERE order_id=$6 AND status='required' RETURNING id`,
            [action.amountCentavos, actorId, action.merchantReference, action.transactionTime, action.evidenceObjectId, order.id],
          );
          if (!updated.rowCount) throw new ApiError(409, "REFUND_CONFLICT", "Refund was already updated.");
          break;
        }
        case "verify_refund":
          if (!actorRoles.some((role) => role === "owner" || role === "admin")) throw new ApiError(403, "ADMIN_REQUIRED", "Only an owner or admin can verify a refund.");
          await transition(client, order, "refund", "verified", actorId, action.reason);
          await client.query("UPDATE refunds SET status='verified',verified_at=now(),verified_by=$1,version=version+1 WHERE order_id=$2 AND status='initiated'", [actorId, order.id]);
          const refundEvidence = await client.query<{ evidence_object_id: string }>(
            "SELECT evidence_object_id FROM refunds WHERE order_id=$1 AND status='initiated' FOR UPDATE", [order.id],
          );
          if (!refundEvidence.rows[0]?.evidence_object_id) throw new ApiError(422, "REFUND_PROOF_REQUIRED", "Private refund proof is required before verification.");
          const proofToken = randomToken(32);
          await client.query(
            `INSERT INTO object_access_tokens(object_id,token_hash,expires_at,max_accesses)
             VALUES ($1,$2,now()+interval '7 days',5)`, [refundEvidence.rows[0].evidence_object_id, sha256(proofToken)],
          );
          await client.query(
            `INSERT INTO notification_outbox(order_id,template,recipient,payload,idempotency_key)
             VALUES ($1,'refund_verified',$2,$3,$4) ON CONFLICT DO NOTHING`,
            [order.id, order.customer_email, JSON.stringify({ reference: order.reference, proofUrl: `${this.config.API_BASE_URL}/api/secure-objects/${proofToken}` }), `refund-verified:${order.id}`],
          );
          break;
        case "settle_refund":
          if (!actorRoles.some((role) => role === "owner" || role === "admin")) throw new ApiError(403, "ADMIN_REQUIRED", "Only an owner or admin can settle a refund.");
          await transition(client, order, "refund", "settled", actorId, action.reason);
          await client.query("UPDATE refunds SET status='settled',settled_at=now(),version=version+1 WHERE order_id=$1 AND status='verified'", [order.id]);
          break;
        case "approve_reschedule":
        case "reject_reschedule": {
          if (!action.rescheduleRequestId) throw new ApiError(422, "RESCHEDULE_ID_REQUIRED", "Choose a reschedule request.");
          const status = action.action === "approve_reschedule" ? "approved" : "rejected";
          const updated = await client.query(
            `UPDATE reschedule_requests SET status=$1,reviewed_at=now(),reviewed_by=$2,csr_notes=$3,redelivery_fee_centavos=$4
             WHERE id=$5 AND order_id=$6 AND status='requested' RETURNING id`,
            [status, actorId, action.reason, action.redeliveryFeeCentavos ?? null, action.rescheduleRequestId, order.id],
          );
          if (!updated.rowCount) throw new ApiError(409, "RESCHEDULE_CONFLICT", "The request was already handled or is invalid.");
          break;
        }
      }

      const version = await client.query<{ version: number }>("UPDATE orders SET version=version+1 WHERE id=$1 RETURNING version", [order.id]);
      const afterResult = await client.query("SELECT * FROM orders WHERE id=$1", [order.id]);
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,before_value,after_value,reason,request_id,ip_hash)
         VALUES ($1,$2,'order',$3,$4,$5,$6,$7,$8)`,
        [actorId, action.action, order.id, JSON.stringify(before), JSON.stringify(afterResult.rows[0]), action.reason,
          request.requestId ?? null, safeIpHash(request.ip)],
      );
      return { ok: true, order: afterResult.rows[0], version: version.rows[0].version };
    });
  }

  private async requireRefund(client: DbClient, order: LockedOrder, actorId: string, reason: string) {
    if (order.payment_method === "cod" && order.verified_paid_centavos === 0) return;
    const settings = await client.query<{ refund_sla_minutes: number }>("SELECT refund_sla_minutes FROM store_settings WHERE id=true");
    const dueAt = refundDeadline(new Date(), settings.rows[0]?.refund_sla_minutes ?? 5);
    await transition(client, order, "refund", "required", actorId, reason);
    await client.query("UPDATE orders SET refund_action_due_at=$1 WHERE id=$2", [dueAt, order.id]);
    const payment = await client.query<{ id: string }>("SELECT id FROM payments WHERE order_id=$1 ORDER BY created_at LIMIT 1", [order.id]);
    await client.query(
      `INSERT INTO refunds(order_id,payment_id,amount_centavos,reason,status,due_at)
       VALUES ($1,$2,$3,$4,'required',$5) ON CONFLICT (order_id,reason) DO NOTHING`,
      [order.id, payment.rows[0]?.id ?? null, order.verified_paid_centavos, reason, dueAt],
    );
  }
}
