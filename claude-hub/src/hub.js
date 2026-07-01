// hub.js — Durable Object: zentraler Zustand + Nachrichten-Bus + Coworker-Routing.
// Haelt Agenten (deine Claudes), Aufgaben, Nachrichten und Coworker (MCP-Dienste).
// Kommunikation der Bruecken/Dashboard laeuft ueber op-basierte JSON-Requests.

const now = () => Date.now();
const rid = () => crypto.randomUUID();

export class HubState {
  constructor(state) {
    this.state = state;
    this.d = null; // Cache
    this.state.blockConcurrencyWhile(async () => {
      this.d = {
        agents: (await this.state.storage.get("agents")) || {},
        tasks: (await this.state.storage.get("tasks")) || [],
        messages: (await this.state.storage.get("messages")) || [],
        coworkers: (await this.state.storage.get("coworkers")) || [],
        inbox: (await this.state.storage.get("inbox")) || {}, // agentId -> [items]
        memory: (await this.state.storage.get("memory")) ||
          { text: "# Gemeinsames Gedächtnis aller Claudes\n\n(Noch leer — im Dashboard bearbeiten.)\n", version: 0, updatedAt: 0, updatedBy: "system" },
        seq: (await this.state.storage.get("seq")) || 1,
      };
    });
  }

  async persist(keys) {
    for (const k of keys) await this.state.storage.put(k, this.d[k]);
  }

  nextSeq() { return this.d.seq++; }

  // Feed-Eintrag (fuer die Dashboard-Timeline) + Persistenz.
  logEvent(kind, text, meta = {}) {
    this.d.messages.unshift({ id: rid(), seq: this.nextSeq(), kind, text, meta, ts: now() });
    if (this.d.messages.length > 500) this.d.messages.length = 500;
  }

  pushInbox(agentId, item) {
    if (!this.d.inbox[agentId]) this.d.inbox[agentId] = [];
    this.d.inbox[agentId].push({ id: rid(), ts: now(), ...item });
  }

  findAgentByCapability(cap) {
    const list = Object.values(this.d.agents)
      .filter(a => (a.capabilities || []).includes(cap) && a.status !== "offline");
    // Am laengsten nicht genutzten Agenten bevorzugen (einfaches Load-Balancing).
    list.sort((a, b) => (a.lastDelegated || 0) - (b.lastDelegated || 0));
    return list[0] || null;
  }

  async fetch(request) {
    let msg;
    try { msg = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const { op } = msg;
    try {
      const out = await this.dispatch(op, msg);
      return json(out ?? { ok: true });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 400);
    }
  }

  async dispatch(op, m) {
    switch (op) {
      // ---------- Dashboard (Nutzer) ----------
      case "state":
        return {
          agents: Object.values(this.d.agents).map(a => ({
            id: a.id, name: a.name, host: a.host, model: a.model,
            status: a.status, currentTask: a.currentTask, capabilities: a.capabilities || [],
            lastSeen: a.lastSeen, online: now() - (a.lastSeen || 0) < 45000,
          })),
          tasks: this.d.tasks,
          messages: this.d.messages.slice(0, 100),
          coworkers: this.d.coworkers,
          serverTime: now(),
        };

      case "taskInput": {
        const t = this.d.tasks.find(x => x.id === m.taskId);
        if (!t) throw new Error("task not found");
        this.pushInbox(t.agentId, { type: "input", taskId: t.id, text: m.text });
        t.status = "working";
        t.updatedAt = now();
        t.log = (t.log || []).concat({ ts: now(), who: "user", text: m.text });
        this.logEvent("input", `Input an ${this.agentName(t.agentId)}: ${trunc(m.text)}`, { taskId: t.id });
        await this.persist(["tasks", "inbox", "messages", "seq"]);
        return { ok: true };
      }

      case "agentMessage": {
        if (!this.d.agents[m.agentId]) throw new Error("agent not found");
        this.pushInbox(m.agentId, { type: "command", text: m.text });
        this.logEvent("command", `Befehl an ${this.agentName(m.agentId)}: ${trunc(m.text)}`);
        await this.persist(["inbox", "messages", "seq"]);
        return { ok: true };
      }

      case "broadcast": {
        for (const id of Object.keys(this.d.agents))
          this.pushInbox(id, { type: "command", text: m.text });
        this.logEvent("command", `Broadcast an alle: ${trunc(m.text)}`);
        await this.persist(["inbox", "messages", "seq"]);
        return { ok: true };
      }

      // Nutzer ODER Agent: eine Coworker-Aktion anfordern (MCP-Dienst).
      case "coworkerCall": {
        const requestId = rid();
        let targetId = m.targetAgentId;
        if (!targetId) {
          const a = this.findAgentByCapability(m.coworker);
          if (!a) throw new Error(`kein Online-Agent kann Coworker '${m.coworker}'`);
          targetId = a.id;
        }
        const agent = this.d.agents[targetId];
        if (agent) { agent.lastDelegated = now(); }
        this.pushInbox(targetId, {
          type: "coworker", requestId, coworker: m.coworker,
          action: m.action, params: m.params || {},
          replyTo: m._actor === "user" ? "user" : m.fromAgentId,
        });
        this.logEvent("coworker", `Coworker '${m.coworker}.${m.action}' -> ${this.agentName(targetId)}`, { requestId });
        await this.persist(["agents", "inbox", "messages", "seq"]);
        return { ok: true, requestId, agentId: targetId };
      }

      case "deleteTask": {
        this.d.tasks = this.d.tasks.filter(x => x.id !== m.taskId);
        await this.persist(["tasks"]);
        return { ok: true };
      }

      // ---------- Bruecken-Agent ----------
      case "register": {
        // Deterministische ID aus host+name -> Reconnect behaelt Identitaet.
        const id = "agent_" + (m.name + "@" + m.host).toLowerCase().replace(/[^a-z0-9@_.-]/g, "-");
        const prev = this.d.agents[id] || {};
        this.d.agents[id] = {
          id, name: m.name, host: m.host, model: m.model || "unknown",
          capabilities: m.capabilities || prev.capabilities || [],
          status: "idle", currentTask: null, lastSeen: now(),
          lastDelegated: prev.lastDelegated || 0,
        };
        this.logEvent("system", `Agent verbunden: ${m.name} (${m.host}, ${m.model || "?"})`);
        await this.persist(["agents", "messages", "seq"]);
        return { ok: true, agentId: id };
      }

      case "heartbeat": {
        const a = this.d.agents[m.agentId];
        if (!a) throw new Error("unknown agent (bitte neu registrieren)");
        a.lastSeen = now();
        if (m.status) a.status = m.status;
        if (m.currentTask !== undefined) a.currentTask = m.currentTask;
        if (m.capabilities) a.capabilities = m.capabilities;
        await this.persist(["agents"]);
        return { ok: true };
      }

      case "task": {
        const a = this.d.agents[m.agentId];
        if (!a) throw new Error("unknown agent");
        a.lastSeen = now();
        let t = m.taskId && this.d.tasks.find(x => x.id === m.taskId);
        if (!t) {
          t = { id: m.taskId || rid(), agentId: m.agentId, createdAt: now(), log: [] };
          this.d.tasks.unshift(t);
          if (this.d.tasks.length > 300) this.d.tasks.length = 300;
        }
        if (m.title) t.title = m.title;
        if (m.status) t.status = m.status; // open | working | needs_input | done | error
        if (m.question !== undefined) t.question = m.question;
        t.updatedAt = now();
        if (m.note) t.log = (t.log || []).concat({ ts: now(), who: "agent", text: m.note });
        a.status = m.status === "needs_input" ? "needs_input" : (m.status === "done" ? "idle" : "working");
        a.currentTask = m.status === "done" ? null : (m.title || t.title);
        const label = m.status === "needs_input" ? "braucht Input" : (m.status || "update");
        this.logEvent("task", `${a.name}: ${t.title || "Aufgabe"} — ${label}`, { taskId: t.id });
        await this.persist(["agents", "tasks", "messages", "seq"]);
        return { ok: true, taskId: t.id };
      }

      // Bruecke holt (und leert) ihre Inbox. Kurzes Polling vom Agenten.
      case "inbox": {
        const a = this.d.agents[m.agentId];
        if (a) a.lastSeen = now();
        const items = this.d.inbox[m.agentId] || [];
        this.d.inbox[m.agentId] = [];
        await this.persist(["inbox", "agents"]);
        return { items };
      }

      // Agent-zu-Agent Nachricht (oder an eine Faehigkeit geroutet).
      case "message": {
        let toId = m.toAgentId;
        if (!toId && m.toCapability) {
          const a = this.findAgentByCapability(m.toCapability);
          if (!a) throw new Error("kein Agent fuer Faehigkeit " + m.toCapability);
          toId = a.id;
        }
        if (!this.d.agents[toId]) throw new Error("Ziel-Agent unbekannt");
        this.pushInbox(toId, { type: "peer", from: m.fromAgentId, text: m.body });
        this.logEvent("peer", `${this.agentName(m.fromAgentId)} -> ${this.agentName(toId)}: ${trunc(m.body)}`);
        await this.persist(["inbox", "messages", "seq"]);
        return { ok: true };
      }

      // Ergebnis einer Coworker-Aktion zurueckliefern.
      case "coworkerResult": {
        if (m.replyTo && m.replyTo !== "user" && this.d.agents[m.replyTo]) {
          this.pushInbox(m.replyTo, { type: "coworker_result", requestId: m.requestId, result: m.result });
        }
        this.logEvent("coworker", `Ergebnis fuer ${m.requestId ? m.requestId.slice(0, 8) : "?"}: ${trunc(JSON.stringify(m.result))}`, { requestId: m.requestId });
        await this.persist(["inbox", "messages", "seq"]);
        return { ok: true };
      }

      // Coworker (MCP-Dienst) in der Registry sichtbar machen.
      case "registerCoworker": {
        const existing = this.d.coworkers.find(c => c.name === m.name);
        if (existing) Object.assign(existing, { actions: m.actions || existing.actions, providedBy: m.providedBy });
        else this.d.coworkers.push({ name: m.name, actions: m.actions || [], providedBy: m.providedBy, ts: now() });
        await this.persist(["coworkers"]);
        return { ok: true };
      }

      // ---------- Gemeinsames Gedaechtnis (fuer ALLE Claudes synchron) ----------
      case "getMemory":
        return { memory: this.d.memory };

      case "setMemory": {
        const by = m._actor === "user" ? "user" : (this.agentName(m.fromAgentId) || "agent");
        this.d.memory = {
          text: String(m.text ?? ""),
          version: (this.d.memory.version || 0) + 1,
          updatedAt: now(),
          updatedBy: by,
        };
        // Alle Agenten benachrichtigen -> Bruecken ziehen das neue Gedaechtnis.
        for (const id of Object.keys(this.d.agents))
          this.pushInbox(id, { type: "memory", version: this.d.memory.version });
        this.logEvent("system", `Gemeinsames Gedächtnis aktualisiert (v${this.d.memory.version}, von ${by})`);
        await this.persist(["memory", "inbox", "messages", "seq"]);
        return { ok: true, version: this.d.memory.version };
      }

      // ---------- Telegram (Nutzer spricht via Telegram mit dem Haupt-Claude) ----------
      case "telegramIn": {
        // Route an den "main"-Agenten (Haupt-Orchestrator), sonst an ersten Online-Agenten.
        let target = this.findAgentByCapability("main");
        if (!target) target = Object.values(this.d.agents).find(a => now() - (a.lastSeen || 0) < 45000);
        if (!target) {
          this.logEvent("telegram", `Telegram-Nachricht ohne Online-Agent verworfen: ${trunc(m.text)}`);
          await this.persist(["messages", "seq"]);
          return { ok: false, error: "kein Online-Agent" };
        }
        this.pushInbox(target.id, { type: "telegram", chatId: m.chatId, text: m.text });
        this.logEvent("telegram", `Telegram → ${target.name}: ${trunc(m.text)}`, { chatId: m.chatId });
        await this.persist(["inbox", "messages", "seq"]);
        return { ok: true, agentId: target.id };
      }

      // Brute-Force-Schutz fuer Login (pro IP, gleitendes Fenster).
      case "loginRate": {
        const key = "rl:" + (m.ip || "?");
        const rec = (await this.state.storage.get(key)) || { count: 0, resetAt: now() + 60000 };
        if (now() > rec.resetAt) { rec.count = 0; rec.resetAt = now() + 60000; }
        rec.count++;
        await this.state.storage.put(key, rec);
        return { allowed: rec.count <= 8, retryInMs: Math.max(0, rec.resetAt - now()) };
      }

      default:
        throw new Error("unknown op: " + op);
    }
  }

  agentName(id) { return this.d.agents[id]?.name || id; }
}

function trunc(s, n = 120) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
