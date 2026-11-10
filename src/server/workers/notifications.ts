import nodemailer from "nodemailer";
import { loadConfig } from "../config.js";
import { createDatabase, inTransaction } from "../db.js";

const config = loadConfig();
const db = createDatabase(config);
const transporter = config.NOTIFICATION_DRIVER === "smtp" ? nodemailer.createTransport({
  host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.smtpSecure,
  auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
}) : null;

type Notification = { id: string; template: string; recipient: string; payload: Record<string, unknown>; attempts: number };

function render(item: Notification) {
  const reference = String(item.payload.reference ?? "your order");
  const templates: Record<string, { subject: string; text: string }> = {
    order_submitted: { subject: `Order ${reference} submitted`, text: `Your order is awaiting CSR review. It is not yet accepted. Track securely: ${item.payload.trackingUrl}` },
    order_confirmed: { subject: `Order ${reference} confirmed`, text: "Your order is confirmed. Follow your secure tracking link for preparation and delivery updates." },
    verify_email: { subject: "Verify your Kuya Dars email", text: `Verify your account: ${item.payload.verifyUrl}` },
    rts_reschedule: { subject: `Reschedule ${reference}`, text: `Your order was physically returned to the shop. Request a new slot using this single-use link: ${item.payload.rescheduleUrl}. Fresh preparation requires CSR approval.` },
    refund_verified: { subject: `Refund update for ${reference}`, text: `The merchant refund record has been verified. Controlled proof link (expires and has limited views): ${item.payload.proofUrl}` },
    refund_overdue: { subject: `URGENT: refund action overdue for ${reference}`, text: "The five-minute refund initiation/documentation SLA is overdue. Review the order immediately." },
  };
  return templates[item.template] ?? { subject: `Kuya Dars update: ${reference}`, text: "There is an update on your order. Open your secure tracking link." };
}

async function enqueueEscalations() {
  if (!config.MANAGER_EMAIL) return;
  await db.query(
    `INSERT INTO notification_outbox(order_id,template,recipient,payload,idempotency_key)
     SELECT id,'refund_overdue',$1,jsonb_build_object('reference',reference),'refund-overdue:'||id
     FROM orders WHERE refund_status='required' AND refund_action_due_at<now()
     ON CONFLICT DO NOTHING`, [config.MANAGER_EMAIL],
  );
}

async function processOne() {
  const item = await inTransaction(db, async (client) => {
    const result = await client.query<Notification>(
      `SELECT id,template,recipient,payload,attempts FROM notification_outbox
       WHERE status IN ('pending','failed') AND next_attempt_at<=now() AND attempts<8
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (!result.rowCount) return null;
    await client.query("UPDATE notification_outbox SET status='processing',attempts=attempts+1 WHERE id=$1", [result.rows[0].id]);
    return result.rows[0];
  });
  if (!item) return false;
  if (!transporter) {
    await db.query(
      `UPDATE notification_outbox SET status='failed',last_error='Console driver: message intentionally not sent',
       next_attempt_at=now()+interval '1 hour' WHERE id=$1`, [item.id],
    );
    console.warn(`Notification ${item.id} (${item.template}) not sent: SMTP is not configured.`);
    return true;
  }
  try {
    const message = render(item);
    await transporter.sendMail({ from: config.EMAIL_FROM, to: item.recipient, subject: message.subject, text: message.text });
    await db.query("UPDATE notification_outbox SET status='sent',sent_at=now(),last_error=NULL WHERE id=$1", [item.id]);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown SMTP error";
    await db.query(
      `UPDATE notification_outbox SET status=CASE WHEN attempts>=8 THEN 'dead' ELSE 'failed' END,last_error=$2,
       next_attempt_at=now()+make_interval(mins => LEAST(60,2^attempts)) WHERE id=$1`, [item.id, message],
    );
  }
  return true;
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
while (!stopping) {
  await enqueueEscalations();
  const processed = await processOne();
  if (!processed) await new Promise((resolve) => setTimeout(resolve, 5000));
}
await db.end();
