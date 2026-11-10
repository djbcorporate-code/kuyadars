import { useEffect, useState, type FormEvent } from "react";
import { api, post } from "../api";
import type { User } from "../types";

export function AuthPage({ user, onUser }: { user: User | null; onUser: (user: User | null) => void }) {
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<Array<{ reference: string; review_status: string; payment_status: string; fulfillment_status: string; delivery_status: string; total_centavos: number; submitted_at: string }>>([]);
  useEffect(() => { if (user?.roles.includes("customer")) api<{ orders: typeof history }>("/api/customer/orders").then((value) => setHistory(value.orders)).catch(() => setHistory([])); }, [user]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const data = new FormData(event.currentTarget);
    try {
      await post(register ? "/api/auth/register" : "/api/auth/login", register ? {
        fullName: data.get("fullName"), phone: data.get("phone"), email: data.get("email"), password: data.get("password"),
      } : { email: data.get("email"), password: data.get("password") });
      const me = await api<{ user: User }>("/api/auth/me"); onUser(me.user);
      if (register) setNotice("Account created. Check your email verification queue; first-order discounts require verified contact details.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not sign in."); }
  }
  async function logout() { await post("/api/auth/logout", {}); onUser(null); }
  if (user) return <section className="content-page narrow account-card">
    <span className="eyebrow">Your account</span><h1>Welcome, {user.fullName}.</h1><p>{user.email}</p>
    <div className="role-row">{user.roles.map((role) => <span className="status-pill" key={role}>{role}</span>)}</div>
    {user.roles.includes("customer") && <div className="account-history"><h2>Order history</h2>{history.length === 0 ? <p>No account orders yet. Guest orders remain available through their private links.</p> : history.map((order) => <article key={order.reference}><div><strong>{order.reference}</strong><small>{new Date(order.submitted_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}</small></div><span>{order.delivery_status !== "not_scheduled" ? order.delivery_status.replaceAll("_", " ") : order.fulfillment_status.replaceAll("_", " ")}</span><strong>{new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(order.total_centavos / 100)}</strong></article>)}</div>}
    <button className="button button-ghost" onClick={logout}>Sign out</button>
  </section>;
  return <section className="auth-layout">
    <div className="auth-message"><span className="eyebrow light">Optional account</span><h1>{register ? "Make your first order count." : "Good to see you again."}</h1><p>Guest checkout is always available. An account adds order history and verified first-order promotion eligibility.</p></div>
    <form className="panel auth-form" onSubmit={submit}>
      <h2>{register ? "Create account" : "Sign in"}</h2>
      {register && <><label>Full name<input name="fullName" required minLength={2}/></label><label>Mobile number<input name="phone" required minLength={8}/></label></>}
      <label>Email address<input type="email" name="email" autoComplete="email" required/></label>
      <label>Password<input type="password" name="password" autoComplete={register ? "new-password" : "current-password"} minLength={12} required/></label>
      {error && <div className="alert error">{error}</div>}{notice && <div className="alert success">{notice}</div>}
      <button className="button button-primary" type="submit">{register ? "Create account" : "Sign in"}</button>
      <button className="text-button" type="button" onClick={() => { setRegister(!register); setError(""); }}>{register ? "Already registered? Sign in" : "New here? Create an account"}</button>
    </form>
  </section>;
}
