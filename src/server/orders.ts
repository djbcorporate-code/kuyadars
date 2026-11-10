import { randomBytes } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { Database, DbClient } from "./db.js";
import { inTransaction } from "./db.js";
import { ApiError } from "./errors.js";
import type { AppRequest } from "./security.js";
import { randomToken, sha256 } from "./security.js";
import { deliveryFeeCentavos, haversineKm, isOrderingOpen, validateDavaoPin, type DeliveryRate } from "../shared/domain.js";
import type { z } from "zod";
import type { orderSchema, quoteSchema } from "./schemas.js";

type QuoteInput = z.infer<typeof quoteSchema>;
type OrderInput = z.infer<typeof orderSchema>;

type StoreSettings = {
  store_latitude: string;
  store_longitude: string;
  ordering_open: string;
  ordering_close: string;
  preparation_cutoff: string;
  daily_order_capacity: number;
  free_radius_km: string;
  paid_zone_max_km: string;
  paid_zone_base_fee_centavos: number;
  extra_started_km_fee_centavos: number;
  merchant_qr_object_key: string | null;
  refund_sla_minutes: number;
};

type Coverage = {
  id: string;
  legislative_district: string;
  administrative_district: string;
  barangay: string;
  service_status: "distance_based" | "blocked";
};

function rateFrom(settings: StoreSettings): DeliveryRate {
  return {
    freeRadiusKm: Number(settings.free_radius_km),
    paidZoneMaxKm: Number(settings.paid_zone_max_km),
    paidZoneBaseFeeCentavos: settings.paid_zone_base_fee_centavos,
    extraStartedKmFeeCentavos: settings.extra_started_km_fee_centavos,
  };
}

function makeReference() {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "2-digit", month: "2-digit", day: "2-digit" })
    .format(new Date()).replaceAll("-", "");
  return `KD-${date}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

async function loadQuoteRows(db: Pick<Database, "query">, input: QuoteInput) {
  const [settingsResult, coverageResult] = await Promise.all([
    db.query<StoreSettings>("SELECT * FROM store_settings WHERE id=true"),
    db.query<Coverage>("SELECT * FROM coverage_barangays WHERE id=$1", [input.coverageBarangayId]),
  ]);
  if (!settingsResult.rowCount) throw new ApiError(503, "STORE_NOT_CONFIGURED", "Store settings are not configured.");
  if (!coverageResult.rowCount) throw new ApiError(422, "BARANGAY_UNLISTED", "This barangay is not in the approved delivery list.");
  const coverage = coverageResult.rows[0];
  if (coverage.service_status === "blocked") throw new ApiError(422, "BARANGAY_BLOCKED", `${coverage.barangay} is outside the approved delivery area.`);
  if (coverage.administrative_district !== input.administrativeDistrict) {
    throw new ApiError(422, "DISTRICT_MISMATCH", "The barangay does not belong to the selected district.");
  }
  const pin = validateDavaoPin(input.latitude, input.longitude);
  if (!pin.valid) throw new ApiError(422, "INVALID_PIN", pin.reason!);
  return { settings: settingsResult.rows[0], coverage };
}

async function releaseExpiredReservations(client: DbClient) {
  const expired = await client.query<{ id: string; product_id: string; quantity: number }>(
    `SELECT id,product_id,quantity FROM inventory_reservations
     WHERE state='reserved' AND expires_at IS NOT NULL AND expires_at<=now()
     FOR UPDATE SKIP LOCKED`,
  );
  for (const reservation of expired.rows) {
    await client.query("UPDATE products SET stock_reserved=GREATEST(0,stock_reserved-$1),version=version+1 WHERE id=$2", [reservation.quantity, reservation.product_id]);
    await client.query("UPDATE inventory_reservations SET state='expired',updated_at=now() WHERE id=$1", [reservation.id]);
    await client.query(
      "INSERT INTO inventory_events(product_id,reserved_delta,reason) VALUES ($1,$2,'Pending payment reservation expired')",
      [reservation.product_id, -reservation.quantity],
    );
  }
}

export class OrderService {
  constructor(private readonly db: Database, private readonly config: AppConfig) {}

  async quote(input: QuoteInput) {
    const { settings, coverage } = await loadQuoteRows(this.db, input);
    const distanceKm = haversineKm(
      { latitude: Number(settings.store_latitude), longitude: Number(settings.store_longitude) },
      { latitude: input.latitude, longitude: input.longitude },
    );
    const feeCentavos = deliveryFeeCentavos(distanceKm, rateFrom(settings));
    const accessConcern = input.roadAccessStatus !== "accessible";
    return {
      coverage: { id: coverage.id, barangay: coverage.barangay, administrativeDistrict: coverage.administrative_district },
      distanceKm,
      deliveryFeeCentavos: feeCentavos,
      method: "great_circle_haversine_km",
      needsCsrReview: true,
      warning: accessConcern
        ? "The fee is calculated, but road access and pin/address consistency require CSR review before acceptance."
        : "The fee is calculated from the pin; barangay-polygon consistency still requires CSR review before acceptance.",
    };
  }

  async create(input: OrderInput, idempotencyKey: string, request: AppRequest) {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a unique Idempotency-Key header (8–128 characters)." );
    }
    const requestHash = sha256(JSON.stringify(input));
    return inTransaction(this.db, async (client) => {
      const claimed = await client.query(
        `INSERT INTO idempotency_keys(scope,key,request_hash) VALUES ('create-order',$1,$2)
         ON CONFLICT DO NOTHING RETURNING key`, [idempotencyKey, requestHash],
      );
      if (!claimed.rowCount) {
        const prior = await client.query<{ request_hash: string; response_status: number | null; response_body: unknown }>(
          "SELECT request_hash,response_status,response_body FROM idempotency_keys WHERE scope='create-order' AND key=$1", [idempotencyKey],
        );
        if (prior.rows[0]?.request_hash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_MISMATCH", "This idempotency key was used for a different request.");
        if (!prior.rows[0]?.response_body) throw new ApiError(409, "REQUEST_IN_PROGRESS", "This order request is still processing.");
        return prior.rows[0].response_body;
      }

      await releaseExpiredReservations(client);
      const { settings, coverage } = await loadQuoteRows(client as unknown as Database, {
        coverageBarangayId: input.address.coverageBarangayId,
        administrativeDistrict: input.address.administrativeDistrict,
        latitude: input.address.latitude,
        longitude: input.address.longitude,
        roadAccessStatus: input.address.roadAccessStatus,
      });
      if (!isOrderingOpen(new Date(), settings.ordering_open.slice(0, 5), settings.ordering_close.slice(0, 5))) {
        throw new ApiError(422, "ORDERING_CLOSED", `Online ordering is open ${settings.ordering_open.slice(0, 5)}–${settings.ordering_close.slice(0, 5)} Asia/Manila.`);
      }
      if (!isOrderingOpen(new Date(), settings.ordering_open.slice(0, 5), settings.preparation_cutoff.slice(0, 5))) {
        throw new ApiError(422, "PREPARATION_CUTOFF", `Today's configurable preparation cutoff is ${settings.preparation_cutoff.slice(0, 5)} Asia/Manila.`);
      }
      const capacity = await client.query<{ count: string }>(
        `SELECT count(*)::text count FROM orders
         WHERE (submitted_at AT TIME ZONE 'Asia/Manila')::date=(now() AT TIME ZONE 'Asia/Manila')::date
         AND fulfillment_status NOT IN ('cancelled')`,
      );
      if (Number(capacity.rows[0].count) >= settings.daily_order_capacity) throw new ApiError(422, "DAILY_CAPACITY_REACHED", "Today's online order capacity is full.");
      if (input.paymentMethod === "gcash_manual" && !settings.merchant_qr_object_key) {
        throw new ApiError(422, "GCASH_NOT_CONFIGURED", "Manual GCash is unavailable until the approved merchant QR is configured.");
      }

      const distanceKm = haversineKm(
        { latitude: Number(settings.store_latitude), longitude: Number(settings.store_longitude) },
        { latitude: input.address.latitude, longitude: input.address.longitude },
      );
      const rate = rateFrom(settings);
      const feeCentavos = deliveryFeeCentavos(distanceKm, rate);
      if (input.quotedDeliveryFeeCentavos !== feeCentavos) {
        throw new ApiError(409, "DELIVERY_FEE_CHANGED", "The delivery fee changed. Review and acknowledge the new total.", { deliveryFeeCentavos: feeCentavos, distanceKm });
      }

      const itemMap = new Map(input.items.map((item) => [item.productId, (itemMapValue(item.productId, input.items))]));
      const productIds = [...itemMap.keys()].sort();
      const products = await client.query<{
        id: string; name: string; price_centavos: number; active: boolean; promo_eligible: boolean; stock_on_hand: number; stock_reserved: number;
      }>("SELECT id,name,price_centavos,active,promo_eligible,stock_on_hand,stock_reserved FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [productIds]);
      if (products.rowCount !== productIds.length) throw new ApiError(422, "PRODUCT_NOT_FOUND", "One or more products no longer exist.");
      let subtotal = 0;
      for (const product of products.rows) {
        const quantity = itemMap.get(product.id)!;
        if (!product.active) throw new ApiError(422, "PRODUCT_UNAVAILABLE", `${product.name} is unavailable.`);
        if (product.stock_on_hand - product.stock_reserved < quantity) throw new ApiError(409, "INSUFFICIENT_STOCK", `Only ${Math.max(0, product.stock_on_hand - product.stock_reserved)} ${product.name} remain.`);
        subtotal += product.price_centavos * quantity;
      }

      let promotion: { id: string; discount_basis_points: number } | null = null;
      let discount = 0;
      let promoIdentity: string | null = null;
      if (input.promotionCode) {
        if (!request.auth?.roles.includes("customer")) throw new ApiError(422, "VERIFIED_ACCOUNT_REQUIRED", "Sign in to a verified customer account to use the first-order promotion.");
        const verified = await client.query<{ email: string; email_verified: boolean; phone_verified: boolean }>(
          "SELECT email,(email_verified_at IS NOT NULL) email_verified,(phone_verified_at IS NOT NULL) phone_verified FROM users WHERE id=$1", [request.auth.id],
        );
        if (!verified.rows[0]?.email_verified && !verified.rows[0]?.phone_verified) throw new ApiError(422, "VERIFICATION_REQUIRED", "Verify your email or phone before using this promotion.");
        const promoResult = await client.query<{ id: string; discount_basis_points: number }>(
          `SELECT id,discount_basis_points FROM promotions WHERE code=$1 AND active
           AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())`, [input.promotionCode],
        );
        if (!promoResult.rowCount) throw new ApiError(422, "PROMOTION_INVALID", "This promotion is unavailable.");
        promotion = promoResult.rows[0];
        promoIdentity = sha256(`verified-email:${verified.rows[0].email.trim().toLowerCase()}`);
        const used = await client.query("SELECT 1 FROM promo_redemptions WHERE promotion_id=$1 AND identity_key_hash=$2", [promotion.id, promoIdentity]);
        if (used.rowCount) throw new ApiError(409, "PROMOTION_ALREADY_USED", "The first-order promotion has already been used.");
        const eligibleSubtotal = products.rows.filter((product) => product.promo_eligible)
          .reduce((sum, product) => sum + product.price_centavos * itemMap.get(product.id)!, 0);
        discount = Math.floor((eligibleSubtotal * promotion.discount_basis_points) / 10_000);
      }

      const total = subtotal - discount + feeCentavos;
      const trackingToken = randomToken(36);
      const reference = makeReference();
      const exceptionCode = input.address.roadAccessStatus === "inaccessible" ? "INACCESSIBLE_ADDRESS"
        : input.address.roadAccessStatus === "ambiguous" ? "AMBIGUOUS_ACCESS" : "PIN_ADDRESS_REVIEW";
      const orderResult = await client.query<{ id: string }>(
        `INSERT INTO orders(reference,user_id,tracking_token_hash,customer_name,customer_email,customer_phone,
         payment_status,payment_method,subtotal_centavos,discount_centavos,delivery_fee_centavos,total_centavos,
         outstanding_centavos,distance_km,fee_rule_snapshot,pricing_snapshot,exception_code)
         VALUES ($1,$2,$3,$4,$5,$6,'unpaid',$7,$8,$9,$10,$11,$11,$12,$13,$14,$15) RETURNING id`,
        [reference, request.auth?.roles.includes("customer") ? request.auth.id : null, sha256(trackingToken), input.customer.name,
          input.customer.email.toLowerCase(), input.customer.phone, input.paymentMethod, subtotal, discount, feeCentavos, total,
          distanceKm, JSON.stringify({ method: "great_circle_haversine_km", ...rate, blockedBarangaysOverrideDistance: true }),
          JSON.stringify({ items: products.rows.map((product) => ({ id: product.id, name: product.name, unitPriceCentavos: product.price_centavos, quantity: itemMap.get(product.id) })), promotionCode: input.promotionCode ?? null }), exceptionCode],
      );
      const orderId = orderResult.rows[0].id;
      await client.query(
        `INSERT INTO delivery_addresses(order_id,coverage_barangay_id,legislative_district,administrative_district,barangay,
         street_address,landmark,instructions,latitude,longitude,pin_source,pin_address_consistency,road_access_status,needs_csr_review)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unverified',$12,true)`,
        [orderId, coverage.id, coverage.legislative_district, coverage.administrative_district, coverage.barangay,
          input.address.streetAddress, input.address.landmark, input.address.instructions ?? null, input.address.latitude,
          input.address.longitude, input.address.pinSource, input.address.roadAccessStatus],
      );
      for (const product of products.rows) {
        const quantity = itemMap.get(product.id)!;
        await client.query(
          `INSERT INTO order_items(order_id,product_id,product_name_snapshot,unit_price_centavos,quantity,line_total_centavos)
           VALUES ($1,$2,$3,$4,$5,$6)`, [orderId, product.id, product.name, product.price_centavos, quantity, product.price_centavos * quantity],
        );
        const expiresAt = input.paymentMethod === "gcash_manual" ? new Date(Date.now() + 30 * 60_000) : null;
        await client.query("UPDATE products SET stock_reserved=stock_reserved+$1,version=version+1 WHERE id=$2", [quantity, product.id]);
        await client.query("INSERT INTO inventory_reservations(order_id,product_id,quantity,expires_at) VALUES ($1,$2,$3,$4)", [orderId, product.id, quantity, expiresAt]);
        await client.query("INSERT INTO inventory_events(product_id,order_id,reserved_delta,reason) VALUES ($1,$2,$3,'Order submitted')", [product.id, orderId, quantity]);
      }
      if (promotion && promoIdentity) {
        await client.query(
          "INSERT INTO promo_redemptions(promotion_id,order_id,identity_key_hash,discount_centavos) VALUES ($1,$2,$3,$4)",
          [promotion.id, orderId, promoIdentity, discount],
        );
      }
      await client.query(
        `INSERT INTO payments(order_id,method,amount_expected_centavos,status)
         VALUES ($1,$2,$3,'unpaid')`, [orderId, input.paymentMethod, total],
      );
      await client.query(
        `INSERT INTO status_transitions(order_id,domain,to_value,reason,actor_id)
         VALUES ($1,'review','awaiting_review','Order submitted for CSR review',$2),
                ($1,'fulfillment','submitted','Order submitted; no automatic acceptance',$2)`, [orderId, request.auth?.id ?? null],
      );
      const trackingUrl = `${this.config.APP_BASE_URL}/track/${trackingToken}`;
      await client.query(
        `INSERT INTO notification_outbox(order_id,user_id,template,recipient,payload,idempotency_key)
         VALUES ($1,$2,'order_submitted',$3,$4,$5) ON CONFLICT DO NOTHING`,
        [orderId, request.auth?.id ?? null, input.customer.email.toLowerCase(), JSON.stringify({ reference, trackingUrl, totalCentavos: total }), `order-submitted:${orderId}`],
      );
      const response = {
        orderId, reference, trackingToken, trackingUrl,
        status: "awaiting_review", paymentStatus: "unpaid", paymentMethod: input.paymentMethod,
        totals: { subtotalCentavos: subtotal, discountCentavos: discount, deliveryFeeCentavos: feeCentavos, totalCentavos: total },
        distanceKm,
        message: "Order submitted for CSR review. It is not yet accepted or preparing.",
      };
      await client.query(
        `UPDATE idempotency_keys SET response_status=201,response_body=$1,order_id=$2 WHERE scope='create-order' AND key=$3`,
        [JSON.stringify(response), orderId, idempotencyKey],
      );
      return response;
    });
  }
}

function itemMapValue(productId: string, items: OrderInput["items"]): number {
  return items.filter((item) => item.productId === productId).reduce((sum, item) => sum + item.quantity, 0);
}
