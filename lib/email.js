// Simple transactional email via Resend (resend.com) — free tier is generous
// and setup is a 2-minute signup + domain verification. Swap this out for
// SendGrid/Postmark/whatever you already use; only this file would change.

async function sendEmail({ to, subject, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.DIGEST_FROM_EMAIL || "crm@elevatemy.ai",
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = { sendEmail };
