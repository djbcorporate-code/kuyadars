import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Catalog } from "../types";
import { formatPhp } from "../../shared/domain";

export function HomePage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [district, setDistrict] = useState("");
  const [barangayId, setBarangayId] = useState("");
  const navigate = useNavigate();
  useEffect(() => { api<Catalog>("/api/catalog").then(setCatalog).catch(() => setCatalog(null)); }, []);
  const chicken = catalog?.products[0];
  const price = chicken ? formatPhp(chicken.price_centavos) : "₱280";
  const freeRadius = catalog?.settings.free_radius_km ?? "7";
  const baseFee = catalog ? formatPhp(catalog.settings.paid_zone_base_fee_centavos) : "₱30";
  const extraFee = catalog ? formatPhp(catalog.settings.extra_started_km_fee_centavos) : "₱10";
  const districts = useMemo(() => [...new Set(catalog?.coverage.map((item) => item.administrative_district) ?? [])], [catalog]);
  const barangays = catalog?.coverage.filter((item) => item.administrative_district === district) ?? [];
  const selectedBarangay = catalog?.coverage.find((item) => item.id === barangayId);
  const isBlocked = selectedBarangay?.service_status === "blocked";

  function continueToOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!district || !barangayId || isBlocked) return;
    const query = new URLSearchParams({ district, barangay: barangayId });
    navigate(`/order?${query.toString()}`);
  }

  return <>
    <section className="delivery-hero">
      <div className="delivery-hero-inner">
        <div className="delivery-hero-copy">
          <div className="availability-chip">
            <span className={`availability-dot ${catalog?.settings.orderOpenNow ? "open" : "closed"}`} />
            {catalog ? (catalog.settings.orderOpenNow ? "Open for delivery" : `Ordering opens at ${catalog.settings.orderingOpen}`) : "Checking store hours…"}
          </div>
          <span className="eyebrow">Davao City's lechon manok</span>
          <h1>Extra laki.<br/><em>Delivered.</em></h1>
          <p>Enter your area first. We’ll confirm coverage, then calculate the exact delivery fee from your map pin before you submit.</p>
          <form className="address-finder" onSubmit={continueToOrder} aria-label="Check delivery coverage">
            <div className="address-finder-title"><span aria-hidden="true">⌖</span><strong>Where should we deliver?</strong></div>
            <div className="address-fields">
              <label>
                <span>District</span>
                <select value={district} onChange={(event) => { setDistrict(event.target.value); setBarangayId(""); }} required>
                  <option value="">Choose district</option>
                  {districts.map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>
              <label>
                <span>Barangay</span>
                <select value={barangayId} onChange={(event) => setBarangayId(event.target.value)} disabled={!district} required>
                  <option value="">Choose barangay</option>
                  {barangays.map((item) => <option key={item.id} value={item.id}>{item.barangay}{item.service_status === "blocked" ? " — unavailable" : ""}</option>)}
                </select>
              </label>
              <button type="submit" disabled={!barangayId || isBlocked}>Find delivery options <span aria-hidden="true">→</span></button>
            </div>
            <p className={`coverage-message ${isBlocked ? "blocked" : ""}`} aria-live="polite">
              {isBlocked ? "This barangay is outside the approved delivery coverage." : selectedBarangay ? "Area available. Continue to pin your exact address and see the fee." : "All 182 Davao City barangays are checked against the approved coverage list."}
            </p>
          </form>
        </div>
        <div className="hero-product" aria-label="Kuya Dars signature lechon manok">
          <div className="hero-product-badge">Extra laki<br/><strong>Extra sarap</strong></div>
          <div className="hero-logo-wrap"><img src="/kuya-dars-logo.png" alt="Kuya Dars Lechon Manok" width="1254" height="1254" fetchPriority="high" decoding="async" /></div>
          <div className="hero-price-card"><span>Signature lechon manok</span><strong>{price}</strong><small>per whole chicken</small></div>
        </div>
      </div>
    </section>

    <section className="service-switcher" aria-label="Ordering options">
      <Link className="active" to="/order"><span aria-hidden="true">▣</span><strong>Delivery</strong><small>Order to your doorstep</small></Link>
      <Link to="/track"><span aria-hidden="true">⌁</span><strong>Track an order</strong><small>Follow live order updates</small></Link>
      <Link to="/account"><span aria-hidden="true">♡</span><strong>My account</strong><small>View your order history</small></Link>
    </section>

    <section className="market-section" id="menu" aria-labelledby="menu-title">
      <div className="market-heading"><div><span className="eyebrow">What's cooking</span><h2 id="menu-title">Our crowd favorite</h2></div><Link to="/order">View order <span aria-hidden="true">→</span></Link></div>
      <article className="market-product-card">
        <div className="product-image-panel">
          <span className="popular-tag">Most ordered</span>
          <img src="/kuya-dars-logo.png" alt="Kuya Dars Lechon Manok logo" width="1254" height="1254" loading="lazy" decoding="async" />
        </div>
        <div className="product-card-copy">
          <div className="product-card-top"><div><span>Whole chicken · good for sharing</span><h3>{chicken?.name ?? "Kuya Dars Lechon Manok"}</h3></div><strong>{price}</strong></div>
          <p>{chicken?.description ?? "Extra Laki, Extra Sarap."} Stock and final availability are confirmed when your order is submitted.</p>
          <div className="product-meta"><span>Freshly prepared</span><span>Exact fee before checkout</span><span>{chicken ? (chicken.available_stock > 0 ? "Available today" : "Sold out") : "Checking stock"}</span></div>
          <Link className="product-add" to="/order">Add to order <span aria-hidden="true">+</span></Link>
        </div>
      </article>
    </section>

    <section className="delivery-confidence" aria-labelledby="delivery-title">
      <div className="confidence-heading"><span className="eyebrow">Delivery without surprises</span><h2 id="delivery-title">See the real fee before placing your order.</h2><p>Your approved barangay and map pin both matter. Distance never overrides a blocked barangay.</p></div>
      <div className="confidence-grid">
        <article><span>01</span><div><strong>Choose your area</strong><p>Select your district and barangay from the official Davao City list.</p></div></article>
        <article><span>02</span><div><strong>Pin the exact address</strong><p>We use the approved radius calculation—not substituted road distance.</p></div></article>
        <article><span>03</span><div><strong>Review your total</strong><p>Up to {freeRadius} km is free; paid zones start at {baseFee}, then {extraFee} per started kilometer beyond 10 km.</p></div></article>
      </div>
      <div className="confidence-cta"><div><strong>Ready to order?</strong><span>It only takes a few steps.</span></div><Link className="button button-primary" to="/order">Start my order <span aria-hidden="true">→</span></Link></div>
    </section>
  </>;
}
