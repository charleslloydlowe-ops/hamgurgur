import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 3;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function cleanName(name) {
  return String(name || "Player").replace(/[^\w \-]/g, "").trim().slice(0, 16) || "Player";
}

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create") {
      let code;
      for (let i = 0; i < 10; i++) {
        code = roomCode();
        const id = env.GAME_ROOMS.idFromName(code);
        const stub = env.GAME_ROOMS.get(id);
        const res = await stub.fetch(new Request("https://room/create", { method: "POST" }));
        if (res.ok) return json({ code });
      }
      return json({ error: "Could not create room" }, 500);
    }

    if (url.pathname === "/api/join") {
      const code = (url.searchParams.get("code") || "").toUpperCase();
      if (!/^[A-Z2-9]{5}$/.test(code)) return json({ error: "Invalid room code" }, 400);
      const id = env.GAME_ROOMS.idFromName(code);
      const stub = env.GAME_ROOMS.get(id);
      const res = await stub.fetch(new Request("https://room/status"));
      if (!res.ok) return json({ error: "Room not found" }, 404);
      return res;
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ error: "WebSocket upgrade required" }, 426);
      }
      const code = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z2-9]{5}$/.test(code)) return json({ error: "Invalid room code" }, 400);
      const id = env.GAME_ROOMS.idFromName(code);
      return env.GAME_ROOMS.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = new Map();
    this.state = "lobby";
    this.started = false;
    this.hostId = null;
    this.impostors = new Set();
    this.bodies = [];
    this.tasks = {};
    this.votes = {};
    this.meeting = null;
    this.sabotage = null;
    this.lastTick = Date.now();
    this.loadPromise = this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get("room");
      if (saved) {
        this.state = saved.state || "lobby";
        this.started = !!saved.started;
        this.hostId = saved.hostId || null;
        this.impostors = new Set(saved.impostors || []);
        this.bodies = saved.bodies || [];
        this.tasks = saved.tasks || {};
        this.votes = saved.votes || {};
        this.meeting = saved.meeting || null;
        this.sabotage = saved.sabotage || null;
      }
    });
  }

  async save() {
    await this.ctx.storage.put("room", {
      state: this.state, started: this.started, hostId: this.hostId,
      impostors: [...this.impostors], bodies: this.bodies,
      tasks: this.tasks, votes: this.votes, meeting: this.meeting,
      sabotage: this.sabotage
    });
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch {}
    }
  }

  snapshot() {
    return {
      type: "state",
      state: this.state,
      hostId: this.hostId,
      players: [...this.players.values()].map(p => ({
        id:p.id, name:p.name, x:p.x, y:p.y, color:p.color,
        alive:p.alive, ready:p.ready, role: this.impostors.has(p.id) ? "impostor" : "crewmate"
      })),
      bodies: this.bodies,
      meeting: this.meeting,
      sabotage: this.sabotage
    };
  }

  async fetch(request) {
    await this.loadPromise;
    const url = new URL(request.url);

    if (url.pathname === "/create") {
      const saved = await this.ctx.storage.get("room");
      if (saved) return new Response("exists", { status: 409 });
      await this.save();
      return new Response("created");
    }

    if (url.pathname === "/status") {
      return json({ ok:true, players:this.players.size, state:this.state });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status:426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const params = url.searchParams;
    const id = crypto.randomUUID();
    const player = {
      id, name: cleanName(params.get("name")), color: params.get("color") || "#ff3b30",
      x: 0, y: 0, alive: true, ready:false
    };

    if (this.players.size >= MAX_PLAYERS) {
      server.close(1013, "Room full");
      return new Response(null, { status:101, webSocket:client });
    }

    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    this.broadcast({type:"joined", player:{id, name:player.name}});
    server.send(JSON.stringify({...this.snapshot(), you:id}));
    this.broadcast(this.snapshot());
    await this.save();

    return new Response(null, { status:101, webSocket:client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const player = [...this.players.values()].find(p => this.ctx.getWebSockets().some(s => s === ws && s));
    // Associate websocket with player using attachment.
    const meta = ws.deserializeAttachment?.();
    const pid = meta?.id || msg.id;
    const p = this.players.get(pid);
    if (!p) return;

    if (msg.type === "hello") {
      ws.serializeAttachment({id:pid});
      return;
    }

    if (msg.type === "move" && this.state === "playing" && p.alive) {
      p.x = Math.max(30, Math.min(970, Number(msg.x) || p.x));
      p.y = Math.max(30, Math.min(570, Number(msg.y) || p.y));
      this.broadcast({type:"move", id:p.id, x:p.x, y:p.y});
      return;
    }

    if (msg.type === "ready" && this.state === "lobby") {
      p.ready = !!msg.ready;
      this.broadcast(this.snapshot());
      return;
    }

    if (msg.type === "start" && p.id === this.hostId && this.state === "lobby") {
      if (this.players.size < MIN_PLAYERS) {
        ws.send(JSON.stringify({type:"error", message:`Need at least ${MIN_PLAYERS} players.`}));
        return;
      }
      this.startGame();
      await this.save();
      this.broadcast(this.snapshot());
      return;
    }

    if (msg.type === "kill" && this.state === "playing" && p.alive && this.impostors.has(p.id)) {
      const target = this.players.get(msg.target);
      if (!target || !target.alive || target.id === p.id) return;
      const d = Math.hypot(target.x-p.x, target.y-p.y);
      if (d > 75) return;
      target.alive = false;
      this.bodies.push({x:target.x,y:target.y,color:target.color});
      this.broadcast({type:"kill", by:p.id, target:target.id});
      this.broadcast(this.snapshot());
      await this.save();
      this.checkWin();
      return;
    }

    if (msg.type === "report" && this.state === "playing") {
      const body = this.bodies[msg.bodyIndex];
      if (!body || !p.alive) return;
      this.bodies.splice(msg.bodyIndex,1);
      this.openMeeting(p.id);
      await this.save();
      this.broadcast(this.snapshot());
      return;
    }

    if (msg.type === "meeting" && this.state === "playing" && p.alive) {
      this.openMeeting(p.id);
      await this.save();
      this.broadcast(this.snapshot());
      return;
    }

    if (msg.type === "vote" && this.state === "meeting" && p.alive) {
      this.votes[p.id] = msg.target || "skip";
      const alive = [...this.players.values()].filter(x=>x.alive);
      if (Object.keys(this.votes).length >= alive.length) {
        const counts = {};
        Object.values(this.votes).forEach(v => counts[v]=(counts[v]||0)+1);
        const winner = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
        if (winner && winner[0] !== "skip") {
          const ejected = this.players.get(winner[0]);
          if (ejected) ejected.alive = false;
        }
        this.broadcast({type:"ejected", target:winner?.[0] || "skip"});
        this.state = "playing";
        this.meeting = null;
        this.votes = {};
        await this.save();
        this.broadcast(this.snapshot());
        this.checkWin();
      }
      return;
    }

    if (msg.type === "sabotage" && this.state === "playing" && this.impostors.has(p.id)) {
      this.sabotage = {kind: msg.kind || "lights", until: Date.now()+30000};
      this.broadcast({type:"sabotage", sabotage:this.sabotage});
      return;
    }

    if (msg.type === "task" && this.state === "playing" && p.alive && !this.impostors.has(p.id)) {
      this.tasks[p.id] = (this.tasks[p.id] || 0) + 1;
      this.broadcast({type:"task", id:p.id, count:this.tasks[p.id]});
      this.checkWin();
    }
  }

  async webSocketClose(ws) {
    const meta = ws.deserializeAttachment?.();
    const pid = meta?.id;
    if (pid) this.players.delete(pid);
    if (pid === this.hostId) this.hostId = this.players.keys().next().value || null;
    this.broadcast(this.snapshot());
    await this.save();
  }

  startGame() {
    this.state = "playing";
    this.started = true;
    const ids = [...this.players.keys()];
    const count = ids.length >= 8 ? 2 : 1;
    this.impostors = new Set();
    while (this.impostors.size < count) {
      this.impostors.add(ids[Math.floor(Math.random()*ids.length)]);
    }
    for (const p of this.players.values()) {
      p.alive = true; p.x = 500; p.y = 300; p.ready = false;
    }
    this.bodies = [];
    this.tasks = {};
    this.sabotage = null;
  }

  openMeeting(caller) {
    this.state = "meeting";
    this.meeting = {caller, endsAt:Date.now()+30000};
    this.votes = {};
  }

  checkWin() {
    const alive = [...this.players.values()].filter(p=>p.alive);
    const imps = alive.filter(p=>this.impostors.has(p.id));
    const crew = alive.filter(p=>!this.impostors.has(p.id));
    const totalCrewTasks = [...this.players.values()]
      .filter(p=>!this.impostors.has(p.id))
      .reduce((n,p)=>n+(this.tasks[p.id]||0),0);
    if (!imps.length) this.endGame("crewmates");
    else if (imps.length >= crew.length) this.endGame("impostors");
    else if (totalCrewTasks >= crew.length * 3) this.endGame("crewmates");
  }

  endGame(winner) {
    this.state = "ended";
    this.broadcast({
      type:"gameover", winner,
      impostors:[...this.impostors].map(id=>this.players.get(id)?.name).filter(Boolean)
    });
  }
}
