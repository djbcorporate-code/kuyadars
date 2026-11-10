export function PolicyPage({ kind }: { kind: "privacy" | "terms" }) {
  return <section className="content-page narrow">
    <span className="eyebrow">Kuya Dars customer care</span>
    {kind === "privacy" ? <>
      <h1>Privacy notice</h1>
      <p>We use your contact details, delivery address, map pin, order history, and payment evidence only to process, support, and audit your order. Receipts and refund evidence are private and accessible only to authorized staff.</p>
      <h2>Retention and access</h2><p>Operational records are retained for business, fraud-prevention, and legal needs. Production object-storage retention and deletion periods must be approved before launch. Ask the business contact configured for this service to request access or correction.</p>
      <h2>Security</h2><p>Guest tracking uses an unguessable private link. Do not share it. Staff access is role protected and sensitive changes are audited.</p>
    </> : <>
      <h1>Ordering, cancellations & refunds</h1>
      <p>Submitting an order does not mean it is accepted. A CSR confirms coverage, inventory, address access, and—when applicable—the merchant GCash transaction before preparation begins.</p>
      <h2>Payments</h2><p>A receipt upload is evidence for review, not proof of settlement. COD stays unpaid until collected. Short GCash payments can be completed online or, when approved, collected on delivery.</p>
      <h2>Changes and remedies</h2><p>Change-of-mind cancellations after preparation may be nonrefundable where lawful. Merchant nonfulfillment, defects, and protected consumer claims keep their refund, replacement, or other legal remedy paths. No blanket no-refund policy applies.</p>
      <h2>Unreachable deliveries</h2><p>Return-to-sender is recorded only after the food physically reaches the shop. Rescheduling requires CSR approval and fresh preparation when needed; previously cooked food is never silently reused the next day.</p>
    </>}
  </section>;
}
