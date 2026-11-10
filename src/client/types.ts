export type Catalog = {
  settings: {
    store_name: string;
    store_latitude: string;
    store_longitude: string;
    entrance_pin_verified: boolean;
    orderingOpen: string;
    orderingClose: string;
    preparationCutoff: string;
    acceptingUntil: string;
    orderOpenNow: boolean;
    gcash_configured: boolean;
    gcashQrUrl: string | null;
    free_radius_km: string;
    paid_zone_max_km: string;
    paid_zone_base_fee_centavos: number;
    extra_started_km_fee_centavos: number;
  };
  products: Array<{ id: string; slug: string; name: string; description: string; price_centavos: number; available_stock: number }>;
  coverage: Array<{ id: string; legislative_district: string; administrative_district: string; barangay: string; service_status: "distance_based" | "blocked" }>;
};

export type User = { id: string; email: string; fullName: string; roles: string[] };

export type TrackingOrder = {
  id: string;
  reference: string;
  customer_name: string;
  review_status: string;
  payment_status: string;
  payment_method: string;
  fulfillment_status: string;
  delivery_status: string;
  refund_status: string;
  subtotal_centavos: number;
  discount_centavos: number;
  delivery_fee_centavos: number;
  total_centavos: number;
  verified_paid_centavos: number;
  outstanding_centavos: number;
  balance_resolution: string | null;
  distance_km: string;
  exception_code: string | null;
  exception_notes: string | null;
  refund_action_due_at: string | null;
  submitted_at: string;
  version: number;
  address: { barangay: string; district: string; street: string; landmark: string; latitude: string; longitude: string; needsCsrReview: boolean };
  items: Array<{ name: string; quantity: number; unitPriceCentavos: number }>;
  timeline: Array<{ domain: string; from: string | null; to: string; reason: string; at: string }>;
  reschedules: Array<{ id: string; status: string; requestedSlot: string | null; requiresFreshPreparation: boolean; redeliveryFeeCentavos: number | null }>;
};
