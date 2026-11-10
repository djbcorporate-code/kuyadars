import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api";
import type { User } from "./types";
import { HomePage } from "./pages/HomePage";
import { OrderPage } from "./pages/OrderPage";
import { TrackPage } from "./pages/TrackPage";
import { AuthPage } from "./pages/AuthPage";
import { CsrPage } from "./pages/CsrPage";
import { ReschedulePage } from "./pages/ReschedulePage";
import { PolicyPage } from "./pages/PolicyPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => { api<{ user: User }>("/api/auth/me").then((data) => setUser(data.user)).catch(() => setUser(null)); }, []);
  const isStaff = user?.roles.some((role) => ["owner", "admin", "csr"].includes(role));
  return (
    <div className="site-shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Kuya Dars home">
          <span className="brand-mark" aria-hidden="true"><img src="/kuya-dars-logo.png" alt="" width="1254" height="1254" decoding="async" /></span>
          <span className="brand-name"><strong>Kuya Dars</strong><small>Lechon Manok</small></span>
        </Link>
        <nav aria-label="Main navigation">
          {isStaff && <NavLink className="nav-secondary" to="/csr">Operations</NavLink>}
          <NavLink className="nav-secondary" to="/track">Track order</NavLink>
          <NavLink className="nav-account" to="/account">{user ? user.fullName.split(" ")[0] : "Sign in"}</NavLink>
          <NavLink className="nav-order" to="/order">Order now <span aria-hidden="true">→</span></NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/order" element={<OrderPage user={user} />} />
          <Route path="/track" element={<TrackPage />} />
          <Route path="/track/:token" element={<TrackPage />} />
          <Route path="/account" element={<AuthPage user={user} onUser={setUser} />} />
          <Route path="/csr" element={<CsrPage user={user} />} />
          <Route path="/reschedule/:token" element={<ReschedulePage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/privacy" element={<PolicyPage kind="privacy" />} />
          <Route path="/terms" element={<PolicyPage kind="terms" />} />
        </Routes>
      </main>
      <footer>
        <div className="footer-brand"><img src="/kuya-dars-logo.png" alt="" width="1254" height="1254" loading="lazy" decoding="async" /><div><strong>Kuya Dars Lechon Manok</strong><span>Extra Laki, Extra Sarap.</span></div></div>
        <div className="footer-links"><Link to="/privacy">Privacy</Link><Link to="/terms">Terms & refunds</Link><Link to="/track">Track order</Link></div>
        <p>Delivery availability depends on approved barangay coverage and a valid map pin. Orders require CSR confirmation.</p>
      </footer>
    </div>
  );
}
