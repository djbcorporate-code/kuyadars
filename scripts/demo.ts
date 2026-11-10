import { createHash } from "node:crypto";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
const secret = process.env.DEMO_TRACKING_SECRET;
if (!connectionString) throw new Error("DATABASE_URL is required");
if (!secret || secret.length < 16) throw new Error("DEMO_TRACKING_SECRET must be at least 16 characters");
if (process.env.NODE_ENV === "production") throw new Error("Demo data is disabled in production");

const db = new pg.Pool({ connectionString, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
const product = (await db.query<{ id: string; name: string; price_centavos: number }>("SELECT id,name,price_centavos FROM products WHERE slug='lechon-manok'")).rows[0];
const coverage = (await db.query<{ id: string; legislative_district: string; administrative_district: string; barangay: string }>("SELECT id,legislative_district,administrative_district,barangay FROM coverage_barangays WHERE service_status='distance_based' ORDER BY id LIMIT 1")).rows[0];
if (!product || !coverage) throw new Error("Run db:migrate and db:seed first");

const scenarios = [
  { reference: "DEMO-COD-DELIVERED", review: "approved", payment: "collected", paymentMethod: "cod", fulfillment: "completed", delivery: "delivered", refund: "not_required", paid: 28000, outstanding: 0, exception: null, due: null },
  { reference: "DEMO-GCASH-REVIEW", review: "awaiting_review", payment: "evidence_submitted", paymentMethod: "gcash_manual", fulfillment: "submitted", delivery: "not_scheduled", refund: "not_required", paid: 0, outstanding: 28000, exception: "PIN_ADDRESS_REVIEW", due: null },
  { reference: "DEMO-SHORT-PAYMENT", review: "on_hold", payment: "short", paymentMethod: "gcash_manual", fulfillment: "submitted", delivery: "not_scheduled", refund: "not_required", paid: 20000, outstanding: 8000, exception: null, due: null },
  { reference: "DEMO-RTS-RESCHEDULE", review: "approved", payment: "unpaid", paymentMethod: "cod", fulfillment: "ready", delivery: "rts", refund: "not_required", paid: 0, outstanding: 28000, exception: "CUSTOMER_UNREACHABLE", due: null },
  { reference: "DEMO-REFUND-OVERDUE", review: "approved", payment: "verified", paymentMethod: "gcash_manual", fulfillment: "stock_out", delivery: "not_scheduled", refund: "required", paid: 28000, outstanding: 0, exception: "STOCK_OUT", due: new Date(Date.now() - 10 * 60_000) },
] as const;

for (const scenario of scenarios) {
  const trackingToken = createHash("sha256").update(`${secret}:${scenario.reference}`).digest("base64url");
  const existing = await db.query<{ id: string }>("SELECT id FROM orders WHERE reference=$1", [scenario.reference]);
  let orderId = existing.rows[0]?.id;
  if (!orderId) {
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders(reference,tracking_token_hash,customer_name,customer_email,customer_phone,review_status,payment_status,
       payment_method,fulfillment_status,delivery_status,refund_status,subtotal_centavos,delivery_fee_centavos,total_centavos,
       verified_paid_centavos,outstanding_centavos,distance_km,fee_rule_snapshot,pricing_snapshot,exception_code,refund_action_due_at,
       confirmed_at,delivered_at,rider_confirmation_name,rider_confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,28000,0,28000,$12,$13,1.25,$14,$15,$16,$17,
       CASE WHEN $6='approved' THEN now() ELSE NULL END,CASE WHEN $10='delivered' THEN now() ELSE NULL END,
       CASE WHEN $10='delivered' THEN 'Demo Rider' ELSE NULL END,CASE WHEN $10='delivered' THEN now() ELSE NULL END) RETURNING id`,
      [scenario.reference, createHash("sha256").update(trackingToken).digest("hex"), "Demo Customer", `demo+${scenario.reference.toLowerCase()}@example.invalid`,
        "09170000000", scenario.review, scenario.payment, scenario.paymentMethod, scenario.fulfillment, scenario.delivery, scenario.refund,
        scenario.paid, scenario.outstanding, JSON.stringify({ method: "great_circle_haversine_km", freeRadiusKm: 7, paidZoneMaxKm: 10, paidZoneBaseFeeCentavos: 3000, extraStartedKmFeeCentavos: 1000 }),
        JSON.stringify({ items: [{ id: product.id, name: product.name, unitPriceCentavos: product.price_centavos, quantity: 1 }] }), scenario.exception, scenario.due],
    );
    orderId = order.rows[0].id;
    await db.query(
      `INSERT INTO delivery_addresses(order_id,coverage_barangay_id,legislative_district,administrative_district,barangay,street_address,
       landmark,latitude,longitude,pin_source,pin_address_consistency,road_access_status,needs_csr_review)
       VALUES ($1,$2,$3,$4,$5,'Demo Street, Davao City','Demo landmark',7.1385,125.5885,'manual_map','unverified','unverified',true)`,
      [orderId, coverage.id, coverage.legislative_district, coverage.administrative_district, coverage.barangay],
    );
    await db.query(
      `INSERT INTO order_items(order_id,product_id,product_name_snapshot,unit_price_centavos,quantity,line_total_centavos)
       VALUES ($1,$2,$3,$4,1,$4)`, [orderId, product.id, product.name, product.price_centavos],
    );
    await db.query(
      `INSERT INTO payments(order_id,method,amount_expected_centavos,amount_verified_centavos,status,verified_at)
       VALUES ($1,$2,28000,$3,$4,CASE WHEN $3>0 THEN now() ELSE NULL END)`,
      [orderId, scenario.paymentMethod, scenario.paid, scenario.payment],
    );
    await db.query(
      `INSERT INTO status_transitions(order_id,domain,to_value,reason) VALUES
       ($1,'review',$2,'Demo scenario'),($1,'payment',$3,'Demo scenario'),($1,'fulfillment',$4,'Demo scenario'),($1,'delivery',$5,'Demo scenario')`,
      [orderId, scenario.review, scenario.payment, scenario.fulfillment, scenario.delivery],
    );
    if (scenario.reference === "DEMO-RTS-RESCHEDULE") {
      await db.query(
        `INSERT INTO rts_records(order_id,unreachable_recorded_at,physically_returned_at,recorded_by,notes)
         SELECT $1,now()-interval '1 hour',now()-interval '30 minutes',u.id,'Demo RTS' FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role_code='owner' LIMIT 1`, [orderId],
      );
      await db.query(
        `INSERT INTO reschedule_requests(order_id,token_hash,requested_slot,customer_notes,status,expires_at,requested_at)
         VALUES ($1,$2,now()+interval '1 day','Please deliver after 5 PM','requested',now()+interval '48 hours',now())`,
        [orderId, createHash("sha256").update(`${trackingToken}:reschedule`).digest("hex")],
      );
    }
    if (scenario.refund === "required") {
      const payment = await db.query<{ id: string }>("SELECT id FROM payments WHERE order_id=$1", [orderId]);
      await db.query(
        `INSERT INTO refunds(order_id,payment_id,amount_centavos,reason,status,due_at)
         VALUES ($1,$2,28000,'Demo paid stock-out','required',$3)`, [orderId, payment.rows[0].id, scenario.due],
      );
    }
  }
  console.log(`${scenario.reference}: http://localhost:5173/track/${trackingToken}`);
}

console.log("Blocked-delivery demonstration: select any barangay marked ‘not serviceable’ in checkout; the quote API rejects it before radius pricing.");
await db.end();
