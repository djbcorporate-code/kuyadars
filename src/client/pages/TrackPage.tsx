import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, post } from "../api";
import type { TrackingOrder } from "../types";
import { formatPhp } from "../../shared/domain";

const stages = [
  { key: "submitted", label: "Submitted" }, { key: "confirmed", label: "Confirmed" },
  { key: "preparing", label: "Preparing" }, { key: "ready", label: "Ready" },
  { key: "out_for_delivery", label: "On the way" }, { key: "delivered", label: "Delivered" },
];

function stageIndex(order: TrackingOrder) {
  if (order.delivery_status === "delivered") return 5;
  if (order.delivery_status === "out_for_delivery") return 4;
  if (order.fulfillment_status === "ready") return 3;
  if (order.fulfillment_status === "preparing") return 2;
  if (["confirmed","preparing","ready","completed"].includes(order.fulfillment_status)) return 1;
  return 0;
}

function human(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase()); }

export function TrackPage() {
  const params = useParams(); const navigate = useNavigate();
  const [order, setOrder] = useState<TrackingOrder | null>(null); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const token = params.token;
  async function load() { if (!token) return; try { const data = await api<{ order: TrackingOrder }>(`/api/tracking/${token}`); setOrder(data.order); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : "Tracking unavailable."); } }
  useEffect(() => { void load(); if (!token) return; const timer = window.setInterval(load, 15_000); return () => clearInterval(timer); }, [token]);
  function find(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const value = String(new FormData(event.currentTarget).get("token") ?? "").trim(); const match = value.match(/\/track\/([^/?#]+)/); navigate(`/track/${match?.[1] ?? value}`); }
  async function uploadReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!token) return; setError("");
    const form = new FormData(event.currentTarget);
    try { const result = await api<{ message: string }>(`/api/tracking/${token}/payment-evidence`, { method: "POST", body: form }); setNotice(result.message); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Upload failed."); }
  }
  async function chooseBalance(choice: "pay_online" | "collect_on_delivery") {
    try { await post(`/api/tracking/${token}/balance-choice`, { choice }); setNotice("Balance choice saved for CSR and rider review."); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save the choice."); }
  }
  if (!token) return <section className="track-lookup"><div><span className="eyebrow light">Private order status</span><h1>Where's your chicken?</h1><p>Paste the secure tracking link from your order confirmation. A public order number alone cannot reveal your information.</p></div><form onSubmit={find} className="track-search"><label>Secure link or token<input name="token" required placeholder="Paste your private tracking link"/></label><button className="button button-accent">Open tracking</button></form></section>;
  if (!order) return <section className="content-page narrow"><h1>Opening secure tracking…</h1>{error && <div className="alert error">{error}</div>}</section>;
  const active = stageIndex(order);
  return <section className="tracking-page">
    <div className="tracking-head"><div><span className="eyebrow">Secure order tracking</span><h1>{order.reference}</h1><p>Hi {order.customer_name}. This page refreshes automatically; there is no simulated rider GPS.</p></div><div className="big-status"><span>Current status</span><strong>{human(order.delivery_status !== "not_scheduled" ? order.delivery_status : order.fulfillment_status)}</strong><small>Payment: {human(order.payment_status)}</small></div></div>
    {error && <div className="alert error">{error}</div>}{notice && <div className="alert success">{notice}</div>}
    <ol className="progress-track">{stages.map((stage, index) => <li className={index < active ? "done" : index === active ? "active" : ""} key={stage.key}><span>{index < active ? "✓" : index + 1}</span><small>{stage.label}</small></li>)}</ol>
    {order.review_status !== "approved" && <div className="alert info"><strong>Awaiting human review.</strong> Your order has not been accepted or sent to preparation yet.</div>}
    {order.exception_code && <div className="alert warning"><strong>CSR review flag:</strong> {human(order.exception_code)}. The delivery fee is calculated, but access and pin consistency need review.</div>}
    {order.delivery_status === "unreachable" && <div className="alert warning"><strong>Customer unreachable.</strong> The rider/CSR is still attempting contact. This is not yet return-to-sender.</div>}
    {order.delivery_status === "rts" && <div className="alert warning"><strong>Returned to shop.</strong> Use the single-use rescheduling email link to request a new time. Fresh preparation requires CSR approval.</div>}
    {order.refund_status === "required" && <RefundTimer dueAt={order.refund_action_due_at} />}
    <div className="tracking-grid">
      <div className="panel"><h2>Order summary</h2>{order.items.map((item) => <div className="summary-line" key={item.name}><span>{item.quantity}× {item.name}</span><strong>{formatPhp(item.unitPriceCentavos * item.quantity)}</strong></div>)}<hr/><div className="summary-line"><span>Subtotal</span><strong>{formatPhp(order.subtotal_centavos)}</strong></div><div className="summary-line"><span>Promotion</span><strong>−{formatPhp(order.discount_centavos)}</strong></div><div className="summary-line"><span>Delivery · {Number(order.distance_km).toFixed(2)} km</span><strong>{order.delivery_fee_centavos ? formatPhp(order.delivery_fee_centavos) : "FREE"}</strong></div><div className="summary-line total"><span>Total</span><strong>{formatPhp(order.total_centavos)}</strong></div></div>
      <div className="panel"><h2>Delivery</h2><p><strong>{order.address.street}, {order.address.barangay}</strong><br/>{order.address.district}<br/>Landmark: {order.address.landmark}</p><a className="text-link" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${order.address.latitude},${order.address.longitude}`}>Open submitted pin ↗</a><p className="fine-print">Exact distance and fee are frozen on this order. Later setting changes do not alter the total.</p></div>
    </div>
    {order.payment_method === "gcash_manual" && ["unpaid","rejected"].includes(order.payment_status) && <form className="panel evidence-form" onSubmit={uploadReceipt}><div><h2>Submit GCash evidence</h2><p>A receipt and reference help CSR locate the transaction. They do not mark it paid.</p></div><label>GCash reference<input name="reference" required minLength={3}/></label><label>Receipt (JPEG, PNG, PDF; max 5 MB)<input type="file" name="receipt" accept="image/jpeg,image/png,application/pdf" required/></label><button className="button button-primary">Submit for review</button></form>}
    {order.payment_status === "evidence_submitted" && <div className="alert info"><strong>Payment under review.</strong> CSR must verify the actual merchant transaction before acceptance.</div>}
    {order.payment_status === "short" && <div className="panel short-payment"><div><span className="eyebrow">Short GCash payment</span><h2>{formatPhp(order.outstanding_centavos)} remains</h2><p>Choose how you want to settle the exact balance.</p></div><button className={order.balance_resolution === "pay_online" ? "choice selected" : "choice"} onClick={() => chooseBalance("pay_online")}><strong>A. Pay online</strong><small>Submit another receipt for merchant review</small></button><button className={order.balance_resolution === "collect_on_delivery" ? "choice selected" : "choice"} onClick={() => chooseBalance("collect_on_delivery")}><strong>B. Pay on delivery</strong><small>Rider/CSR sees the exact balance</small></button></div>}
    <div className="timeline-section"><h2>Action history</h2><ol>{[...order.timeline].reverse().map((event, index) => <li key={`${event.at}-${index}`}><span/><div><strong>{human(event.to)}</strong><p>{event.reason}</p><time>{new Date(event.at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}</time></div></li>)}</ol></div>
  </section>;
}

function RefundTimer({ dueAt }: { dueAt: string | null }) {
  const [now, setNow] = useState(Date.now()); useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  if (!dueAt) return null; const remaining = new Date(dueAt).getTime() - now; const seconds = Math.max(0, Math.ceil(remaining / 1000));
  return <div className={`alert ${remaining > 0 ? "warning" : "error"}`}><strong>{remaining > 0 ? `Refund action due in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,"0")}` : "Refund action deadline overdue"}</strong><br/>This is the deadline to initiate and document the refund—not a promise that funds settle within five minutes.</div>;
}
