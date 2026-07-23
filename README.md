# Hi-Desert Law — Clio Bridge

A small hosted server that lets Claude create/update Clio tasks and matters
directly — no Chrome tab, no desktop app, no laptop needing to be awake.
This is what makes the daily mailbox-triage automation (and, once wired up,
the Court eFiling watcher) fully headless.

It speaks the Model Context Protocol (MCP) over HTTP, and internally talks
to Clio's real REST API (v4), refreshing its own access token automatically
using a long-lived refresh token.

## What it needs to run

Three Clio OAuth values (from the one-time authorization you already did):

- `CLIO_CLIENT_ID` (the Clio "App Key")
- `CLIO_CLIENT_SECRET` (the Clio "App Secret")
- `CLIO_REFRESH_TOKEN` (from the token exchange)

Plus one you generate yourself:

- `BRIDGE_API_KEY` — a random secret that only Claude's connector should
  know, so nobody else can call this server. Generate one with:
  `openssl rand -hex 32`

None of these are stored in this code — they're set as environment
variables on whatever host runs it, never committed to the repository.

## Deploying (Render.com)

1. Create a free account at render.com.
2. Push this folder to a new GitHub repository (private is fine).
3. In Render: **New → Web Service**, connect the GitHub repo.
4. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance type**: the free or smallest paid tier is enough for this
5. Under **Environment**, add the four variables listed above.
6. Deploy. Render will give you a public URL like
   `https://hi-desert-law-clio-bridge.onrender.com`.
7. Confirm it's alive: visit `https://<your-url>/healthz` in a browser —
   it should just say `ok`.

## Wiring it into Claude

Once deployed, the MCP endpoint is `https://<your-url>/mcp`, authenticated
with a bearer token equal to `BRIDGE_API_KEY`. This gets registered as a
remote HTTP-type MCP server, e.g.:

```json
{
  "mcpServers": {
    "clio-bridge": {
      "type": "http",
      "url": "https://<your-url>/mcp",
      "headers": {
        "Authorization": "Bearer <BRIDGE_API_KEY value>"
      }
    }
  }
}
```

## Tools it exposes

- `clio_search_matters(query, status?)` — find a matter by client name,
  description, or case number.
- `clio_get_matter(matterId)` — fetch one matter's details.
- `clio_create_task(matterId, name, description?, assigneeId, priority?, dueAt?)`
  — create a Clio task.
- `clio_update_matter(matterId, description?, customFields?)` — update a
  matter's description and/or named custom fields (e.g. "Case Number",
  "Hearing Date on Petition"). This is what the eFiling watcher needs to
  stop depending on Chrome.

## Which automations this can replace Chrome for

- **Daily mailbox triage** — task creation + matter lookups (Part 3 of that
  trigger's prompt). Fully covered.
- **Court eFiling watcher** (hourly + late-afternoon runs) — case number /
  matter description updates and correction-task creation. Fully covered
  by `clio_update_matter` + `clio_create_task`; this trigger fires far more
  often than the mailbox triage, so it's the bigger win once it's rewired.
- **Daily court docket review** — only partially. Checking the actual court
  website (San Bernardino Superior Court) still needs a browser; only the
  trailing Clio custom-field write ("Hearing Date on Petition") moves to
  the bridge.
- **Weekly security audit** and the **copier-scan/signature monitor** —
  not applicable; neither writes to Clio in a way this bridge covers.

## Local testing

```
cp .env.example .env   # fill in real values
npm install
npm start
curl http://localhost:3000/healthz
```
