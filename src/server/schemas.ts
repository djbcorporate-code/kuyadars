import { z } from "zod";

export const credentialsSchema = z.object({ email: z.email().max(254), password: z.string().min(12).max(128) });
export const registerSchema = credentialsSchema.extend({ fullName: z.string().trim().min(2).max(100), phone: z.string().trim().min(8).max(25) });

const itemSchema = z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(30) });
export const orderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2).max(100),
    email: z.email().max(254),
    phone: z.string().trim().min(8).max(25),
  }),
  items: z.array(itemSchema).min(1).max(10),
  address: z.object({
    coverageBarangayId: z.string().min(1).max(150),
    administrativeDistrict: z.string().min(1).max(80),
    streetAddress: z.string().trim().min(5).max(240),
    landmark: z.string().trim().min(2).max(160),
    instructions: z.string().trim().max(500).optional(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    pinSource: z.enum(["geolocation", "manual_map", "coordinates"]),
    roadAccessStatus: z.enum(["unverified", "accessible", "inaccessible", "ambiguous"]).default("unverified"),
  }),
  paymentMethod: z.enum(["cod", "gcash_manual"]),
  promotionCode: z.string().trim().toUpperCase().max(30).optional(),
  quotedDeliveryFeeCentavos: z.number().int().min(0),
});

export const quoteSchema = z.object({
  coverageBarangayId: z.string().min(1),
  administrativeDistrict: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  roadAccessStatus: z.enum(["unverified", "accessible", "inaccessible", "ambiguous"]).default("unverified"),
});

export const actionSchema = z.object({
  action: z.enum([
    "hold", "approve", "reject", "start_preparing", "mark_ready", "dispatch", "mark_unreachable",
    "confirm_rts", "mark_delivered", "verify_payment", "record_short_payment", "record_stockout",
    "initiate_refund", "verify_refund", "settle_refund", "approve_reschedule", "reject_reschedule",
  ]),
  reason: z.string().trim().min(3).max(500),
  expectedVersion: z.number().int().positive(),
  amountCentavos: z.number().int().min(0).optional(),
  merchantReference: z.string().trim().max(120).optional(),
  transactionTime: z.iso.datetime().optional(),
  riderName: z.string().trim().max(100).optional(),
  riderNotes: z.string().trim().max(500).optional(),
  riderConfirmed: z.boolean().optional(),
  returnedAt: z.iso.datetime().optional(),
  rescheduleRequestId: z.uuid().optional(),
  redeliveryFeeCentavos: z.number().int().min(0).optional(),
  evidenceObjectId: z.uuid().optional(),
});

export const contactAttemptSchema = z.object({
  channel: z.enum(["call", "sms", "email", "chat", "in_person"]),
  outcome: z.string().trim().min(2).max(120),
  notes: z.string().trim().max(500).optional(),
});
