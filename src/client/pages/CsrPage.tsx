import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, patch, post } from "../api";
import type { Catalog, User } from "../types";
import { formatPhp } from "../../shared/domain";

type Queue = "all" | "new" | "payment" | "cod" | "preparing" | "ready" | "delivery" | "exceptions" | "refunds" | "completed";
type OpsOrder = {
  id: string; reference: string; customer_name: string; customer_email: string; customer_phone: string;
  review_status: string; payment_status: string; payment_method: string; fulfillment_status: string; delivery_status: string; refund_status: string;
  total_centavos: number; verified_paid_centavos: number; outstanding_centavos: number; distance_km: string; delivery_fee_centavos: number;
  refund_action_due_at: string | null; refund_overdue?: boolean; submitted_at: string; version: number; exception_code: string | null;
  barangay?: string; administrative_district?: string; street_address?: string; landmark?: string; latitude?: string; longitude?: string;
  address?: Record<string, string>; items?: Array<Record<string, string | number>>; payments?: Array<Record<string, string | number>>;
  evidence?: Array<{ id: string; objectId: string; reference: string; status: string; createdAt: string }>;
  transitions?: Array<Record<string, string>>; contacts?: Array<Record<string, string>>; refunds?: Array<Record<string, string | number>>; reschedules?: Array<Record<string, string | number | boolean>>;
};
type Counters = Record<Exclude<Queue,"all"> | "new_orders" | "payment_review" | "on_delivery", number>;

const tabs: Array<{ queue: Queue; label: string; key?: string }> = [
  { queue: "new", label: "New", key: "new_orders" }, { queue: "payment", label: "GCash review", key: "payment_review" },
  { queue: "cod", label: "COD" }, { queue: "preparing", label: "Preparing" }, { queue: "ready", label: "Ready" },
  { queue: "delivery", label: "On delivery", key: "on_delivery" }, { queue: "exceptions", label: "Exceptions" },
  { queue: "refunds", label: "Refunds" }, { queue: "completed", label: "Completed" },
];
const human = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());

export function CsrPage({ user }: { user: User | null }) {
  const [queue, setQueue] = useState<Queue>("new"); const [orders, setOrders] = useState<OpsOrder[]>([]); const [selected, setSelected] = useState<OpsOrder | null>(null);
  const [counters, setCounters] = useState<Partial<Counters>>({}); const [search, setSearch] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [adminMode, setAdminMode] = useState(false);
  const isStaff = user?.roles.some((role) => ["owner","admin","csr"].includes(role)); const isAdmin = user?.roles.some((role) => ["owner","admin"].includes(role));
  const load = useCallback(async () => {
    if (!isStaff) return;
    try { const [list, counts] = await Promise.all([api<{ orders: OpsOrder[] }>(`/api/csr/orders?queue=${queue}&q=${encodeURIComponent(search)}`), api<Partial<Counters>>("/api/csr/counters")]); setOrders(list.orders); setCounters(counts); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Dashboard unavailable."); }
  }, [queue, search, isStaff]);
  useEffect(() => { void load(); const timer = setInterval(load, 20_000); return () => clearInterval(timer); }, [load]);
  async function open(order: OpsOrder) { try { const result = await api<{ order: OpsOrder }>(`/api/csr/orders/${order.id}`); setSelected(result.order); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open order."); } }
  async function act(action: string, extras: Record<string, unknown> = {}) {
    if (!selected) return; const reason = window.prompt("Reason / operational note (required):"); if (!reason || reason.trim().length < 3) return;
    try { const result = await post<{ order: OpsOrder }>(`/api/csr/orders/${selected.id}/actions`, { action, reason, expectedVersion: selected.version, ...extras }); setSelected(result.order); setNotice(`${human(action)} recorded.`); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Action failed."); }
  }
  if (!user) return <section className="content-page narrow"><span className="eyebrow">Protected operations</span><h1>Staff sign-in required.</h1><p>Customer, receipt, address, and refund evidence are never exposed on public order numbers.</p><Link to="/account" className="button button-primary">Sign in</Link></section>;
  if (!isStaff) return <section className="content-page narrow"><h1>Access denied.</h1><p>Your account does not have a CSR role.</p></section>;
  return <section className="ops-page">
    <header className="ops-head"><div><span className="eyebrow">Operations control room</span><h1>Orders, clearly separated.</h1></div><div className="ops-user"><span>{user.fullName}</span><small>{user.roles.join(" · ")}</small>{isAdmin && <button className="text-button" onClick={() => setAdminMode(!adminMode)}>{adminMode ? "Order queues" : "Admin settings"}</button>}</div></header>
    {error && <div className="alert error">{error}<button onClick={() => setError("")}>×</button></div>}{notice && <div className="alert success">{notice}</div>}
    {adminMode && isAdmin ? <AdminPanel /> : <>
      <div className="queue-tabs">{tabs.map((tab) => <button key={tab.queue} className={queue === tab.queue ? "active" : ""} onClick={() => { setQueue(tab.queue); setSelected(null); }}><span>{tab.label}</span><strong>{counters[(tab.key ?? tab.queue) as keyof Counters] ?? 0}</strong></button>)}</div>
      <div className="ops-workspace">
        <aside className="order-list"><form onSubmit={(e) => { e.preventDefault(); void load(); }}><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ref, name, phone" aria-label="Search orders"/></form>{orders.length === 0 && <p className="empty">No orders in this queue.</p>}{orders.map((order) => <button key={order.id} className={selected?.id === order.id ? "order-row active" : "order-row"} onClick={() => open(order)}><div><strong>{order.reference}</strong><span>{order.customer_name}</span></div><div><span className={`status-dot ${order.refund_overdue ? "urgent" : ""}`}/><small>{human(order.exception_code ?? order.fulfillment_status)}</small></div><p>{order.barangay} · {formatPhp(order.total_centavos)}</p><time>{new Date(order.submitted_at).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" })}</time></button>)}</aside>
        <main className="order-detail">{selected ? <OrderDetail order={selected} isAdmin={Boolean(isAdmin)} onAct={act} onRefresh={() => open(selected)} /> : <div className="empty-detail"><span>↙</span><h2>Select an order</h2><p>Actions use optimistic locking so two CSR sessions cannot silently double-submit.</p></div>}</main>
      </div>
    </>}
  </section>;
}

function OrderDetail({ order, isAdmin, onAct, onRefresh }: { order: OpsOrder; isAdmin: boolean; onAct: (action: string, extras?: Record<string, unknown>) => Promise<void>; onRefresh: () => Promise<void> }) {
  const [refundProof, setRefundProof] = useState<File | null>(null);
  async function contact(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await post(`/api/csr/orders/${order.id}/contact-attempts`, { channel: form.get("channel"), outcome: form.get("outcome"), notes: form.get("notes") }); await onRefresh(); }
  async function initiateRefund() {
    if (!refundProof) return alert("Attach refund proof first.");
    const form = new FormData(); form.set("proof", refundProof); const uploaded = await api<{ objectId: string }>(`/api/csr/orders/${order.id}/refund-evidence`, { method: "POST", body: form });
    const reference = prompt("Refund transaction reference:"); const amount = Number(prompt("Refund amount in pesos:", String(order.verified_paid_centavos / 100))) * 100;
    if (!reference || !amount) return; await onAct("initiate_refund", { amountCentavos: amount, merchantReference: reference, transactionTime: new Date().toISOString(), evidenceObjectId: uploaded.objectId });
  }
  return <>
    <div className="detail-head"><div><span className="eyebrow">{order.reference}</span><h2>{order.customer_name}</h2><p>{order.customer_phone} · {order.customer_email}</p></div><strong>{formatPhp(order.total_centavos)}</strong></div>
    <div className="state-grid"><State label="Review" value={order.review_status}/><State label="Payment" value={order.payment_status}/><State label="Fulfillment" value={order.fulfillment_status}/><State label="Delivery" value={order.delivery_status}/><State label="Refund" value={order.refund_status}/></div>
    {order.refund_action_due_at && order.refund_status === "required" && <OpsTimer dueAt={order.refund_action_due_at}/>}
    <section className="detail-section"><h3>Delivery & fee snapshot</h3><p><strong>{String(order.address?.street_address ?? "")}, {String(order.address?.barangay ?? "")}</strong><br/>Landmark: {String(order.address?.landmark ?? "")}</p><div className="summary-line"><span>Haversine distance</span><strong>{Number(order.distance_km).toFixed(3)} km</strong></div><div className="summary-line"><span>Frozen delivery fee</span><strong>{formatPhp(order.delivery_fee_centavos)}</strong></div><a target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${order.address?.latitude},${order.address?.longitude}`}>Open exact pin ↗</a></section>
    {order.evidence && order.evidence.length > 0 && <section className="detail-section"><h3>Payment evidence — private</h3>{order.evidence.map((evidence) => <div className="evidence-row" key={evidence.id}><div><strong>{evidence.reference}</strong><small>{human(evidence.status)} · {new Date(evidence.createdAt).toLocaleString("en-PH")}</small></div><a href={`/api/private-objects/${evidence.objectId}`} target="_blank" rel="noreferrer">Review file</a></div>)}<p className="fine-print">The file is evidence only. Confirm the merchant transaction separately.</p></section>}
    <section className="detail-section"><h3>Allowed next actions</h3><div className="action-grid">
      {["awaiting_review","on_hold"].includes(order.review_status) && <><button onClick={() => onAct("hold")}>Hold for review</button><button className="primary" onClick={() => onAct("approve")}>Approve & confirm</button><button className="danger" onClick={() => onAct("reject")}>Reject</button></>}
      {order.payment_method === "gcash_manual" && ["evidence_submitted","under_review"].includes(order.payment_status) && <><button className="primary" onClick={() => { const reference = prompt("Verified merchant reference:"); if (reference) void onAct("verify_payment", { amountCentavos: order.total_centavos, merchantReference: reference }); }}>Verify full payment</button><button onClick={() => { const reference = prompt("Verified merchant reference:"); const pesos = Number(prompt("Amount actually verified (PHP):")); if (reference && pesos > 0) void onAct("record_short_payment", { amountCentavos: Math.round(pesos * 100), merchantReference: reference }); }}>Record short payment</button></>}
      {order.fulfillment_status === "confirmed" && <button className="primary" onClick={() => onAct("start_preparing")}>Start preparation</button>}
      {order.fulfillment_status === "preparing" && <button className="primary" onClick={() => onAct("mark_ready")}>Mark ready</button>}
      {order.delivery_status === "ready_for_dispatch" && <button className="primary" onClick={() => onAct("dispatch")}>Dispatch</button>}
      {order.delivery_status === "out_for_delivery" && <><button onClick={() => onAct("mark_unreachable")}>Customer unreachable</button><button className="primary" onClick={() => { const riderName = prompt("Rider who confirmed completion:"); if (riderName) void onAct("mark_delivered", { riderConfirmed: true, riderName, amountCentavos: order.outstanding_centavos }); }}>Mark delivered</button></>}
      {order.delivery_status === "unreachable" && <button className="danger" onClick={() => onAct("confirm_rts", { returnedAt: new Date().toISOString() })}>Confirm physically returned (RTS)</button>}
      {["submitted","confirmed","preparing"].includes(order.fulfillment_status) && <button className="danger" onClick={() => onAct("record_stockout")}>Record stock-out</button>}
      {order.refund_status === "required" && <div className="refund-action"><label>Private refund proof<input type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setRefundProof(e.target.files?.[0] ?? null)}/></label><button className="danger" onClick={initiateRefund}>Initiate & document refund</button></div>}
      {isAdmin && order.refund_status === "initiated" && <button className="primary" onClick={() => onAct("verify_refund")}>Verify refund record</button>}
      {isAdmin && order.refund_status === "verified" && <button className="primary" onClick={() => onAct("settle_refund")}>Mark settled</button>}
    </div></section>
    <section className="detail-section"><h3>Contact attempts</h3><form className="contact-form" onSubmit={contact}><select name="channel"><option value="call">Call</option><option value="sms">SMS</option><option value="email">Email</option><option value="chat">Chat</option></select><input name="outcome" required placeholder="Outcome"/><input name="notes" placeholder="Notes"/><button>Add</button></form>{order.contacts?.map((item, index) => <p className="contact-log" key={index}>{human(String(item.channel))} · {String(item.outcome)} <small>{String(item.notes ?? "")}</small></p>)}</section>
  </>;
}

function State({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{human(value)}</strong></div>; }
function OpsTimer({ dueAt }: { dueAt: string }) { const [now, setNow] = useState(Date.now()); useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []); const remaining = new Date(dueAt).getTime() - now; return <div className={remaining > 0 ? "ops-deadline" : "ops-deadline overdue"}><span>Refund initiation SLA</span><strong>{remaining > 0 ? `${Math.floor(remaining / 60_000)}:${String(Math.ceil(remaining / 1000) % 60).padStart(2,"0")}` : "OVERDUE — manager attention"}</strong><small>Initiate and document; do not claim settlement yet.</small></div>; }

function AdminPanel() {
  const [catalog, setCatalog] = useState<Catalog | null>(null); const [notice, setNotice] = useState("");
  useEffect(() => { api<Catalog>("/api/catalog").then(setCatalog); }, []);
  async function product(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const item = catalog?.products[0]; if (!item) return; await patch(`/api/admin/products/${item.id}`, { priceCentavos: Math.round(Number(data.get("price")) * 100), stockOnHand: Number(data.get("stock")), active: data.get("active") === "on" }); setNotice("Product updated and audited. Existing order snapshots were not changed."); }
  async function settings(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); await patch("/api/admin/settings", { orderingOpen: data.get("open"), orderingClose: data.get("close"), preparationCutoff: data.get("cutoff"), dailyOrderCapacity: Number(data.get("capacity")), refundSlaMinutes: Number(data.get("refundSla")), freeRadiusKm: Number(data.get("freeRadius")), paidZoneMaxKm: Number(data.get("paidMax")), paidZoneBaseFeeCentavos: Math.round(Number(data.get("baseFee")) * 100), extraStartedKmFeeCentavos: Math.round(Number(data.get("extraFee")) * 100) }); setNotice("Store and delivery settings updated and audited. Historical totals were not changed."); }
  async function qr(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); await api("/api/admin/merchant-qr", { method: "POST", body: data }); setNotice("Approved merchant QR stored privately and enabled."); }
  const item = catalog?.products[0]; return <div className="admin-panel"><div className="alert warning"><strong>Production readiness:</strong> visually verify the store entrance pin, configure S3 and SMTP, approve the merchant QR, and review business contact text before launch.</div>{notice && <div className="alert success">{notice}</div>}<div className="admin-grid"><form className="panel stack" onSubmit={product}><h2>Product & inventory</h2><label>Price (PHP)<input name="price" type="number" min="0" step="0.01" defaultValue={(item?.price_centavos ?? 28000) / 100}/></label><label>Stock on hand<input name="stock" type="number" min="0" defaultValue={item?.available_stock ?? 100}/></label><label className="checkbox"><input name="active" type="checkbox" defaultChecked/><span>Accept orders for this product</span></label><button className="button button-primary">Save product</button></form><form className="panel stack" onSubmit={settings}><h2>Hours, capacity & delivery</h2><label>Online open<input name="open" type="time" defaultValue={catalog?.settings.orderingOpen ?? "08:00"}/></label><label>Online close<input name="close" type="time" defaultValue={catalog?.settings.orderingClose ?? "22:00"}/></label><label>Preparation cutoff<input name="cutoff" type="time" defaultValue={catalog?.settings.preparationCutoff ?? "22:00"}/></label><label>Daily capacity<input name="capacity" type="number" min="0" defaultValue="200"/></label><label>Refund action SLA (minutes)<input name="refundSla" type="number" min="1" defaultValue="5"/></label><label>Free radius (km)<input name="freeRadius" type="number" min="0" step="0.001" defaultValue={catalog?.settings.free_radius_km ?? "7"}/></label><label>Paid-zone max (km)<input name="paidMax" type="number" min="0" step="0.001" defaultValue={catalog?.settings.paid_zone_max_km ?? "10"}/></label><label>Paid-zone base fee (PHP)<input name="baseFee" type="number" min="0" step="0.01" defaultValue={(catalog?.settings.paid_zone_base_fee_centavos ?? 3000) / 100}/></label><label>Extra started-km fee (PHP)<input name="extraFee" type="number" min="0" step="0.01" defaultValue={(catalog?.settings.extra_started_km_fee_centavos ?? 1000) / 100}/></label><button className="button button-primary">Save settings</button></form><form className="panel stack" onSubmit={qr}><h2>Approved GCash QR</h2><p>GCash checkout remains disabled until this is configured. This does not create a provider integration.</p><input name="qr" type="file" accept="image/jpeg,image/png" required/><button className="button button-secondary">Upload merchant QR</button></form></div></div>;
}
