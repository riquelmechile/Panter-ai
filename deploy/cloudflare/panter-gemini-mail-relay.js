// Panter Gemini mail relay (Cloudflare Worker). Separate from Xanxittoo's relay.
// POST /wake: Panter asks to e-mail one Gemini task. The Worker sends only envelopes that Panter itself
//   confirms (POST /a2a/gemini/email-validate), to the single Gmail inbox that Gemini monitors.
// email(): Gemini's reply to RELAY_ADDRESS is forwarded raw to Panter (/a2a/gemini/email-result), which
//   completes the work only with the one-time token of the current lease.
// Bindings: PANTER_BASE_URL (https), RECIPIENT, RELAY_ADDRESS, RELAY_SECRET (text) and EMAIL (send_email to
//   RECIPIENT). RELAY_SECRET equals Panter's PANTER_GEMINI_MAIL_RELAY_SECRET: /wake requires it and both calls
//   to Panter carry it. Without it (or with a non-https PANTER_BASE_URL) the Worker refuses to run.
const MAX_WAKE_BYTES = 160_000;
const MAX_EMAIL_BYTES = 300 * 1024; // base64 of this stays under Panter's 420 000-character cap
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function sameKey(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function misconfigured(env) {
  return typeof env.RELAY_SECRET !== "string" || env.RELAY_SECRET.length < 32 ||
    !String(env.PANTER_BASE_URL || "").startsWith("https://");
}
function panterHeaders(env) {
  return { "content-type": "application/json", accept: "application/json", "user-agent": "Panter-Gemini-Mail-Relay/1",
    "x-panter-relay-key": env.RELAY_SECRET };
}
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function taskText(e) {
  return [
    "PANTER GEMINI TASK",
    "",
    `work_id: ${e.work_id}`,
    `role: ${e.role}`,
    `attempt: ${e.attempt}`,
    `expires_at: ${e.expires_at}`,
    "",
    "You are Gemini, a worker of Panter-ai. The leader is Claude. Use Gemini 4 Argon with thinking level high.",
    "Do only the task below. Do not delegate. Do not modify repositories, accounts or services unless the task explicitly authorizes it.",
    "",
    "TASK:",
    e.instruction,
    "",
    "HOW TO DELIVER THE RESULT:",
    "Reply to this same e-mail (reply, do not forward). Put this marker line and then one JSON object on ONE single line,",
    "copying work_id and token exactly, with success true or false and your complete result as a string:",
    e.result_marker,
    JSON.stringify(e.result_template),
    "",
    "Include in the result the model and thinking level you actually used, or \"not verified\" if you cannot see them.",
    "Never claim success you did not achieve; if you could not complete the task, set success to false and explain why.",
    "Do not post the result anywhere else.",
  ].join("\n");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return json({ ok: true, service: "panter-gemini-mail-relay" });
    if (request.method !== "POST" || url.pathname !== "/wake") return json({ ok: false, error: "not_found" }, 404);
    if (misconfigured(env)) return json({ ok: false, error: "relay_misconfigured" }, 503);
    if (!sameKey(request.headers.get("x-panter-relay-key") || "", env.RELAY_SECRET))
      return json({ ok: false, error: "unauthorized" }, 401);
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_WAKE_BYTES) return json({ ok: false, error: "body_too_large" }, 413);
    let payload;
    try { payload = JSON.parse(text); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const e = payload?.envelope;
    if (payload?.version !== "panter-gemini-mail-v1" || payload?.recipient !== env.RECIPIENT || !e ||
        typeof e !== "object" || !UUID.test(String(e.work_id)) || typeof e.instruction !== "string")
      return json({ ok: false, error: "invalid_envelope" }, 400);
    // Only Panter decides what may be mailed: it must recognise this exact envelope.
    const check = await fetch(`${env.PANTER_BASE_URL}/a2a/gemini/email-validate`, {
      method: "POST", redirect: "manual",
      headers: panterHeaders(env),
      body: JSON.stringify({ envelope: e }),
    });
    let verdict = null;
    try { verdict = await check.json(); } catch { verdict = null; }
    if (!check.ok || verdict?.ok !== true || verdict?.work_id !== e.work_id)
      return json({ ok: false, error: "envelope_rejected", status: check.status }, 403);
    const sent = await env.EMAIL.send({
      from: env.RELAY_ADDRESS, to: env.RECIPIENT, replyTo: env.RELAY_ADDRESS,
      subject: `[PANTER_GEMINI] ${e.work_id}`,
      text: taskText(e),
      headers: { "X-Panter-Work": String(e.work_id), "X-Panter-Lease": String(e.lease_generation) },
    });
    return json({ ok: true, accepted: true, message_id: sent?.messageId || "", work_id: e.work_id }, 202);
  },

  async email(message, env) {
    if (misconfigured(env)) { message.setReject("relay misconfigured"); return; }
    const from = String(message.from || "").trim().toLowerCase();
    const to = String(message.to || "").trim().toLowerCase();
    if (to !== String(env.RELAY_ADDRESS).toLowerCase()) { message.setReject("unexpected recipient"); return; }
    if (from !== String(env.RECIPIENT).toLowerCase()) { message.setReject("unexpected sender"); return; }
    if (Number(message.rawSize || 0) > MAX_EMAIL_BYTES) { message.setReject("result e-mail too large"); return; }
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    if (raw.byteLength > MAX_EMAIL_BYTES) { message.setReject("result e-mail too large"); return; }
    const body = JSON.stringify({ envelope_from: from, envelope_to: to, raw_mime_base64: toBase64(raw) });
    // Panter may be restarting: retry network errors and 5xx a few times before bouncing Gemini's reply.
    let last = "unreachable";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 1500 * 2 ** (attempt - 1)));
      try {
        const response = await fetch(`${env.PANTER_BASE_URL}/a2a/gemini/email-result`, {
          method: "POST", redirect: "manual", headers: panterHeaders(env), body,
        });
        if (response.ok) return;
        last = `HTTP ${response.status}`;
        if (response.status < 500) break; // a definitive refusal: do not retry
      } catch { last = "unreachable"; }
    }
    message.setReject(`Panter did not accept the result: ${last}`);
  },
};
