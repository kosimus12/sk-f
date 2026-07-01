// worker.js — Einstiegspunkt: Routing, Authentifizierung, Auslieferung des Dashboards.
// Trennt strikt: oeffentliche Login-Seite | Nutzer-API (Login-Token) | Agenten-API (Agent-Token).
import { HubState } from "./hub.js";
import { issueToken, verifyToken, verifyTotp, safeEqual } from "./auth.js";
import { HTML, CSS, APPJS } from "./dashboard.js";

export { HubState };

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
  // Strikt: nur eigene Ressourcen, keine Fremd-Skripte, kein Einbetten.
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
};

function res(body, init = {}, ctype = "application/json") {
  const headers = { "content-type": ctype, ...SEC_HEADERS, ...(init.headers || {}) };
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { ...init, headers });
}

function hub(env) {
  const id = env.HUB.idFromName("main");
  return env.HUB.get(id);
}
async function callHub(env, payload) {
  const r = await hub(env).fetch("https://hub/op", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  return r.json();
}

async function sendTelegram(env, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) }),
    });
  } catch (_) { /* Telegram-Ausfall darf den Hub nicht stoeren */ }
}

function requireEnv(env) {
  for (const k of ["DASHBOARD_PASSWORD", "TOTP_SECRET", "HUB_SECRET", "AGENT_TOKEN"]) {
    if (!env[k]) throw new Error(`Secret ${k} fehlt (per 'wrangler secret put ${k}' setzen)`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- statische Dashboard-Auslieferung (kein Secret noetig, nur Login-Maske) ----
    if (request.method === "GET" && path === "/") return res(HTML, {}, "text/html; charset=utf-8");
    if (request.method === "GET" && path === "/style.css") return res(CSS, {}, "text/css; charset=utf-8");
    if (request.method === "GET" && path === "/app.js") return res(APPJS, {}, "application/javascript; charset=utf-8");
    if (path === "/health") return res({ ok: true });

    try { requireEnv(env); }
    catch (e) { return res({ error: e.message }, { status: 500 }); }

    // ---- Login: Passwort + 2FA -> Token ----
    if (request.method === "POST" && path === "/api/login") {
      const ip = request.headers.get("cf-connecting-ip") || "?";
      const rl = await callHub(env, { op: "loginRate", ip });
      if (!rl.allowed) return res({ error: "Zu viele Versuche. Bitte kurz warten." }, { status: 429 });
      let b; try { b = await request.json(); } catch { return res({ error: "bad request" }, { status: 400 }); }
      const okPw = safeEqual(b.password || "", env.DASHBOARD_PASSWORD);
      const okCode = await verifyTotp(env.TOTP_SECRET, b.code || "");
      if (!okPw || !okCode) return res({ error: "Login fehlgeschlagen" }, { status: 401 });
      const token = await issueToken(env.HUB_SECRET);
      return res({ token });
    }

    // ---- Nutzer-API (Dashboard): Bearer-Token noetig ----
    if (path.startsWith("/api/user/")) {
      const auth = request.headers.get("authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!(await verifyToken(env.HUB_SECRET, token)))
        return res({ error: "unauthorized" }, { status: 401 });
      let b = {}; if (request.method === "POST") { try { b = await request.json(); } catch {} }
      const op = path.slice("/api/user/".length);
      const allowed = ["state", "taskInput", "agentMessage", "broadcast", "coworkerCall",
                       "deleteTask", "getMemory", "setMemory"];
      if (!allowed.includes(op)) return res({ error: "unknown op" }, { status: 404 });
      return res(await callHub(env, { op, ...b, _actor: "user" }));
    }

    // ---- Agenten-API (Bruecken): Agent-Token noetig ----
    if (path.startsWith("/api/agent/")) {
      const tok = request.headers.get("x-agent-token") || "";
      if (!safeEqual(tok, env.AGENT_TOKEN))
        return res({ error: "unauthorized" }, { status: 401 });
      let b = {}; if (request.method === "POST") { try { b = await request.json(); } catch {} }
      const op = path.slice("/api/agent/".length);

      // Sonderfall: Agent antwortet auf eine Telegram-Nachricht -> Worker sendet an Telegram.
      if (op === "telegramReply") {
        if (!env.TELEGRAM_BOT_TOKEN) return res({ error: "telegram nicht konfiguriert" }, { status: 400 });
        if (!b.chatId || !b.text) return res({ error: "chatId und text noetig" }, { status: 400 });
        await sendTelegram(env, b.chatId, b.text);
        return res({ ok: true });
      }

      const allowed = ["register", "heartbeat", "task", "inbox", "message", "coworkerCall",
                       "coworkerResult", "registerCoworker", "getMemory", "setMemory"];
      if (!allowed.includes(op)) return res({ error: "unknown op" }, { status: 404 });
      return res(await callHub(env, { op, ...b, _actor: "agent" }));
    }

    // ---- Telegram-Webhook: Nutzer spricht via Telegram direkt mit dem Haupt-Claude ----
    // URL: POST /telegram/<TELEGRAM_WEBHOOK_SECRET>. Zusaetzlich prueft Telegram's Secret-Header.
    if (request.method === "POST" && path.startsWith("/telegram/")) {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET)
        return res({ error: "telegram nicht konfiguriert" }, { status: 404 });
      const urlSecret = path.slice("/telegram/".length);
      const hdrSecret = request.headers.get("x-telegram-bot-api-secret-token") || "";
      // Beide Geheimnisse muessen stimmen (URL + von Telegram gesetzter Header).
      if (!safeEqual(urlSecret, env.TELEGRAM_WEBHOOK_SECRET) || !safeEqual(hdrSecret, env.TELEGRAM_WEBHOOK_SECRET))
        return res({ error: "unauthorized" }, { status: 401 });
      let upd = {}; try { upd = await request.json(); } catch {}
      const msg = upd.message || upd.edited_message;
      const chatId = msg && msg.chat && msg.chat.id;
      const text = msg && msg.text;
      if (!chatId || !text) return res({ ok: true }); // z.B. Status-Updates ignorieren
      // Nur erlaubte Chat-IDs duerfen steuern.
      const allowList = (env.TELEGRAM_ALLOWED_CHAT || "").split(",").map(s => s.trim()).filter(Boolean);
      if (allowList.length && !allowList.includes(String(chatId))) {
        await sendTelegram(env, chatId, "⛔ Nicht autorisiert.");
        return res({ ok: true });
      }
      const r = await callHub(env, { op: "telegramIn", chatId, text });
      if (!r.ok) await sendTelegram(env, chatId, "⚠️ Gerade ist kein Claude online. Bitte später erneut.");
      else await sendTelegram(env, chatId, "✅ An Claude weitergeleitet. Antwort folgt.");
      return res({ ok: true });
    }

    return res({ error: "not found" }, { status: 404 });
  },
};
