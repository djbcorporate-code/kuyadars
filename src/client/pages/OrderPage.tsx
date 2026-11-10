import { useEffect, useMemo, useState, type FormEvent } from "react";
import L, { type LeafletEvent } from "leaflet";
import { MapContainer, Marker, TileLayer, useMapEvents } from "react-leaflet";
import { Link, useSearchParams } from "react-router-dom";
import markerIcon from "leaflet/dist/images/marker-icon.png?url";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png?url";
import markerShadow from "leaflet/dist/images/marker-shadow.png?url";
import { api, post } from "../api";
import type { Catalog, User } from "../types";
import { safeCoordinate } from "../location";
import { formatPhp, STORE_POINT } from "../../shared/domain";

L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });

type Quote = { distanceKm: number; deliveryFeeCentavos: number; needsCsrReview: boolean; warning: string };
type CreatedOrder = { reference: string; trackingUrl: string; trackingToken: string; message: string; totals: { totalCentavos: number } };

export function OrderPage({ user }: { user: User | null }) {
  const [searchParams] = useSearchParams();
  const [catalog, setCatalog] = useState<Catalog | null>(null); const [quantity, setQuantity] = useState(1);
  const [district, setDistrict] = useState(() => searchParams.get("district") ?? ""); const [barangayId, setBarangayId] = useState(() => searchParams.get("barangay") ?? "");
  const [pin, setPin] = useState<{ latitude: number; longitude: number }>(() => ({ latitude: safeCoordinate(searchParams.get("lat"), -90, 90, STORE_POINT.latitude), longitude: safeCoordinate(searchParams.get("lng"), -180, 180, STORE_POINT.longitude) })); const [pinSource, setPinSource] = useState<"manual_map" | "geolocation">(() => searchParams.get("pinSource") === "geolocation" ? "geolocation" : "manual_map");
  const [quote, setQuote] = useState<Quote | null>(null); const [quoting, setQuoting] = useState(false);
  const [payment, setPayment] = useState<"cod" | "gcash_manual">("cod"); const [promoCode, setPromoCode] = useState("");
  const [error, setError] = useState(""); const [created, setCreated] = useState<CreatedOrder | null>(null); const [submitting, setSubmitting] = useState(false);
  useEffect(() => { api<Catalog>("/api/catalog").then(setCatalog).catch((e) => setError(e.message)); }, []);
  const chicken = catalog?.products[0];
  const districts = useMemo(() => [...new Set(catalog?.coverage.map((item) => item.administrative_district) ?? [])], [catalog]);
  const barangays = catalog?.coverage.filter((item) => item.administrative_district === district) ?? [];
  const selectedBarangay = catalog?.coverage.find((item) => item.id === barangayId);
  const subtotal = (chicken?.price_centavos ?? 28000) * quantity;
  const estimatedDiscount = promoCode === "FIRST10" && user ? Math.floor(subtotal * 0.1) : 0;
  const total = subtotal - estimatedDiscount + (quote?.deliveryFeeCentavos ?? 0);
  function updatePin(next: { latitude: number; longitude: number }, source: "manual_map" | "geolocation") { setPin(next); setPinSource(source); setQuote(null); }
  function geolocate() {
    if (!navigator.geolocation) return setError("Location is unavailable. Drop the pin manually instead.");
    navigator.geolocation.getCurrentPosition((position) => updatePin({ latitude: position.coords.latitude, longitude: position.coords.longitude }, "geolocation"), () => setError("Location permission was declined. Drop the pin manually."), { enableHighAccuracy: true, timeout: 10_000 });
  }
  async function getQuote() {
    if (!barangayId || !district) return setError("Choose your district and barangay first.");
    setQuoting(true); setError("");
    try { setQuote(await post<Quote>("/api/delivery/quote", { coverageBarangayId: barangayId, administrativeDistrict: district, latitude: pin.latitude, longitude: pin.longitude, roadAccessStatus: "unverified" })); }
    catch (caught) { setQuote(null); setError(caught instanceof Error ? caught.message : "Could not calculate delivery."); }
    finally { setQuoting(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!quote || !chicken) return setError("Calculate and review the delivery fee first.");
    const form = new FormData(event.currentTarget); setSubmitting(true); setError("");
    try {
      const result = await api<CreatedOrder>("/api/orders", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({
        customer: { name: form.get("name"), email: form.get("email"), phone: form.get("phone") },
        items: [{ productId: chicken.id, quantity }],
        address: { coverageBarangayId: barangayId, administrativeDistrict: district, streetAddress: form.get("street"), landmark: form.get("landmark"), instructions: form.get("instructions") || undefined, latitude: pin.latitude, longitude: pin.longitude, pinSource, roadAccessStatus: "unverified" },
        paymentMethod: payment, promotionCode: promoCode || undefined, quotedDeliveryFeeCentavos: quote.deliveryFeeCentavos,
      }) }); setCreated(result);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not submit the order."); }
    finally { setSubmitting(false); }
  }
  if (created) return <section className="confirmation-page"><div className="confirmation-mark">✓</div><span className="eyebrow">Order safely submitted</span><h1>{created.reference}</h1><p>{created.message}</p><div className="confirmation-total"><span>Order total</span><strong>{formatPhp(created.totals.totalCentavos)}</strong></div><Link className="button button-primary" to={`/track/${created.trackingToken}`}>Open secure tracking</Link><p className="fine-print">Save the private tracking link. It is also queued for email delivery. Do not share it publicly.</p></section>;
  return <section className="order-page">
    <div className="order-title"><div><span className="eyebrow">Kuya Dars delivery</span><h1>Complete your order</h1><p>Choose your quantity, confirm the delivery fee, then add your contact and payment details.</p></div><div className="order-assurance"><span className={`availability-dot ${catalog?.settings.orderOpenNow ? "open" : "closed"}`} /><strong>{catalog?.settings.orderOpenNow ? "Open for orders" : "Ordering closed"}</strong><small>08:00–22:00 Asia/Manila</small></div></div>
    <ol className="checkout-progress" aria-label="Checkout progress"><li className="active"><span>1</span>Order</li><li><span>2</span>Delivery</li><li><span>3</span>Details</li><li><span>4</span>Review</li></ol>
    {catalog && !catalog.settings.orderOpenNow && <div className="alert warning">Online ordering is currently closed. Tracking and account access remain available.</div>}
    {error && <div className="alert error">{error}</div>}
    <form onSubmit={submit} className="checkout-layout">
      <div className="checkout-main">
        <section className="checkout-section"><div className="step-label"><span>1</span><div><h2>Your order</h2><p>Stock is reserved atomically when you submit.</p></div></div>
          <div className="cart-item"><div className="mini-chicken"/><div><strong>{chicken?.name ?? "Lechon Manok"}</strong><small>{chicken?.description ?? "Extra Laki, Extra Sarap."}</small></div><div className="quantity"><button type="button" onClick={() => setQuantity(Math.max(1, quantity - 1))} aria-label="Decrease quantity">−</button><span>{quantity}</span><button type="button" onClick={() => setQuantity(Math.min(30, quantity + 1))} aria-label="Increase quantity">+</button></div><strong>{formatPhp(subtotal)}</strong></div>
        </section>
        <section className="checkout-section"><div className="step-label"><span>2</span><div><h2>Delivery details</h2><p>Approved barangay coverage overrides distance.</p></div></div>
          <div className="form-grid"><label>Administrative district<select value={district} onChange={(e) => { setDistrict(e.target.value); setBarangayId(""); setQuote(null); }} required><option value="">Choose district</option>{districts.map((value) => <option key={value}>{value}</option>)}</select></label><label>Barangay<select value={barangayId} onChange={(e) => { setBarangayId(e.target.value); setQuote(null); }} required><option value="">Choose barangay</option>{barangays.map((item) => <option key={item.id} value={item.id}>{item.barangay}{item.service_status === "blocked" ? " — not serviceable" : ""}</option>)}</select></label></div>
          {selectedBarangay?.service_status === "blocked" && <div className="alert error">This barangay is on the approved blocked list. Distance cannot override it.</div>}
          <div className="map-wrap"><PinMap pin={pin} onPin={(value) => updatePin(value, "manual_map")}/><button className="locate-button" type="button" onClick={geolocate}>Use my location</button><div className="pin-readout">Pin: {pin.latitude.toFixed(6)}, {pin.longitude.toFixed(6)}</div></div>
          <div className="form-grid"><label className="wide">Street / sitio / purok<input name="street" required minLength={5} placeholder="House no., street, sitio or purok"/></label><label>Landmark<input name="landmark" required placeholder="Nearest clear landmark"/></label><label>Delivery instructions<textarea name="instructions" rows={2} placeholder="Gate, access, or contact notes"/></label></div>
          <button className="button button-secondary" type="button" disabled={quoting || selectedBarangay?.service_status === "blocked"} onClick={getQuote}>{quoting ? "Calculating…" : "Calculate exact delivery fee"}</button>
          {quote && <div className="quote-result"><div><span>Great-circle distance</span><strong>{quote.distanceKm.toFixed(3)} km</strong></div><div><span>Delivery fee</span><strong>{quote.deliveryFeeCentavos ? formatPhp(quote.deliveryFeeCentavos) : "FREE"}</strong></div><p>{quote.warning}</p></div>}
        </section>
        <section className="checkout-section"><div className="step-label"><span>3</span><div><h2>Contact & payment</h2><p>Required for delivery, RTS, and refund notices.</p></div></div>
          <div className="form-grid"><label>Full name<input name="name" defaultValue={user?.fullName ?? ""} required minLength={2}/></label><label>Mobile number<input name="phone" type="tel" required minLength={8}/></label><label className="wide">Email address<input name="email" type="email" defaultValue={user?.email ?? ""} required/></label></div>
          <div className="payment-options"><button type="button" className={payment === "cod" ? "payment-card selected" : "payment-card"} onClick={() => setPayment("cod")}><span>COD</span><strong>Cash on Delivery</strong><small>Unpaid until CSR records collection</small></button><button type="button" disabled={!catalog?.settings.gcash_configured} className={payment === "gcash_manual" ? "payment-card selected" : "payment-card"} onClick={() => setPayment("gcash_manual")}><span>GCash</span><strong>Manual QR payment</strong><small>{catalog?.settings.gcash_configured ? "Receipt requires merchant review" : "Merchant QR not configured"}</small></button></div>
          {payment === "gcash_manual" && catalog?.settings.gcashQrUrl && <div className="gcash-box"><img src={catalog.settings.gcashQrUrl} alt="Approved Kuya Dars GCash merchant QR"/><div><strong>Pay the exact displayed total</strong><p>After submitting, upload the reference and receipt on your secure tracker. Uploading proof never marks the order paid.</p></div></div>}
          <label className="promo-field">Promotion code<input value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase())} placeholder="FIRST10"/><small>10% off the first eligible order for a verified account. No minimum or cap; server enforces one redemption.</small></label>
        </section>
      </div>
      <aside className="order-summary"><span className="eyebrow">Your total</span><h2>Order summary</h2><div className="summary-line"><span>{quantity}× Lechon Manok</span><strong>{formatPhp(subtotal)}</strong></div>{promoCode && <div className="summary-line"><span>FIRST10 {user ? "estimate" : "(sign in required)"}</span><strong>−{formatPhp(estimatedDiscount)}</strong></div>}<div className="summary-line"><span>Delivery</span><strong>{quote ? (quote.deliveryFeeCentavos ? formatPhp(quote.deliveryFeeCentavos) : "FREE") : "Check pin"}</strong></div><hr/><div className="summary-line total"><span>Total</span><strong>{formatPhp(total)}</strong></div><label className="checkbox"><input type="checkbox" required/><span>I reviewed the delivery fee, address pin, and <Link to="/terms" target="_blank">order/refund terms</Link>.</span></label><button className="button button-primary full" type="submit" disabled={!quote || submitting || !catalog?.settings.orderOpenNow}>{submitting ? "Submitting safely…" : "Submit for CSR review"}</button><p className="fine-print">Submission is not acceptance. Price, stock, coverage, promo, and fee are recalculated server-side.</p></aside>
    </form>
  </section>;
}

function PinMap({ pin, onPin }: { pin: { latitude: number; longitude: number }; onPin: (pin: { latitude: number; longitude: number }) => void }) {
  function MapClick() { useMapEvents({ click(event) { onPin({ latitude: event.latlng.lat, longitude: event.latlng.lng }); } }); return null; }
  return <MapContainer center={[pin.latitude, pin.longitude]} zoom={13} scrollWheelZoom className="pin-map"><TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><MapClick/><Marker draggable position={[pin.latitude, pin.longitude]} eventHandlers={{ dragend(event: LeafletEvent) { const point = (event.target as L.Marker).getLatLng(); onPin({ latitude: point.lat, longitude: point.lng }); } }}/></MapContainer>;
}
