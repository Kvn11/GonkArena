# Tech Stack & Architecture for a 2D Tile-Based LLM-Agent Battle Royale (Browser, 64+ concurrent entities)

## TL;DR
- **Build it browser-first on a single Colyseus (Node.js + TypeScript) authoritative room, rendered by Phaser 3, connected over WebSockets**, with a 10 Hz authoritative server tick, in-memory game state, and Redis only as an optional pub/sub when you later split processes. This is the path with the most "boring, proven" tooling and the lowest friction for a solo dev who needs 64+ entities and a clickable demo URL.
- **For the LLM agents, copy the Project Sid / AI Town pattern: a fast scripted "executor" loop runs every server tick and decides movement deterministically from a goal that an out-of-band LLM call refreshes every 2–5 seconds.** Batch 4–8 agents per GPT-4o-mini request, cache by perception hash, and budget under $1/hour for a full match of 64 agents.
- **Humans join via the exact same Colyseus protocol the agents already speak.** No second code path — the LLM "client" simply submits the same `{move, attack}` inputs a Phaser browser client does. Host on a single Fly.io machine ($5–15/mo) or Hetzner CX23 (€3.49/mo) behind Cloudflare. Defer multi-server scaling until you're past ~256 concurrent entities.

## Key Findings

1. **64 entities on one map is trivial for a Colyseus/Node room.** Colyseus's own FAQ says a "1 vCPU, 1 GB RAM" cloud server "can typically handle 1,000-2,000 concurrent connections for simple games." Your game is ~1/15 of that. Single-process is the right answer for v1.
2. **Tick rate should be low.** A tile-based game with discrete grid movement is closer to WoW (originally ~4 Hz) and Minecraft (20 Hz) than to a shooter. A 10–20 Hz authoritative tick gives 50–100 ms input-to-broadcast latency, leaves ample CPU for AI, and keeps bandwidth small. For reference, Richard Watson (Lead Engineer, Sandbox team, 343 Industries) wrote in the Halo Waypoint post "Closer Look: Halo Infinite's Online Experience": *"Our 4v4 matches run at a 60hz tick rate, and Big Team Battle games run at 30hz."* You are well under that.
3. **WebSockets, not WebTransport — but the gap is narrowing.** As of April 2026 caniuse.com reports WebTransport at **80.35% global support** (Chrome 97+, Edge 98+, Firefox 114+, Safari 26.4+, Opera 83+, Samsung Internet 18+ all fully supported). It is now a credible option, but server-side libraries for Node are still patchy and a tile game gains nothing from QUIC's unreliable datagrams. Pick WebSockets today, revisit in 12 months.
4. **Phaser 3 beats PixiJS for this use case.** Pixi is a rendering library; Phaser is a game framework with built-in tilemaps, Tiled-editor JSON import, cameras, input, and (critically) an official Colyseus+Phaser tutorial covering linear interpolation, client-side prediction, and fixed-tickrate replay.
5. **The "real-time LLM agent" problem is solved by decoupling.** AI Town's `ARCHITECTURE.md` documents that *"AI town has smooth motion for player movement, it runs at 60 ticks per second"* internally, but *"the engine batches up many ticks into a step. AI town runs steps at only 1 time per second"* — and LLM calls are dispatched as async Convex actions on state-transition events, not per-tick. Project Sid's PIANO architecture (Altera, arXiv 2411.00114) makes the same point: *"slow mental processes, such as self-reflection or planning, should not block agents from responding to immediate threats in their surroundings. We want the agents to be interactive in real time with low-latency, but also have the capacity to slowly deliberate and plan."* For a battle royale you want the **two-tier hierarchical pattern**: LLM picks a goal ("hunt the player in the NE quadrant"); deterministic JS code on the server walks the path.
6. **Cost-wise GPT-4o-mini at $0.15/$0.60 per 1M tokens makes this affordable.** OpenAI's pricing page confirms `gpt-4o-mini` at $0.150 input / $0.600 output per 1M tokens. With batching, caching, and a coarse goal-refresh rate, you can run all 64 agents on roughly $0.20–$0.85/hour. (If even that hurts, OpenAI's newer GPT-5 nano tier — $0.05/$0.40 per 1M tokens per Q1 2026 pricing — drops the floor further.)
7. **Persistence is mostly unnecessary** for a battle-royale-style game (matches end and reset). In-memory state plus a SQLite table for match results, agent personas, and a Voyager-style skill library is enough. Redis is only needed if you ever scale to multiple Node processes.
8. **Deployment**: Fly.io or Hetzner Cloud. Fly is easier (one `fly deploy`, persistent VMs, WebSockets supported out of the box), Hetzner is 3–5× cheaper if you tolerate running a single VPS. Note the popular CX22 was retired on 1 January 2026; the current entry tier is the **CX23 (2 vCPU, 4 GB RAM, 40 GB NVMe, 20 TB traffic) at €3.49/month**.

## Details

### 1. Client / rendering layer — **Phaser 3 + TypeScript in the browser**

Recommendation: **Phaser 3** (12+ years old, ~36k GitHub stars, used by Disney, Google, and Mozilla, MIT-licensed, built-in Tiled tilemap loader, arcade physics, scenes, cameras, input). Browser-based so a single URL = demo.

Why not the others, briefly:

- **PixiJS** is faster as a pure renderer (~2× per the js-game-rendering-benchmark) and ~3× smaller, but you would re-implement tilemaps, input, cameras, and scene management. Pick Pixi only if you already have a custom engine. (AI Town uses `pixi-react` because they wrote the engine inside Convex.)
- **Kaboom/Kaplay** is fun but slow (3 FPS in that same benchmark with many sprites) and has thinner docs for multiplayer.
- **Excalibur.js** is a clean TS-first OOP engine; viable, but Phaser has more tutorials and the official Colyseus tutorial path.
- **Godot 4 web export** works but the WASM bundle is heavy (10+ MB), the Colyseus client SDK in Godot is community-maintained, and debugging WebSocket issues across the GDExtension boundary is painful for a solo dev.
- **Unity 2D** is the wrong choice for "click a URL and play." WebGL builds are huge, iteration is slow, and you fight C# ↔ JS marshaling for any custom networking.
- **Custom Canvas/WebGL** is a six-month detour. Don't.

Use TypeScript end-to-end so the Colyseus `Schema` types are shared between server and client. That single decision saves you weeks of debugging.

### 2. Authoritative server — **Colyseus on Node.js (TypeScript), single room**

Colyseus is the right level of abstraction:

- **Rooms** model exactly what you want: one global room of 64+ players running your game loop.
- **Schema** auto-generates binary delta updates over the WebSocket — you mutate plain JS objects, clients see only what changed. The default state-patch cadence is 20 Hz (50 ms), tunable.
- The official Phaser tutorial walks through fixed-tickrate, input queueing, linear interpolation, and client-side prediction — exactly the four netcode building blocks you need.
- License: MIT. ~6.4k stars, 750k+ downloads. Battle-tested in commercial games.
- A single Colyseus room is bound to a single Node process, so all 64 entities share one address space, one event loop, and one tick — no inter-process synchronization, no quadtree needed.

**Why not Nakama?** Nakama (Go, Heroic Labs) is more feature-rich (built-in chat, leaderboards, social graph, matchmaking, IAP) and scales better at very high counts, but the learning curve is steeper, the deployment story is heavier (Postgres + Nakama binary), and most of its built-in features are irrelevant for a hobby battle royale. Pick Nakama only if you already know Go and want PlayFab-style features for free.

**Why not Elixir/Phoenix?** Honestly compelling: Phoenix Channels + a `GenServer` per game + Phoenix Presence is a *very* clean fit for a shared MMO map, and Riot's chat backend famously handles 10M concurrent WebSocket connections per BEAM node. The only reason to pass: as a solo hobby dev, Elixir's ecosystem for tilemap clients, browser tooling, and TS-shared types is thinner. If you already speak Elixir, swap Colyseus for a `GenServer` game loop + Phoenix Channels and you'll be just as happy.

**Why not Bevy/Rust or Unity Mirror?** Overkill at 64 entities. You'll spend 3× longer on tooling for no perceptible gain, and you lose the "everything is TypeScript" simplification.

**Tick rate:** Run authoritative simulation at **10 Hz** (100 ms tick). This is plenty for a grid game (Minecraft is 20 Hz; classic RTS games ran at 4–5 Hz; Halo Infinite BTB is 30 Hz). Broadcast state at the same 10 Hz. Client renders at 60 Hz with linear interpolation between snapshots.

**ECS?** Not necessary at 64 entities. Use a plain `Map<sessionId, Entity>` and a flat 2D array for the tile grid. Re-introduce ECS (e.g., `bitecs`) only if entity counts cross ~10k.

### 3. Network transport — **WebSockets, full stop, in 2026**

- WebSockets have 99%+ browser support and mature server libraries.
- WebTransport (over QUIC/HTTP/3) is genuinely better on paper (multiplexed streams, unreliable datagrams, no head-of-line blocking) and now has 80.35% global coverage per caniuse.com (Chrome 97+, Edge 98+, Firefox 114+, Safari 26.4+) — but server-side support in Node is still immature and Colyseus has WebTransport on its public roadmap rather than as the default transport.
- A tile-based game with 10 Hz ticks needs reliable, ordered messages — TCP's head-of-line blocking is not a problem at this update rate. The Halo tradeoff (unreliable UDP for 60 Hz state) doesn't apply to you.
- **Do NOT use WebRTC data channels.** They're a NAT/STUN/TURN nightmare for the marginal benefit of unreliable delivery you don't need. The author of Agar.io/Diep.io famously hand-rolled WebRTC server-side for low latency; for a hobby project the operational cost is wildly disproportionate.

Optimization to know about: Colyseus can drop in **uWebSockets.js** as its transport (officially supported), which improves throughput substantially over the default `ws` library — worth doing only if you eventually push past 256 entities.

### 4. LLM agent integration — **two-tier hierarchical control with batched, cached LLM "advisor" calls**

This is the most architecturally interesting part of the system. The dominant pattern in the literature (Generative Agents/Smallville, AI Town, Project Sid, Voyager, MindCraft) is:

> **LLM proposes high-level goals or skills at low frequency; deterministic code executes them at high frequency.**

Concretely, for your battle royale:

1. **Agent loop runs as logical entities inside the Colyseus room**, not as separate processes. Each agent is a TS object with `(position, hp, inventory, currentGoal, currentPath, lastLLMTickAt, perceptionDigest)`.
2. **Every server tick (10 Hz):** the "executor" runs pure code — A* one step along `currentPath` toward `currentGoal`, attack if adjacent to an enemy, pick up items, etc. No LLM call. This is what makes movement "real-time."
3. **Every 2–5 seconds per agent:** the "planner" fires an async LLM call (Node `Promise`, not blocking the tick). The prompt is the agent's perception digest (visible tiles, nearby entities, own HP, inventory, last 3 events) and the response is a small JSON action: `{"goal": "hunt", "target": "player_42", "rationale": "low-HP, close, I have a sword"}`. The next tick the executor uses the new goal.
4. **Batch 4–8 agents per LLM call.** Send a JSON array of agent perceptions, get an array of goals back. This reduces per-agent system-prompt overhead by ~60–70% in the cost-optimization literature.
5. **Cache by perception hash.** Many agents in similar tactical situations get the same answer. Hit rates of 30–50% are realistic.
6. **Use GPT-4o-mini by default; promote to GPT-4.1, Claude Sonnet, or GPT-5 for the alpha "leader" agents.** Per-agent budget of ~500 input + 100 output tokens per LLM call, fired every 3 s for 64 agents = ~6,400 calls/hour ≈ 3.2M input + 0.6M output tokens/hour ≈ **$0.84/hour** before any batching/caching, and roughly **$0.20–$0.40/hour with batching+caching**. A 10-minute match: well under $0.20 in LLM costs.
7. **Optionally use a local LLM** for the executor pass (`llama.cpp` running Llama-3.1-8B-Instruct or Qwen2.5-7B). At 64 agents thinking once every 3 seconds you need ~22 inferences/sec, well within reach of a single consumer GPU. The right migration is "start cloud, move to local once cost or rate-limits sting."

This mirrors AI Town's published architecture (60 Hz inner tick, 1 Hz outer step that batches inputs, LLM calls dispatched on conversational triggers) and Project Sid's PIANO architecture (a "Cognitive Controller" that channels output from slow planning modules into fast skill-execution modules). AI Town's own `ARCHITECTURE.md` describes the same input pipeline you'll build: *"Users submit inputs through the insertInput function… The engine then processes inputs, writing their results back to the inputs row."*

For optional "personality" depth, add the **Smallville memory-stream + reflection loop** (vector store of past events, retrieve top-K by recency × importance × similarity, summarize into reflections). Use SQLite with `sqlite-vss`, or Postgres with `pgvector`, to avoid adding a separate vector DB. Skip this for v1 — battle royale matches are too short for it to matter.

**Critical design rule from Voyager** (Wang et al., arXiv 2305.16291): persist successful "skills." Voyager's architecture has three parts — *"1) an automatic curriculum that maximizes exploration, 2) an ever-growing skill library of executable code for storing and retrieving complex behaviors, and 3) a new iterative prompting mechanism that incorporates environment feedback, execution errors, and self-verification for program improvement."* When an LLM agent succeeds at "ambush near the bridge," write that sequence of primitive actions (a small JSON program) to a skill library keyed by description embedding. Next time a similar situation arises, retrieve and run the cached skill — no LLM call needed. Voyager reported its agent *"obtains 3.3× more unique items, travels 2.3× longer distances, and unlocks key tech tree milestones up to 15.3× faster than prior SOTA"* largely because of this caching.

### 5. State & persistence — **in-memory only; SQLite for match logs**

- **Live state**: a TypeScript object inside the Colyseus room. The Colyseus Schema is your source of truth for what to sync; everything else (path planner state, LLM caches, perception digests) lives in plain JS Maps.
- **Spatial query**: Since the world is tile-based with a hard upper bound (say 128×128 = 16,384 tiles) and you have ~64 entities, **a flat 2D array `tiles[x][y] = entityId | null` plus a `Map<entityId, {x,y}>` is faster and simpler than any tree**. Neighbor lookups are O(1). Don't introduce a quadtree or spatial hash — they're for thousands of moving objects.
- **Persistence**: SQLite (`better-sqlite3`) for match results, kill feed, agent personalities, and the skill library. Postgres only if you outgrow it. Redis only if and when you split into multiple Colyseus processes.
- **No persistence required between matches** — battle royale resets. This is a huge simplification over MMORPGs.

### 6. Scaling — **single process until 256+ concurrent entities**

- One Node.js process on a 4-core VM trivially handles 64–256 entities at 10 Hz with state delta sync. Bandwidth is the constraint long before CPU; at 10 Hz × ~100 bytes/entity × 64 entities = ~64 KB/s broadcast per client × 64 clients = ~4 MB/s total upstream. Well within any $5/mo VPS.
- Anti-cheat is free because the server is fully authoritative — clients only send input intents (`{move: "north"}`), not positions. The server validates and produces the new position.
- Multi-server / multi-room (Colyseus + Redis presence + Redis driver) only matters once you want multiple parallel matches or >~500 entities in one room. The Colyseus scalability docs are explicit that this requires Redis.

### 7. Deployment — **Fly.io for v1, Hetzner CX23 once you want to save money**

- **Fly.io**: one `fly deploy`, persistent VMs (no cold starts), WebSockets work out of the box, free SSL, deploy near your users. ~$5–15/mo for a dedicated-CPU 1× VM with 1–2 GB RAM. Best DX for solo dev.
- **Hetzner Cloud CX23** (2 vCPU, 4 GB RAM, 40 GB NVMe, 20 TB traffic): **€3.49/month**. Best price/performance but requires you to set up Caddy/Nginx + TLS + a systemd unit. (Note: the older CX22 was retired by Hetzner on 1 January 2026; CX23 is the current entry tier.)
- **Railway / Render** also fine; Render is slightly more expensive at scale.
- **Region matters very little** for a 10 Hz tile game: 100 ms intercontinental RTT is invisible to grid movement. Pick a single region near your largest audience and stop optimizing.
- Put **Cloudflare in front** for DDoS protection and as a TLS terminator; it proxies WebSockets cleanly on the free tier.

### Architectural diagram (text)

```
┌──────────────────────────────────────────────────────────────────┐
│                          BROWSER (each client)                   │
│   ┌────────────────────────┐    ┌──────────────────────────┐     │
│   │ Phaser 3 scene         │    │ colyseus.js SDK          │     │
│   │  • Tiled tilemap       │◄──►│  • WebSocket             │     │
│   │  • 60 Hz render +      │    │  • State delta callbacks │     │
│   │    linear interp       │    │  • Input messages        │     │
│   └────────────────────────┘    └──────────┬───────────────┘     │
└─────────────────────────────────────────────┼────────────────────┘
                                              │  WSS (TLS)
                                              ▼
┌──────────────────────────────────────────────────────────────────┐
│        Cloudflare (TLS, DDoS, WebSocket pass-through)            │
└─────────────────────────────────────────────┬────────────────────┘
                                              ▼
┌──────────────────────────────────────────────────────────────────┐
│            Fly.io / Hetzner VM — single Node.js process          │
│                                                                  │
│  ┌──────────────────────── Colyseus Room (1 global) ─────────┐   │
│  │                                                           │   │
│  │  Schema state:  tiles[][], players Map, items Map         │   │
│  │                                                           │   │
│  │  10 Hz Game Loop (setInterval 100 ms):                    │   │
│  │   1. Drain input queue (humans AND agents)                │   │
│  │   2. Run executor for every entity                        │   │
│  │      • A* one step toward currentGoal                     │   │
│  │      • Resolve attacks / pickups                          │   │
│  │   3. Mutate Schema → Colyseus emits binary delta          │   │
│  │                                                           │   │
│  │  Async LLM planner (out-of-band, per-agent throttle):     │   │
│  │   • Every 2–5 s, batch 4–8 agents' perceptions            │   │
│  │   • POST OpenAI /v1/chat/completions (gpt-4o-mini)        │   │
│  │   • On reply: write new currentGoal to agent              │   │
│  │   • Cache by perception-hash; persist successful skills   │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│   SQLite (better-sqlite3): match log, agent personas, skills     │
└──────────────────────────────────────────────────────────────────┘
                          │ HTTPS
                          ▼
            OpenAI API  (or local llama.cpp later)
```

### Phased implementation roadmap

**Phase 0 — Skeleton (weekend 1):**
- `npm create colyseus-app` + Phaser starter template.
- Hard-code 64 dummy "agents" that wander randomly on the server, broadcast state, render in Phaser. Verify 64 entities update smoothly. Deploy to Fly.io.

**Phase 1 — Game mechanics (weekend 2–3):**
- Implement grid: 64×64 tiles, A* pathfinding (`pathfinding` npm package).
- Combat: HP, melee attack on adjacent tile, projectile attack with a 1-tick travel time.
- Death + last-one-standing win condition.
- Match lifecycle: lobby → countdown → match → result → reset.

**Phase 2 — Scripted bots (weekend 3–4):**
- Replace random walk with a finite-state machine: `IDLE → HUNT → FLEE → ATTACK`.
- This is your baseline for what "good gameplay" looks like before LLMs.

**Phase 3 — LLM "advisor" (weekend 4–6):**
- For each agent, every 3 s, build a perception JSON (visible tiles, nearby entities, HP, inventory).
- Batch 8 agents per OpenAI call to GPT-4o-mini, parse JSON goals.
- Replace the FSM's `currentState` with `currentGoal` from the LLM.
- Add perception-hash cache and per-agent rate limit.
- Cost dashboard: log tokens per minute.

**Phase 4 — Memory + skills (optional, weekend 6–8):**
- Add Smallville-style memory stream in SQLite with `sqlite-vss`.
- Add Voyager-style skill library keyed by embedding of skill description.
- Hourly reflection summarizing each agent's match into a persona update.

**Phase 5 — Humans join (weekend 8+):**
- Add a "join as human" button on the Phaser client. Server already accepts the same input messages; the only new code is the client-side keyboard handler and a flag on the entity so the LLM planner skips it.
- Add Colyseus reconnection token handling.
- Add a simple lobby (Colyseus has a built-in `LobbyRoom`).

**Phase 6 — Polish & scale (optional):**
- Swap default Colyseus transport for uWebSockets.js if you push past 256 entities.
- Move to local Llama-3.1-8B for the planner if API costs exceed $50/month.
- Add spectator mode that runs purely on Schema state.

## Recommendations

**Do this:**
- Pick Phaser 3 + TypeScript on the client, Colyseus + TypeScript on the server, WebSocket transport, 10 Hz authoritative tick, single Node process on Fly.io. Ship Phase 0 this weekend.
- Use the two-tier LLM architecture (fast deterministic executor, slow LLM "advisor") with GPT-4o-mini and 4-to-8-agent batching.
- Treat humans and AI agents as the same kind of entity — both submit `{move/attack}` messages to the same Colyseus room.

**Don't do this:**
- Don't pick WebTransport or WebRTC for v1. WebSockets are correct.
- Don't pick Nakama, Bevy, or Unity. They are heavier than the problem demands.
- Don't run each LLM agent as its own process — that's an order of magnitude more orchestration for zero gameplay benefit at 64 entities.
- Don't introduce Redis, Postgres, vector DBs, ECS, or a quadtree until you have measured them being necessary.

**Promote to the next tier when:**
- > 256 concurrent entities in one room → switch transport to uWebSockets.js, raise tick to 20 Hz only if needed.
- > 500 concurrent entities OR > 1 active match at a time → add a second Colyseus process + Redis presence/driver, or shard by match-id.
- > $50/month in LLM API costs → switch the planner to a local Llama-3.1-8B-Instruct served by llama.cpp / vLLM on a single GPU box, or drop to GPT-5 nano ($0.05/$0.40 per 1M tokens).
- Humans complain about latency → add region-specific Fly machines and route by player IP.
- WebTransport server libraries for Node mature (likely 2026–2027) → consider migrating; Colyseus's transport layer is pluggable so the swap is mechanical.

## Caveats

- **Cost estimates assume English-language, structured-JSON prompts with ~500-token system prompt + 200-token agent context.** Heavy world descriptions or long memory streams can 5–10× this. Set hard per-match budget caps.
- **The PIANO/Smallville/Project Sid results don't directly transfer.** Those papers studied long-running social simulations, not 5-minute combat matches. Expect your LLM-driven agents to feel "thoughtful but slow" out of the box — you'll want to combine LLM goals with strong scripted micro-behavior so they don't stand still while thinking. The PIANO paper itself notes that with 1,000+ agents *"these runs exceeded the computational constraints of our Minecraft server environment, causing agents to be sporadically unresponsive."*
- **Colyseus and Phaser are MIT-licensed and battle-tested but are maintained by small teams.** Colyseus is effectively driven by one core maintainer (Endel Dreyer) plus a small commercial sponsor (Colyseus Cloud). Both are stable and >10 years old, but expect to occasionally read library source.
- **64-entity Node.js performance is fine until JSON-encoding of broadcast deltas becomes the bottleneck.** Colyseus's Schema already binary-encodes deltas, so you're starting in a good place — but if you find yourself stringifying large object trees per tick, you've regressed and should reach for the Schema again.
- **"Real-time" for LLM agents in this design means ~3-second goal updates, not ~100ms.** If your game design depends on agents reacting to surprise events within one tick, you must lean harder on the deterministic executor layer (e.g., reflexes like "always flee at <20% HP") rather than waiting for the LLM.
- **Anti-cheat once humans join.** Server-authoritative movement covers the basics, but if you ever award skill-based rewards you'll want to add basic input-rate limiting and sanity checks (e.g., reject moves to non-adjacent tiles) — Colyseus does not give you that for free.
