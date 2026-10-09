# Deploying TradePilot

TradePilot needs a **Node.js runtime**, not static file hosting: the browser talks
to a Fastify API over REST and keeps a WebSocket open for prices, positions and
executions. Everything below assumes you are deploying the whole stack — the
terminal and the API — behind one HTTPS URL.

---

## Why GitHub Pages will not work

GitHub Pages serves static files only. This app cannot be reduced to static
files:

| Requirement | Evidence |
|---|---|
| 42 browser→API calls | `api.get/post/patch/delete` across `frontend/` |
| A live WebSocket | `new WebSocket` in `frontend/lib/terminal-context.tsx` |
| A custom Node server | `frontend/server.ts` proxies `/api` and `/ws` and injects the DEMO session server-side |
| A dynamic route | `app/(app)/markets/[symbol]` has no `generateStaticParams`, so it is server-rendered on demand |

A static export would produce a shell whose every request 404s — an empty
terminal, not a working one. Use one of the options below instead.

---

## Option A — Render (fastest public URL)

Render reads `render.yaml`, builds `deploy/Dockerfile` and gives you
`https://tradepilot-xxxx.onrender.com`. WebSockets work on that URL.

1. Push this branch to your repository and merge it into `master`.
2. Render dashboard → **New +** → **Blueprint** → select the repo → **Apply**.
3. Wait for the build; the URL appears on the service page.

The blueprint generates `SESSION_SECRET` and `BRIDGE_SECRET` for you, sets
`COOKIE_SECURE=true`, and runs on the in-memory store (data resets on each
deploy). For persistence, create a Render PostgreSQL instance and set
`DATABASE_URL` on the service — the schema in `database/schema.sql` is applied
automatically at boot.

Free-tier caveat: the container sleeps after inactivity and the first request
takes ~50 s to wake it.

## Option B — your own VPS with a domain

`deploy/docker-compose.yml` runs the app, PostgreSQL and Caddy together, with
Caddy issuing and renewing a Let's Encrypt certificate automatically.

```bash
# on the VPS, with the repo checked out and Docker installed
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env          # DOMAIN, SESSION_SECRET, BRIDGE_SECRET, POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml up -d --build
```

Point DNS for `DOMAIN` at the VPS before starting, or Caddy cannot obtain a
certificate. After that, `https://DOMAIN` serves the app, including `/ws`.

## Option C — any Docker host, using the published image

`.github/workflows/docker-image.yml` builds the image on every push to `master`
and pushes it to the GitHub Container Registry:

```bash
docker run -d -p 3000:3000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e BRIDGE_SECRET="$(openssl rand -hex 32)" \
  -e DATABASE_URL="postgresql://user:pass@host:5432/tradepilot" \
  ghcr.io/krriss007/madgroup:latest
```

Works on Fly.io, Railway, ECS, a bare VPS — anything that runs a container and
gives it one inbound port.

---

## What the container does

`deploy/Dockerfile` builds both workspaces, then `deploy/entrypoint.mjs` runs:

```
Fastify API    →  127.0.0.1:8080   (loopback only — never published)
Next terminal  →  0.0.0.0:3000     (the only exposed port)
```

The terminal proxies `/api` and `/ws` to the API, so one public port serves the
UI, the REST API and the WebSocket, and the browser never learns where the API
lives. `deploy/healthcheck.mjs` calls the health route *through that proxy*, so a
green healthcheck means the whole chain works rather than one process.

## Required configuration

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Signs session cookies. **32+ bytes.** `openssl rand -hex 32` |
| `BRIDGE_SECRET` | Signs every command sent to an MT5 EA. **32+ bytes.** Rotating it invalidates device tokens. |
| `DATABASE_URL` | PostgreSQL connection. Without it the app runs in memory and **loses all data on restart**. |
| `COOKIE_SECURE` | `true` in production (HTTPS). |
| `COOKIE_SAME_SITE` | `lax` for a normal first-party deployment. `none` only when the app is embedded in a cross-site iframe. |
| `CORS_ORIGINS` | Your public origin. |
| `DEMO_AUTO_LOGIN` | `true` signs visitors into the shared DEMO account with no password. **DEMO only** — it can never reach LIVE. Set `false` to require sign-in. |

## Build requirement

`next/font/google` fetches Inter at build time, so **the build machine needs
outbound access to `fonts.googleapis.com`**. Render, Vercel and GitHub Actions
all have it. A fully offline builder will fail on that fetch — mirror the font
files and switch `app/layout.tsx` to `next/font/local` if you need an offline
build.

## After deploying

1. Open the URL — DEMO mode, $10,000 simulated balance.
2. **LIVE trading is disabled.** To enable it: Settings → MT5 Connection → create
   a device token → install the EA on *your own* MT5 terminal
   (`docs/MT5_EA_INSTALL.md`) → enable LIVE trading and acknowledge the risk
   warning.
3. Your Windows VPS must be able to reach the backend over HTTPS for the EA to
   connect. The EA never sends your MT5 password; it reads your logged-in
   terminal.

## Verified and not verified

The production build (`npm run build`, 18 routes) and `deploy/entrypoint.mjs`
were verified by running the exact container command locally: pages served 200 in
production mode, the healthcheck passed through the proxy, the API bound to
loopback only, and a DEMO order executed end to end.

**Not** verified, because it cannot be from a sandbox with no Docker and no
outbound network beyond GitHub and the package registries: the `docker build`
itself, the compose stack, Caddy's certificate issuance, and the GitHub Actions
workflow. Run `docker build -f deploy/Dockerfile -t tradepilot .` once on a
machine with Docker before relying on it.
