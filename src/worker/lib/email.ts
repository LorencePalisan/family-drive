const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function layout(env: Env, heading: string, bodyHtml: string, cta: { label: string; url: string }, footer: string) {
  // The link is also shown as plain text: a real, readable address looks less like phishing than a lone button.
  return `<!doctype html><html><body style="margin:0;background:#f5f7f6;font-family:Helvetica,Arial,sans-serif;color:#17221f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:16px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td style="font-size:14px;color:#43504c;padding-bottom:8px">${esc(env.APP_NAME)}</td></tr>
<tr><td style="font-size:22px;padding-bottom:16px">${heading}</td></tr>
<tr><td style="font-size:14px;line-height:22px;padding-bottom:24px">${bodyHtml}</td></tr>
<tr><td style="padding-bottom:16px"><a href="${esc(cta.url)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:10px 24px;border-radius:20px;font-size:14px">${esc(cta.label)}</a></td></tr>
<tr><td style="font-size:13px;line-height:20px;color:#43504c;padding-bottom:24px;word-break:break-all">Or open this link: <a href="${esc(cta.url)}" style="color:#0f766e">${esc(cta.url)}</a></td></tr>
<tr><td style="font-size:12px;line-height:18px;color:#6f7c78;border-top:1px solid #dde4e1;padding-top:16px">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Send through Resend's HTTP API. Without an API key (local dev) the email is logged instead. */
async function send(
  env: Env,
  msg: { to: string; subject: string; html: string; text: string; replyTo?: string; fromName?: string },
) {
  if (!env.RESEND_API_KEY) {
    console.log(`[email not sent: RESEND_API_KEY unset] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: `${msg.fromName ?? env.APP_NAME} <${env.MAIL_FROM}>`,
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

/** Display name like "Lorence (Family Drive)": mail from a person reads as personal rather than automated. */
const fromPerson = (env: Env, name: string) => `${name.replace(/[<>"]/g, "")} (${env.APP_NAME})`;

export function sendInviteEmail(env: Env, opts: { to: string; inviterName: string; inviterEmail: string; url: string }) {
  const inviter = esc(opts.inviterName);
  const heading = `${inviter} invited you to ${esc(env.APP_NAME)}`;
  return send(env, {
    to: opts.to,
    replyTo: opts.inviterEmail,
    fromName: fromPerson(env, opts.inviterName),
    subject: `${opts.inviterName} invited you to ${env.APP_NAME}`,
    html: layout(
      env,
      heading,
      `Hi! ${inviter} set up ${esc(env.APP_NAME)}, a private space where our family keeps photos, videos and documents together.` +
        `<br><br>Open the invite and choose your <b>${esc(opts.to)}</b> account to join. The invite is only for you and expires in 14 days.`,
      { label: "Accept invite", url: opts.url },
      `You're getting this because ${inviter} (${esc(opts.inviterEmail)}) invited ${esc(opts.to)}. ` +
        `Weren't expecting it? You can ignore this email, or just reply to ask ${inviter}.`,
    ),
    text:
      `Hi! ${opts.inviterName} set up ${env.APP_NAME}, a private space where our family keeps photos, videos and documents together.\n\n` +
      `Open the invite and choose your ${opts.to} account to join:\n${opts.url}\n\n` +
      `The invite is only for you and expires in 14 days.\n\n` +
      `You're getting this because ${opts.inviterName} (${opts.inviterEmail}) invited ${opts.to}. ` +
      `Weren't expecting it? You can ignore this email, or just reply to ask ${opts.inviterName}.`,
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
    fromName: fromPerson(env, opts.actorName),
    subject: `${opts.actorName} shared "${opts.fileName}" with you`,
    html: layout(
      env,
      `${esc(opts.actorName)} shared ${what} with you`,
      `${note}<b>${esc(opts.fileName)}</b><br><span style="color:#43504c">You can ${opts.role === "editor" ? "edit" : "view"} it.</span>`,
      { label: "Open", url: opts.url },
      `${esc(opts.actorName)} (${esc(opts.actorEmail)}) shared this with you in ${esc(env.APP_NAME)}. Reply to this email to reach them.`,
    ),
    text: `${opts.actorName} shared "${opts.fileName}" with you.${opts.message ? `\n\n"${opts.message}"` : ""}\n\nOpen: ${opts.url}`,
  });
}
