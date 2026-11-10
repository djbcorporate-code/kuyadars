import { readFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import pg from "pg";
import { createHash } from "node:crypto";

type SeedBarangay = {
  id: string;
  legislative_district: string;
  administrative_district: string;
  barangay: string;
  service_status: "distance_based" | "blocked";
  minimum_order_php: number | null;
  notes: string | null;
};

type DeliverySeed = {
  schema_version: number;
  shop: { name: string; latitude: number; longitude: number; verify_entrance_pin_before_production: boolean };
  operating_rules: { online_ordering_open: string; online_ordering_close: string; chicken_unit_price_php: number };
  delivery_rules: {
    free_if_distance_lte_km: number;
    base_fee_if_distance_gt_7_lte_km: number;
    base_paid_zone_max_km: number;
    extra_fee_per_started_km_beyond_10_php: number;
  };
  barangays: SeedBarangay[];
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const raw = await readFile(path.join(process.cwd(), "data", "kuya_dars_davao_delivery_seed.json"), "utf8");
const seed = JSON.parse(raw) as DeliverySeed;
const uniqueIds = new Set(seed.barangays.map((item) => item.id));
const eligible = seed.barangays.filter((item) => item.service_status === "distance_based").length;
const blocked = seed.barangays.filter((item) => item.service_status === "blocked").length;
if (seed.barangays.length !== 182 || uniqueIds.size !== 182 || eligible !== 87 || blocked !== 95) {
  throw new Error(`Coverage invariant failed: total=${seed.barangays.length}, unique=${uniqueIds.size}, eligible=${eligible}, blocked=${blocked}`);
}

const pool = new pg.Pool({ connectionString, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const item of seed.barangays) {
    await client.query(
      `INSERT INTO coverage_barangays
       (id, legislative_district, administrative_district, barangay, service_status, minimum_order_centavos, notes, source_schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET legislative_district=EXCLUDED.legislative_district,
       administrative_district=EXCLUDED.administrative_district, barangay=EXCLUDED.barangay,
       service_status=EXCLUDED.service_status, minimum_order_centavos=EXCLUDED.minimum_order_centavos,
       notes=EXCLUDED.notes, source_schema_version=EXCLUDED.source_schema_version, updated_at=now()`,
      [item.id, item.legislative_district, item.administrative_district, item.barangay, item.service_status,
        item.minimum_order_php == null ? null : Math.round(item.minimum_order_php * 100), item.notes, seed.schema_version],
    );
  }

  await client.query(
    `INSERT INTO store_settings
     (id, store_name, store_latitude, store_longitude, entrance_pin_verified, ordering_open, ordering_close,
      free_radius_km, paid_zone_max_km, paid_zone_base_fee_centavos, extra_started_km_fee_centavos, merchant_name)
     VALUES (true,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET store_name=EXCLUDED.store_name, store_latitude=EXCLUDED.store_latitude,
     store_longitude=EXCLUDED.store_longitude, ordering_open=EXCLUDED.ordering_open, ordering_close=EXCLUDED.ordering_close,
     free_radius_km=EXCLUDED.free_radius_km, paid_zone_max_km=EXCLUDED.paid_zone_max_km,
     paid_zone_base_fee_centavos=EXCLUDED.paid_zone_base_fee_centavos,
     extra_started_km_fee_centavos=EXCLUDED.extra_started_km_fee_centavos`,
    [seed.shop.name, seed.shop.latitude, seed.shop.longitude, !seed.shop.verify_entrance_pin_before_production,
      seed.operating_rules.online_ordering_open, seed.operating_rules.online_ordering_close,
      seed.delivery_rules.free_if_distance_lte_km, seed.delivery_rules.base_paid_zone_max_km,
      seed.delivery_rules.base_fee_if_distance_gt_7_lte_km * 100,
      seed.delivery_rules.extra_fee_per_started_km_beyond_10_php * 100, process.env.GCASH_MERCHANT_NAME || null],
  );

  await client.query(
    `INSERT INTO products(slug,name,description,price_centavos,active,promo_eligible,stock_on_hand)
     VALUES ('lechon-manok','Lechon Manok','Extra Laki, Extra Sarap.', $1, true, true, 100)
     ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description`,
    [seed.operating_rules.chicken_unit_price_php * 100],
  );
  await client.query(
    `INSERT INTO promotions(code,name,discount_basis_points,first_order_only,requires_verified_identity,active)
     VALUES ('FIRST10','First verified order — 10% off',1000,true,true,true)
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name`,
  );

  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    if (adminPassword.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const result = await client.query<{ id: string }>(
      `INSERT INTO users(email,full_name,password_hash,email_verified_at)
       VALUES ($1,'Kuya Dars Owner',$2,now())
       ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, active=true
       RETURNING id`, [adminEmail, passwordHash],
    );
    await client.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'owner') ON CONFLICT DO NOTHING", [result.rows[0].id]);
  } else {
    console.warn("Owner not seeded: set ADMIN_EMAIL and ADMIN_PASSWORD before running db:seed.");
  }

  await client.query("COMMIT");
  console.log(`Seeded ${seed.barangays.length} barangays (${eligible} eligible, ${blocked} blocked). SHA-256 ${createHash("sha256").update(raw).digest("hex")}`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
