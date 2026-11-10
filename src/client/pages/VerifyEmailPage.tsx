import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { post } from "../api";

export function VerifyEmailPage() {
  const [params] = useSearchParams(); const [state, setState] = useState<"working" | "done" | "error">("working"); const [message, setMessage] = useState("Verifying your email…");
  useEffect(() => {
    const token = params.get("token");
    if (!token) { setState("error"); setMessage("Verification token is missing."); return; }
    post("/api/auth/verify-email", { token }).then(() => { setState("done"); setMessage("Email verified. Your account can now qualify for the one-time first-order promotion."); }).catch((error) => { setState("error"); setMessage(error instanceof Error ? error.message : "Verification failed."); });
  }, [params]);
  return <section className="content-page narrow account-card"><span className="eyebrow">Account verification</span><h1>{state === "working" ? "One moment." : state === "done" ? "You're verified." : "Link unavailable."}</h1><div className={`alert ${state === "error" ? "error" : state === "done" ? "success" : "info"}`}>{message}</div><Link to="/account" className="button button-primary">Open account</Link></section>;
}
