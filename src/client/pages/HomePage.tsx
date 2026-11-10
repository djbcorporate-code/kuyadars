import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Catalog } from "../types";
import { formatPhp } from "../../shared/domain";

export function HomePage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => { api<Catalog>("/api/catalog").then(setCatalog).catch(() => setCatalog(null)); }, []);
  const chicken = catalog?.products[0];
  return <>
    <section className="hero">
      <div className="hero-copy">
        <span className="eyebrow">Davao City's extra-laki favorite</span>
        <h1>Roasted big.<br/><em>Shared bigger.</em></h1>
        <p>Juicy, charcoal-kissed lechon manok made for family tables, barkada nights, and every celebration in between.</p>
        <div className="hero-actions">
          <Link className="button button-primary" to="/order">Order Now — Check Delivery</Link>
          <Link className="button button-ghost" to="/track">Track My Order</Link>
        </div>
        <div className="availability-row">
          <span className={`availability-dot ${catalog?.settings.orderOpenNow ? "open" : "closed"}`} />
          {catalog ? (catalog.settings.orderOpenNow ? "Online ordering is open" : `Ordering opens ${catalog.settings.orderingOpen}`) : "Checking store availability…"}
          <span>·</span><span>Asia/Manila</span>
        </div>
      </div>
      <div className="hero-art" role="img" aria-label="Placeholder illustration of Kuya Dars lechon manok platter">
        <div className="sun-disc" />
        <div className="platter">
          <div className="chicken-shape"><span className="shine" /></div>
          <span className="leaf leaf-one" /><span className="leaf leaf-two" /><span className="leaf leaf-three" />
        </div>
        <span className="art-note">Brand photography placeholder</span>
      </div>
    </section>

    <section className="promise-strip" aria-label="Ordering highlights">
      <div><span>01</span><strong>Transparent pricing</strong><small>See the exact fee before checkout</small></div>
      <div><span>02</span><strong>Secure tracking</strong><small>A private link for every order</small></div>
      <div><span>03</span><strong>Human verified</strong><small>Every order and payment is reviewed</small></div>
    </section>

    <section className="menu-section">
      <div className="section-heading"><span className="eyebrow">The house specialty</span><h2>One bird. No shortcuts.</h2></div>
      <article className="product-feature">
        <div className="product-number">01</div>
        <div><h3>{chicken?.name ?? "Lechon Manok"}</h3><p>{chicken?.description ?? "Extra Laki, Extra Sarap."} Configurable product availability and stock are checked again when you place the order.</p></div>
        <strong className="product-price">{chicken ? formatPhp(chicken.price_centavos) : "₱280"}<small>per chicken</small></strong>
        <Link to="/order" className="round-arrow" aria-label="Order lechon manok">↗</Link>
      </article>
    </section>

    <section className="delivery-story">
      <div><span className="eyebrow light">Know before you pay</span><h2>Free within 7 km.<br/>Fair after that.</h2></div>
      <div className="rule-cards">
        <div><strong>0–7 km</strong><span>Free delivery</span></div>
        <div><strong>&gt;7–10 km</strong><span>₱30 delivery</span></div>
        <div><strong>Beyond 10 km</strong><span>₱30 + ₱10 / started km</span></div>
      </div>
      <p>Distance uses the straight-line Haversine method from the Tigatto shop pin. Approved barangay coverage always comes first: blocked or unlisted barangays cannot order even when nearby.</p>
    </section>
  </>;
}
