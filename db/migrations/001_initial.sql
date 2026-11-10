CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  phone text,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  code text PRIMARY KEY CHECK (code IN ('owner', 'admin', 'csr', 'rider', 'customer')),
  description text NOT NULL
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code text NOT NULL REFERENCES roles(code),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_active_idx ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coverage_barangays (
  id text PRIMARY KEY,
  legislative_district text NOT NULL,
  administrative_district text NOT NULL,
  barangay text NOT NULL,
  service_status text NOT NULL CHECK (service_status IN ('distance_based', 'blocked')),
  minimum_order_centavos integer,
  notes text,
  source_schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (administrative_district, barangay)
);

CREATE TABLE store_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  store_name text NOT NULL,
  store_latitude numeric(10,7) NOT NULL,
  store_longitude numeric(10,7) NOT NULL,
  entrance_pin_verified boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'Asia/Manila',
  ordering_open time NOT NULL DEFAULT '08:00',
  ordering_close time NOT NULL DEFAULT '22:00',
  preparation_cutoff time NOT NULL DEFAULT '22:00',
  daily_order_capacity integer NOT NULL DEFAULT 200 CHECK (daily_order_capacity >= 0),
  free_radius_km numeric(8,3) NOT NULL DEFAULT 7,
  paid_zone_max_km numeric(8,3) NOT NULL DEFAULT 10,
  paid_zone_base_fee_centavos integer NOT NULL DEFAULT 3000,
  extra_started_km_fee_centavos integer NOT NULL DEFAULT 1000,
  refund_sla_minutes integer NOT NULL DEFAULT 5 CHECK (refund_sla_minutes > 0),
  merchant_qr_object_key text,
  merchant_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_centavos integer NOT NULL CHECK (price_centavos >= 0),
  active boolean NOT NULL DEFAULT true,
  promo_eligible boolean NOT NULL DEFAULT true,
  stock_on_hand integer NOT NULL DEFAULT 0 CHECK (stock_on_hand >= 0),
  stock_reserved integer NOT NULL DEFAULT 0 CHECK (stock_reserved >= 0 AND stock_reserved <= stock_on_hand),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  discount_basis_points integer NOT NULL CHECK (discount_basis_points BETWEEN 0 AND 10000),
  first_order_only boolean NOT NULL DEFAULT true,
  requires_verified_identity boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  user_id uuid REFERENCES users(id),
  tracking_token_hash text NOT NULL UNIQUE,
  customer_name text NOT NULL,
  customer_email citext NOT NULL,
  customer_phone text NOT NULL,
  review_status text NOT NULL DEFAULT 'awaiting_review' CHECK (review_status IN ('awaiting_review','on_hold','approved','rejected')),
  payment_status text NOT NULL CHECK (payment_status IN ('unpaid','evidence_submitted','under_review','short','verified','rejected','duplicate','collected')),
  fulfillment_status text NOT NULL DEFAULT 'submitted' CHECK (fulfillment_status IN ('submitted','confirmed','preparing','ready','completed','cancelled','stock_out')),
  delivery_status text NOT NULL DEFAULT 'not_scheduled' CHECK (delivery_status IN ('not_scheduled','ready_for_dispatch','out_for_delivery','unreachable','rts','delivered','failed')),
  refund_status text NOT NULL DEFAULT 'not_required' CHECK (refund_status IN ('not_required','required','initiated','verified','settled','rejected')),
  payment_method text NOT NULL CHECK (payment_method IN ('cod','gcash_manual')),
  currency text NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
  subtotal_centavos integer NOT NULL CHECK (subtotal_centavos >= 0),
  discount_centavos integer NOT NULL DEFAULT 0 CHECK (discount_centavos >= 0),
  delivery_fee_centavos integer NOT NULL CHECK (delivery_fee_centavos >= 0),
  total_centavos integer NOT NULL CHECK (total_centavos >= 0),
  verified_paid_centavos integer NOT NULL DEFAULT 0 CHECK (verified_paid_centavos >= 0),
  outstanding_centavos integer NOT NULL CHECK (outstanding_centavos >= 0),
  balance_resolution text CHECK (balance_resolution IN ('pay_online','collect_on_delivery')),
  distance_km numeric(10,6) NOT NULL CHECK (distance_km >= 0),
  fee_rule_snapshot jsonb NOT NULL,
  pricing_snapshot jsonb NOT NULL,
  exception_code text,
  exception_notes text,
  stockout_recorded_at timestamptz,
  refund_action_due_at timestamptz,
  rider_confirmation_name text,
  rider_confirmation_notes text,
  rider_confirmed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_queue_idx ON orders(review_status, payment_status, fulfillment_status, delivery_status, submitted_at);
CREATE INDEX orders_customer_idx ON orders(user_id, submitted_at DESC);

CREATE TABLE delivery_addresses (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  coverage_barangay_id text NOT NULL REFERENCES coverage_barangays(id),
  legislative_district text NOT NULL,
  administrative_district text NOT NULL,
  barangay text NOT NULL,
  street_address text NOT NULL,
  landmark text NOT NULL,
  instructions text,
  latitude numeric(10,7) NOT NULL,
  longitude numeric(10,7) NOT NULL,
  pin_source text NOT NULL CHECK (pin_source IN ('geolocation','manual_map','coordinates')),
  pin_address_consistency text NOT NULL CHECK (pin_address_consistency IN ('unverified','consistent','mismatch')),
  road_access_status text NOT NULL CHECK (road_access_status IN ('unverified','accessible','inaccessible','ambiguous')),
  needs_csr_review boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  product_name_snapshot text NOT NULL,
  unit_price_centavos integer NOT NULL CHECK (unit_price_centavos >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  line_total_centavos integer NOT NULL CHECK (line_total_centavos >= 0)
);

CREATE TABLE inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','committed','released','expired')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id)
);

CREATE TABLE inventory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  order_id uuid REFERENCES orders(id),
  actor_id uuid REFERENCES users(id),
  on_hand_delta integer NOT NULL DEFAULT 0,
  reserved_delta integer NOT NULL DEFAULT 0,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promo_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES promotions(id),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  identity_key_hash text NOT NULL,
  discount_centavos integer NOT NULL CHECK (discount_centavos >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, identity_key_hash)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('cod','gcash_manual')),
  kind text NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary','additional','collection')),
  amount_expected_centavos integer NOT NULL CHECK (amount_expected_centavos >= 0),
  amount_verified_centavos integer NOT NULL DEFAULT 0 CHECK (amount_verified_centavos >= 0),
  status text NOT NULL CHECK (status IN ('unpaid','evidence_submitted','under_review','verified','short','rejected','duplicate','collected')),
  customer_reference text,
  verified_merchant_reference text,
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  sha256 text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('payment_evidence','refund_evidence','merchant_qr')),
  scan_status text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','rejected','unavailable')),
  uploaded_by uuid REFERENCES users(id),
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES private_objects(id),
  submitted_reference text NOT NULL,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','accepted','rejected','duplicate')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE object_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES private_objects(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  max_accesses integer NOT NULL DEFAULT 5 CHECK (max_accesses > 0),
  access_count integer NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  payment_id uuid REFERENCES payments(id),
  amount_centavos integer NOT NULL CHECK (amount_centavos > 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'required' CHECK (status IN ('required','initiated','verified','settled','rejected')),
  due_at timestamptz NOT NULL,
  initiated_at timestamptz,
  initiated_by uuid REFERENCES users(id),
  merchant_reference text,
  transaction_time timestamptz,
  evidence_object_id uuid REFERENCES private_objects(id),
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id),
  settled_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, reason)
);

CREATE TABLE contact_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  channel text NOT NULL CHECK (channel IN ('call','sms','email','chat','in_person')),
  outcome text NOT NULL,
  notes text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rts_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  unreachable_recorded_at timestamptz NOT NULL,
  physically_returned_at timestamptz NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reschedule_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  token_hash text NOT NULL UNIQUE,
  requested_slot timestamptz,
  customer_notes text,
  status text NOT NULL DEFAULT 'link_issued' CHECK (status IN ('link_issued','requested','approved','rejected','expired','used')),
  expires_at timestamptz NOT NULL,
  requested_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  csr_notes text,
  requires_fresh_preparation boolean NOT NULL DEFAULT true,
  redelivery_fee_centavos integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rider_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  rider_user_id uuid REFERENCES users(id),
  rider_name_snapshot text NOT NULL,
  assigned_by uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES orders(id),
  user_id uuid REFERENCES users(id),
  channel text NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
  template text NOT NULL,
  recipient citext NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_pending_idx ON notification_outbox(status, next_attempt_at);

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  order_id uuid REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (scope, key)
);

CREATE TABLE status_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain IN ('review','payment','fulfillment','delivery','refund','balance')),
  from_value text,
  to_value text NOT NULL,
  reason text NOT NULL,
  actor_id uuid REFERENCES users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  reason text,
  request_id text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_logs(entity_type, entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notifications_updated_at BEFORE UPDATE ON notification_outbox FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION prevent_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;

CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER transitions_immutable BEFORE UPDATE OR DELETE ON status_transitions FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

INSERT INTO roles(code, description) VALUES
  ('owner','Full business ownership and security administration'),
  ('admin','Settings, staff, audit, and refund administration'),
  ('csr','Order, payment-review, dispatch, and exception operations'),
  ('rider','Limited assigned-delivery operations'),
  ('customer','Customer account and order history')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
