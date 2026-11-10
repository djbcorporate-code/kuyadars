import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, post } from "../api";

export function ReschedulePage() {
  const { token } = useParams();
  const [data, setData] = useState<{ reference: string; status: string; expires_at: string; requires_fresh_preparation: boolean } | null>(null);
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { if (token) api<typeof data>(`/api/reschedule/${token}`).then(setData).catch((e) => setError(e.message)); }, [token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { const result = await post<{ message: string }>(`/api/reschedule/${token}`, { requestedSlot: new Date(String(form.get("slot"))).toISOString(), notes: form.get("notes") }); setMessage(result.message); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Request failed."); }
  }
  return <section className="content-page narrow"><span className="eyebrow">Secure rescheduling</span><h1>Choose a new delivery time.</h1>
    {error && <div className="alert error">{error}</div>}
    {data && <><p>Order <strong>{data.reference}</strong> was physically returned to the shop. Your request will be reviewed by CSR and may include a separately agreed delivery fee.</p>
      <div className="alert info">Fresh preparation is required. Previously cooked food will not be silently reused.</div>
      <form className="panel stack" onSubmit={submit}><label>Requested date and time<input name="slot" type="datetime-local" required/></label><label>Notes<textarea name="notes" rows={4}/></label><button className="button button-primary">Send request</button></form></>}
    {message && <div className="alert success">{message}</div>}
  </section>;
}
