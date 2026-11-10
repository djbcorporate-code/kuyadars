import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Catalog } from "../types";
import { isDavaoCity, matchCoverageBarangay, reverseGeocode } from "../location";
import { formatPhp } from "../../shared/domain";

export function HomePage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [locationMode, setLocationMode] = useState<"idle" | "locating" | "manual" | "outside">("idle");
  const [locationMessage, setLocationMessage] = useState("");
  const [manualCity, setManualCity] = useState("");
  const [manualBarangayId, setManualBarangayId] = useState("");
  const navigate = useNavigate();
  useEffect(() => { api<Catalog>("/api/catalog").then(setCatalog).catch(() => setCatalog(null)); }, []);
  const chicken = catalog?.products[0];
  const price = chicken ? formatPhp(chicken.price_centavos) : "₱280";
  const freeRadius = catalog?.settings.free_radius_km ?? "7";
  const baseFee = catalog ? formatPhp(catalog.settings.paid_zone_base_fee_centavos) : "₱30";
  const extraFee = catalog ? formatPhp(catalog.settings.extra_started_km_fee_centavos) : "₱10";
  const coverage = useMemo(() => [...(catalog?.coverage ?? [])].sort((a, b) => a.barangay.localeCompare(b.barangay, undefined, { numeric: true })), [catalog]);
  const selectedManualBarangay = coverage.find((item) => item.id === manualBarangayId);
  const manualCitySupported = isDavaoCity(manualCity);

  function goToOrder(barangay: Catalog["coverage"][number], coordinates?: { latitude: number; longitude: number }) {
    const query = new URLSearchParams({ district: barangay.administrative_district, barangay: barangay.id });
    if (coordinates) {
      query.set("lat", coordinates.latitude.toString());
      query.set("lng", coordinates.longitude.toString());
      query.set("pinSource", "geolocation");
    }
    navigate(`/order?${query.toString()}`);
  }

  function continueManually(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!manualCitySupported || !selectedManualBarangay || selectedManualBarangay.service_status === "blocked") return;
    goToOrder(selectedManualBarangay);
  }

  function showManual(message: string) {
    setLocationMode("manual");
    setLocationMessage(message);
  }

  function startOrder() {
    setLocationMessage("");
    if (!navigator.geolocation) {
      showManual("Automatic location is unavailable on this device. Enter your city and barangay instead.");
      return;
    }
    setLocationMode("locating");
    navigator.geolocation.getCurrentPosition(async (position) => {
      const coordinates = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      try {
        const resolved = await reverseGeocode(coordinates.latitude, coordinates.longitude);
        if (!isDavaoCity(resolved.city)) {
          setLocationMode("outside");
          setLocationMessage("We do not serve this city for now.");
          return;
        }
        const barangay = matchCoverageBarangay(resolved.barangayCandidates, catalog?.coverage ?? []);
        if (!barangay) {
          setManualCity("Davao City");
          showManual("We found Davao City but could not confidently identify your barangay. Please select it below.");
          return;
        }
        if (barangay.service_status === "blocked") {
          setLocationMode("outside");
          setLocationMessage("We do not serve this barangay for now.");
          return;
        }
        goToOrder(barangay, coordinates);
      } catch {
        showManual("We could not confirm your area automatically. Enter your city and barangay instead.");
      }
    }, () => {
      showManual("Location access was declined or unavailable. Enter your city and barangay instead.");
    }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
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
          <p>Freshly roasted and delivered across supported Davao City barangays. We’ll show the exact delivery fee before you submit.</p>
          <div className="hero-order-action">
            <button className="hero-order-now" type="button" onClick={startOrder} disabled={locationMode === "locating"}>
              <span className="hero-order-icon" aria-hidden="true">⌖</span>
              <span><strong>{locationMode === "locating" ? "Finding your location…" : "Order now"}</strong><small>{locationMode === "locating" ? "Please respond to the browser prompt" : "Use my current location"}</small></span>
              <span className="hero-order-arrow" aria-hidden="true">→</span>
            </button>
            <p>We only request location after you tap. You can enter your area manually if you decline. Lookup © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>.</p>
          </div>

          <div className="location-response" aria-live="polite">
            {locationMode === "outside" && <div className="location-notice outside"><strong>Outside our current delivery area</strong><p>{locationMessage}</p></div>}
            {locationMode === "manual" && <form className="manual-location" onSubmit={continueManually} aria-label="Enter delivery area manually">
              <div className="manual-location-heading"><div><strong>Enter your delivery area</strong><p>{locationMessage}</p></div><button type="button" onClick={startOrder}>Try location again</button></div>
              <div className="manual-location-fields">
                <label><span>City</span><input value={manualCity} onChange={(event) => { setManualCity(event.target.value); setManualBarangayId(""); }} placeholder="Davao City" autoComplete="address-level2" required /></label>
                <label><span>Barangay</span><select value={manualBarangayId} onChange={(event) => setManualBarangayId(event.target.value)} disabled={!manualCitySupported || coverage.length === 0} required><option value="">Choose barangay</option>{coverage.map((item) => <option key={item.id} value={item.id}>{item.barangay}{item.service_status === "blocked" ? " — unavailable" : ""}</option>)}</select></label>
                <button type="submit" disabled={!manualCitySupported || !selectedManualBarangay || selectedManualBarangay.service_status === "blocked"}>Continue <span aria-hidden="true">→</span></button>
              </div>
              {!manualCitySupported && manualCity.trim() && <p className="manual-service-message">We do not serve this city for now.</p>}
              {selectedManualBarangay?.service_status === "blocked" && <p className="manual-service-message">We do not serve this barangay for now.</p>}
              {coverage.length === 0 && <p className="manual-service-message">Delivery areas are still loading. Please try again in a moment.</p>}
            </form>}
          </div>
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
