const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function layout(env: Env, heading: string, bodyHtml: string, cta: { label: string; url: string }) {
  return `<!doctype html><html><body style="margin:0;background:#f5f7f6;font-family:Helvetica,Arial,sans-serif;color:#17221f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:16px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td style="font-size:14px;color:#43504c;padding-bottom:8px">${esc(env.APP_NAME)}</td></tr>
<tr><td style="font-size:22px;padding-bottom:16px">${heading}</td></tr>
<tr><td style="font-size:14px;line-height:22px;padding-bottom:24px">${bodyHtml}</td></tr>
<tr><td><a href="${esc(cta.url)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:10px 24px;border-radius:20px;font-size:14px">${esc(cta.label)}</a></td></tr>
</table></td></tr></table></body></html>`;
}

/** Send through Resend's HTTP API. Without an API key (local dev) the email is logged instead. */
async function send(env: Env, msg: { to: string; subject: string; html: string; text: string; replyTo?: string }) {
  if (!env.RESEND_API_KEY) {
    console.log(`[email not sent: RESEND_API_KEY unset] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: `${env.APP_NAME} <${env.MAIL_FROM}>`,
        to: [msg.to],
        reply_to: msg.replyTo,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return true;
  } catch (err) {
    // Email is best-effort: the in-app notification or invite record still exists.
    console.error("email send failed", msg.to, err);
    return false;
  }
}

export function sendInviteEmail(env: Env, opts: { to: string; inviterName: string; inviterEmail: string; url: string }) {
  const heading = `${esc(opts.inviterName)} invited you to ${esc(env.APP_NAME)}`;
  return send(env, {
    to: opts.to,
    replyTo: opts.inviterEmail,
    subject: `${opts.inviterName} invited you to ${env.APP_NAME}`,
    html: layout(
      env,
      heading,
      `Store and share the family's photos, videos and documents in one place. Sign in with the Google account for <b>${esc(opts.to)}</b> to accept. This invite expires in 14 days.`,
      { label: "Accept invite", url: opts.url },
    ),
    text: `${opts.inviterName} invited you to ${env.APP_NAME}.\n\nSign in with the Google account for ${opts.to} to accept:\n${opts.url}\n\nThis invite expires in 14 days.`,
  });
}

export function sendShareEmail(
  env: Env,
  opts: { to: string; actorName: string; actorEmail: string; fileName: string; isFolder: boolean; role: string; url: string; message?: string },
) {
  const what = opts.isFolder ? "a folder" : "an item";
  const note = opts.message ? `<p style="background:#edf1ef;border-radius:8px;padding:12px">${esc(opts.message)}</p>` : "";
  return send(env, {
    to: opts.to,
    replyTo: opts.actorEmail,
    subject: `${opts.actorName} shared "${opts.fileName}" with you`,
    html: layout(
      env,
      `${esc(opts.actorName)} shared ${what} with you`,
      `${note}<b>${esc(opts.fileName)}</b><br><span style="color:#43504c">You can ${opts.role === "editor" ? "edit" : "view"} it.</span>`,
      { label: "Open", url: opts.url },
    ),
    text: `${opts.actorName} shared "${opts.fileName}" with you.${opts.message ? `\n\n"${opts.message}"` : ""}\n\nOpen: ${opts.url}`,
  });
}
