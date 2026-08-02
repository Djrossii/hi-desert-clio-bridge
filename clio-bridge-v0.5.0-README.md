# Hi-Desert Law — Clio Bridge

A small hosted server that lets Claude create/update Clio tasks and matters
directly — no Chrome tab, no desktop app, no laptop needing to be awake.
This is what makes the daily mailbox-triage automation (and, once wired up,
the Court eFiling watcher) fully headless.

It speaks the Model Context Protocol (MCP) over HTTP, and internally talks
to Clio's real REST API (v4), refreshing its own access token automatically
using a long-lived refresh token.

It also runs its own small OAuth 2.1 authorization server (with PKCE and
dynamic client registration) — this is required because MCP clients like
Cowork expect a remote HTTP MCP server to have a real "sign-in" flow, not
just a static header. `BRIDGE_API_KEY` does double duty: it's the password
you type once when Cowork prompts you to connect, and the signing secret
for the tokens this server issues after that.

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

Once deployed, register `https://<your-url>/mcp` as a remote HTTP-type MCP
server:

```json
{
  "mcpServers": {
    "clio-bridge": {
      "type": "http",
      "url": "https://<your-url>/mcp"
    }
  }
}
```

No `headers` needed — when Cowork tries to connect, it will discover this
server's OAuth endpoints automatically, register itself, and open a small
page asking for the **Bridge Access Key** (the `BRIDGE_API_KEY` value).
Enter it once; Cowork stores and refreshes the resulting token on its own
from then on.

## Tools it exposes

- `clio_search_matters(query, status?)` — find a matter by client name,
  description, or case number.
- `clio_get_matter(matterId)` — fetch one matter's details.
- `clio_create_task(matterId, name, description?, assigneeId, priority?, dueAt?)`
  — create a Clio task.
- `clio_list_tasks(matterId, status?)` — list a matter's existing tasks, so
  an automation can check for duplicates before creating a new one.
- `clio_update_task(taskId, name?, description?, priority?, dueAt?, status?)` —
  update an existing task instead of creating a duplicate.
- `clio_update_matter(matterId, description?, status?, customFields?)` — update
  a matter's description, status (open/pending/closed — supports the
  closed-matter reopen rule), and/or named custom fields (e.g. "Case Number",
  "Hearing Date on Petition").
- `clio_list_recent_tasks(status?, updatedSince?, assigneeId?, nameContains?)`
  — list tasks firm-wide (across all matters), e.g. completions since the last
  run, or outstanding "CLAUDE:" work orders. Built for the hourly
  completed-task-review automation.
- `clio_list_documents(matterId, nameContains?)` — list a matter's existing
  documents, so an automation can check for duplicates before uploading.
- `clio_upload_document(matterId, fileName, contentBase64? | sourceUrl, receivedAt?, expectedBytes?)`
  — upload a file into the matter's Documents tab. Small files can be sent
  inline as base64; anything larger should be passed as an https `sourceUrl`
  (e.g. a time-limited pre-authenticated download URL) that this server
  fetches directly. Runs Clio's documented three-step upload (create record →
  PUT to presigned bucket URL → mark `fully_uploaded`). Pass `expectedBytes`
  (the file's true size) with any `contentBase64` upload: base64 payloads
  can corrupt in transit through a model context, and this makes the bridge
  reject a corrupted payload *before* anything reaches Clio (added v0.4.0
  after a corrupt docx landed on a matter looking `fully_uploaded: true`).
- `clio_create_time_entry(matterId, date, hours, description, nonBillable?, userId?)`
  — create a real Clio time entry (Activity/TimeEntry). Hours are decimal
  (0.1 = 6 min) and converted to seconds for Clio. Defaults to
  `nonBillable: true` per the firm rule — time is always *captured*, but only
  conservatorship matters bill hourly.
- `clio_search_contacts(query, type?)` — find a contact by name, email, or
  phone number (digits-only phone search works well for caller-ID matching).
- `clio_create_contact(type, …)` — create a Person or Company contact with
  title, company link, phone, email, and mailing address. Search first;
  fill every field findable (CHECK-ALL-SOURCES rule).
- `clio_update_contact(contactId, …)` — cure a thin contact record (add
  title, firm, phone, email, address).
- `clio_log_communication(matterId, type?, subject, body, date, sender…/receiver…)`
  — record a phone call (or email) in the matter's Communications tab with
  proper participants. This is the correct Clio home for call logs; pair
  with `clio_create_time_entry`, and attach full transcripts as documents.
- `clio_delete_document(documentId)` — move a document to Clio's trash, for
  corrupt uploads and superseded drafts per the superseded-document deletion
  rule. Never for filed/endorsed/signed/evidentiary documents.

### Added in v0.5.0 (8/2/2026)

- `clio_delete_task(taskId)` — permanently delete a stale task (clio-task-discipline rule).
- `clio_relate_contact(matterId, contactId, description)` — create a labeled
  related-contact relationship on a matter (implements the RELATED CONTACT ON
  DISCOVERY rule from headless sessions; previously Clio-UI-only).
- `clio_list_relationships(matterId)` — list a matter's related contacts, for dedup.
- `clio_list_activities(matterId, date?)` — list time entries on a matter, for
  dedup before creating entries.
- `clio_delete_activity(activityId)` — delete a duplicate/erroneous automation-created
  time entry (verify with `clio_list_activities` first).
- `clio_update_task` now accepts `status` (pending/in_progress/in_review/complete) —
  tasks can be completed from headless sessions.
- `clio_update_matter` custom-field writes now update-in-place (fixes the 422 on
  fields that already hold a value, by including the existing value id).
- `clio_get_matter` now returns practice area and custom field values (headless
  sessions can READ custom fields).

## Which automations this covers, and how much

- **Daily mailbox triage** — task creation + matter lookups (Part 3 of that
  trigger's prompt). Fully covered, migrated 7/23.
- **Daily court docket review** — the two Clio writes (setting the "Hearing
  Date on Petition" custom field, and creating an urgent task for new
  filings, with a duplicate-check via `clio_list_tasks`) are fully covered.
  Checking the actual court website (San Bernardino Superior Court) still
  needs a browser — courts don't have APIs — so this trigger keeps Chrome
  for that part regardless.
- **Court eFiling watcher** (hourly + late-afternoon runs) — only the
  "Case Number" custom-field update is covered. The larger part of this
  trigger — downloading rejected PDFs, embedding signature images from
  other filed documents, and re-uploading corrected forms — is real
  document manipulation this bridge doesn't do, and rebuilding that
  blind (against actual signed court filings) wasn't worth the risk.
  This trigger keeps its Chrome/CSRF recipe for everything except the
  case-number write.
- **Weekly security audit** — not applicable; it never writes to Clio.
- **Copier-scan/signature monitor** — as of v0.2.0 (7/23/26), the bridge can
  file scanned documents into a matter's Documents tab via
  `clio_upload_document` (with a `clio_list_documents` duplicate check
  first), closing the gap that previously forced "manual upload needed"
  alerts. Note the practical constraint: an automation session can't
  realistically inline multi-megabyte files as base64 in a tool call, so
  for full scans it should pass a pre-authenticated download URL as
  `sourceUrl` and let the bridge fetch the bytes itself.

## Local testing

```
cp .env.example .env   # fill in real values
npm install
npm start
curl http://localhost:3000/healthz
```
