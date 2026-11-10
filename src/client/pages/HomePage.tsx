import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Catalog } from "../types";
import { formatPhp } from "../../shared/domain";

export function HomePage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => { api<Catalog>("/api/catalog").then(setCatalog).catch(() => setCatalog(null)); }, []);
  const chicken = catalog?.products[0];
  const price = chicken ? formatPhp(chicken.price_centavos) : "₱280";
  const freeRadius = catalog?.settings.free_radius_km ?? "7";
  const baseFee = catalog ? formatPhp(catalog.settings.paid_zone_base_fee_centavos) : "₱30";
  const extraFee = catalog ? formatPhp(catalog.settings.extra_started_km_fee_centavos) : "₱10";
  return <>
    <section className="hero">
      <div className="hero-copy">
        <span className="eyebrow">Davao City · Lechon Manok</span>
        <h1>Extra laki.<br/><em>Extra sarap.</em></h1>
        <p>A generously sized, freshly roasted lechon manok made for sharing. Check your barangay, see the exact delivery fee, and order in just a few steps.</p>
        <div className="hero-actions">
          <Link className="button button-primary" to="/order">Start your order <span aria-hidden="true">→</span></Link>
          <Link className="hero-text-link" to="/track">Track an existing order</Link>
        </div>
        <div className="hero-facts" aria-label="Store availability and price">
          <div className="availability-row">
            <span className={`availability-dot ${catalog?.settings.orderOpenNow ? "open" : "closed"}`} />
            <span>{catalog ? (catalog.settings.orderOpenNow ? "Ordering is open" : `Opens at ${catalog.settings.orderingOpen}`) : "Checking availability…"}</span>
          </div>
          <div><span>From</span><strong>{price}</strong><small>per chicken</small></div>
        </div>
      </div>
      <div className="brand-stage">
        <span className="stage-kicker">The house specialty</span>
        <div className="logo-halo">
          <img src="/kuya-dars-logo.png" alt="Kuya Dars Lechon Manok" width="1254" height="1254" fetchPriority="high" decoding="async" />
        </div>
        <div className="stage-note">
          <span aria-hidden="true">●</span>
          <div><strong>Made for the whole table</strong><small>Freshly prepared after order confirmation</small></div>
        </div>
      </div>
    </section>

    <section className="order-path" aria-labelledby="order-path-title">
      <div className="section-heading compact"><span className="eyebrow">Simple from the start</span><h2 id="order-path-title">Craving to confirmed.</h2></div>
      <ol>
        <li><span>1</span><div><strong>Choose your quantity</strong><small>See live price and availability.</small></div></li>
        <li><span>2</span><div><strong>Pin your address</strong><small>We calculate the exact approved fee.</small></div></li>
        <li><span>3</span><div><strong>Submit for review</strong><small>Track every update through a private link.</small></div></li>
      </ol>
    </section>

    <section className="signature-section" aria-labelledby="signature-title">
      <div className="signature-copy">
        <span className="eyebrow">Our signature</span>
        <h2 id="signature-title">One specialty,<br/>done properly.</h2>
        <p>{chicken?.description ?? "Extra Laki, Extra Sarap."} Availability and stock are confirmed again when you place your order.</p>
      </div>
      <article className="signature-card">
        <div><span>Kuya Dars</span><h3>{chicken?.name ?? "Lechon Manok"}</h3><small>{chicken ? (chicken.available_stock > 0 ? "Available to order" : "Currently sold out") : "Availability checked at order"}</small></div>
        <strong>{price}<small>each</small></strong>
        <Link to="/order" aria-label="Order Kuya Dars Lechon Manok">Add to my order <span aria-hidden="true">→</span></Link>
      </article>
    </section>

    <section className="delivery-summary" aria-labelledby="delivery-title">
      <div className="delivery-copy"><span className="eyebrow">Clear delivery pricing</span><h2 id="delivery-title">Know the fee<br/>before checkout.</h2><p>Your map pin and approved barangay determine the delivery fee. We show the exact amount before you submit.</p></div>
      <div className="delivery-rules">
        <div><span>Up to {freeRadius} km</span><strong>Free</strong></div>
        <div><span>Over {freeRadius}–10 km</span><strong>{baseFee}</strong></div>
        <div><span>Beyond 10 km</span><strong>{baseFee} + {extraFee}<small>/ started km</small></strong></div>
        <p>Blocked or unlisted barangays remain unavailable even when the pin is nearby.</p>
      </div>
      <Link className="button button-primary delivery-cta" to="/order">Check my address <span aria-hidden="true">→</span></Link>
    </section>
  </>;
}
