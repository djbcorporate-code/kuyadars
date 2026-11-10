# Kuya Dars Lechon Manok Online Ordering Platform

A production-minded MVP for guest/customer ordering, Davao City delivery pricing, secure order tracking, manual GCash review, COD, atomic inventory, and CSR/admin operations.

## Architecture

- **Customer + CSR UI:** React 19, Vite, React Router, Leaflet/OpenStreetMap tiles
- **API:** Node.js, Express 5, TypeScript, Zod validation, secure cookie sessions, CSRF checks, Helmet and rate limits
- **Database:** PostgreSQL 17 with SQL migrations, transactions, row locks, optimistic order versions, immutable audit/status logs
- **Private files:** S3-compatible object storage in production; private local filesystem only for development
- **Notifications:** PostgreSQL outbox with idempotency, retries, SMTP worker, and refund-deadline manager escalation
- **Tests:** Vitest business-rule and authoritative-seed tests

Money is stored as integer centavos. Timestamps are stored as UTC and displayed in Asia/Manila.

## What is implemented

- Authoritative import of all **182** Davao City barangays: **87 distance-based, 95 blocked**. Blocked and unlisted barangays are rejected before distance pricing.
- Haversine fee snapshots with exact 7 km / 10 km boundaries; historical orders keep their original product and fee snapshots.
- Server-enforced 08:00–22:00 order window, daily capacity, preparation cutoff setting, stock availability, atomic reservations, and GCash reservation expiry.
- Guest checkout plus optional accounts/email verification. `FIRST10` is transactional, verified-account-only, one redemption per identity, with no invented minimum or cap.
- Secure unguessable tracking links; no customer data is exposed by a public order reference.
- Manual GCash receipt upload and merchant review. Uploading evidence never verifies payment. GCash checkout is disabled until an approved merchant QR is configured.
- Separate review, payment, fulfillment, delivery, and refund states with explicit transitions and optimistic locking.
- Short-payment online/COD balance choice, contact attempts, unreachable → physical RTS → single-use rescheduling, and fresh-preparation requirement.
- Paid stock-out refund timer stored on the server, five-minute initiation/documentation SLA, manager escalation, private proof, admin verification, and settlement separation. Unpaid COD does not create a refund.
- Responsive customer flow, tracker, role-protected CSR queues/counters, admin product/inventory/hours/capacity/QR controls, private evidence access, and immutable audits.

## Local setup

Prerequisites: Node.js 20+ and PostgreSQL 15+ (or Docker).

1. Copy `.env.example` to `.env` and replace the sample owner password.
2. Start PostgreSQL with `docker compose up -d postgres` or point `DATABASE_URL` at an existing database.
3. Install dependencies: `npm install`.
4. Run `npm run db:migrate`.
5. Run `npm run db:seed`.
6. Optional realistic workflows: set `DEMO_TRACKING_SECRET`, then run `npm run db:demo`.
7. Start UI and API: `npm run dev`.
8. Start the email outbox worker separately: `npm run notifications:worker`.

The customer app is at `http://localhost:5173`; the API is at `http://localhost:3001`. Sign in with the owner credentials from your environment, then open **Operations → Admin settings**.

## Verification

```text
npm test
npm run typecheck
npm run build
```

No local PostgreSQL or Docker executable was present during the initial repository audit. Database migration/seed verification therefore requires the setup above.

### Reproducible manual checklist

1. Select a blocked barangay and a nearby pin: verify delivery quoting is denied.
2. Select an eligible barangay, move the map pin, and confirm an address-specific Haversine fee appears before submission.
3. Submit COD and verify it remains `unpaid` and `awaiting review`; approve as CSR before preparation.
4. Configure an approved merchant QR as admin. Submit a GCash order and upload a receipt; verify the tracker says `Payment under review`, not paid.
5. Record a short merchant payment and choose either exact online remainder or collection on delivery.
6. Dispatch, record a contact attempt, mark unreachable, then confirm RTS only after entering a physical return time. Use the emailed link to request a slot and approve it as CSR.
7. Record stock-out on a verified-paid order. Reload the dashboard and confirm the persisted countdown continues; upload proof and initiate the refund, then verify and settle it as admin.
8. Try the same staff action in two browser sessions: the stale version must fail rather than duplicate the action.
9. Change product price or fee settings and confirm prior order snapshots/totals are unchanged.

## Production configuration still required

The application intentionally does **not** claim these are live:

- Approved GCash merchant name/QR and the real manual reconciliation procedure. There is no GCash payment API integration.
- S3-compatible private storage credentials, bucket retention/deletion rules, encryption policy, and malware-scanning service. Production refuses local storage.
- SMTP credentials, verified sender, manager escalation recipient, and approved customer/support email copy. The console driver sends nothing and records failure rather than pretending success.
- An approved mapping/tile provider and barangay polygon/road-access dataset. The current map uses OpenStreetMap tiles; because the seed has no polygons or road-access data, every pin remains subject to CSR review.
- A production reverse-geocoding provider or self-hosted Nominatim instance for higher traffic. The default public Nominatim endpoint is called only after a customer taps **Order now**, makes one reverse request, displays OpenStreetMap attribution, and falls back to manual city/barangay entry when lookup is unavailable. Override it with `VITE_GEOCODER_URL` without changing application code.
- Visual verification of the store entrance coordinate `7.1380336, 125.5879857` (the authoritative seed explicitly flags it).
- Official logo, food photography, business contact channels, privacy retention schedule, cancellation wording, preparation cutoff/capacity, rider roster, and final legal review.
- A public deployment, TLS/domain, monitoring/backups, S3 CORS policy, and production secret rotation.

## Security and operational review

The source brief correctly separates payment evidence from verification and payment from fulfillment. The implementation additionally closes these operational gaps:

- **No polygon/road evidence:** a valid Haversine fee cannot imply an accessible or barangay-consistent address; CSR review remains mandatory.
- **Concurrent staff/customer actions:** serializable creation transactions, row locks, unique promotion/idempotency keys, and expected order versions prevent common double-click/race outcomes.
- **Refund wording:** five minutes is an initiation/documentation deadline, never a promise that funds settled.
- **RTS safety:** unreachable is not RTS; a physical return timestamp is required, and rescheduling explicitly requires fresh preparation.
- **Production fallbacks:** startup rejects console email and local upload storage in production so absent integrations cannot look successful.

The brief leaves a few business decisions open by design: the exact preparation cutoff/capacity, support contacts, storage retention, verified merchant QR, manager email, road-access authority, and legally approved cancellation/refund text. They are surfaced as configuration or launch blockers instead of invented defaults.
