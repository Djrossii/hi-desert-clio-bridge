# Thomson Reuters login — OnePass sign-in without the extension

Signs the Mac mini's Chrome into **Westlaw** and **CoCounsel** by posting
real, OS-level mouse clicks and key taps (CoreGraphics `CGEvent`s through
the HID event tap). Third member of the physical-click family, after
`../wealthcounsel-login/` and `../infotrack-reconnect/` — same engine,
aimed at Thomson Reuters OnePass.

## Why this exists

The Claude-in-Chrome extension has **no site permission on
`auth.thomsonreuters.com`**, the OnePass host both Westlaw and CoCounsel
sign in through. Re-tested live by Don Ross on **9/11/2026**:
`1.next.westlaw.com` redirected to OnePass (session expired) and both
`get_page_text` and `screenshot` returned *"Permission denied by user"*.
This is the same wall recorded on 8/6/2026 in the westlaw-login-first
playbook, still standing five weeks later.

The extension cannot screenshot the form, so it cannot see it; it cannot
see it, so it cannot plain-click it. The documented procedure dead-ends.

**Later on 9/11 the reason surfaced.** With the session signed out, a
Claude-in-Chrome session sent to do research landed on the OnePass page
and the extension raised its per-action prompt — *"Claude wants to read
page content on: auth.thomsonreuters.com — Allow this action / Decline"*
— carrying the line **"Site-level permissions are disabled for this
site."** So the permission everyone spent the morning trying to grant is
not grantable: on this host the extension asks a human for every single
action. "Permission denied by user" is what that prompt becomes when no
one is there to click Allow. The extension path through OnePass is
human-in-the-loop by construction and cannot be made autonomous.

**This program does not need that permission.** It drives Chrome from
outside the browser entirely — the extension is not in the loop, so its
site permissions are irrelevant to it. Signing in is therefore solved
unattended.

**Reading is not, yet.** Minutes later, with the session signed in by
this tool, the same extension session prompted again — *"Claude wants to
read page content on: cocounsel.thomsonreuters.com"* — with the same
line: **"Site-level permissions are disabled for this site."** So
per-action approval is not confined to the auth host; it applies to the
CoCounsel host too (not yet seen on Westlaw). Whether that is a category
rule inside the extension or a setting that can be changed is a question
for the extension's own settings page, which the dialog points to and
which had not yet been opened when this was written. Until it is
answered, the extension can read a Thomson Reuters page only with a human
clicking Allow for each action.

Two things were considered and rejected the same day, and are recorded
here so they are not proposed again: an auto-approver that clicks Allow
on the extension's prompt for named hosts, and a reader that pulls the
signed-in page's text over the Apple-Events channel this tool's probe
uses. Both have the same effect — the AI reads Thomson Reuters content
with no human saying yes — through a different door. The extension's rule
is about that effect, not the door. The reader is also automated retrieval
from Thomson Reuters web properties, which their terms restrict; their
sanctioned programmatic path is the CoCounsel MCP.

**Where the real gap is.** Tested from the authoring session on 9/11
(chat `01a09265-9287-7d88-8001-a40e9526f5e4`, a non-client question):
`ask_cocounsel` returned only `backendUrl` and `runInProgress: false` — no
answer, no `artifact_id`, no `version`. The server exposes no other tool
for outputs; its only resources are two MCP Apps
(`ui://cocounsel/ask.html`, `ui://cocounsel/upload.html`) whose CSP
connects to `cocoagent-service.cocounsel.thomsonreuters.com`. The answer
is delivered to that client-rendered widget, and `get_cocounsel_output`
needs ids that only the widget surfaces. A session that does not render
MCP Apps — this one, any headless or scheduled run — can start research
and can never receive it. That is the 9/7 failure's mechanism. It is the
vendor's to fix: an output-listing tool, or ids in the ask response.
Until then, capture is an attended step — a client that renders the
widget, or a person at the chat URL — and this tool's job is to make sure
the sign-in is never what stops them.

## What the permission does and does not fix

Two corrections to the 9/11 read, both from the canonical playbooks:

- **Westlaw** — the permission gap is real and is the blocker. Confirmed.
- **CoCounsel MCP output** — the host to reach is
  **`cocounsel.thomsonreuters.com/cocoagent/chat/{chat_id}`**, the page,
  not `cocoagent-service.cocounsel.thomsonreuters.com`, which is the
  backend service the page calls. Site permission on the service host
  does not make research readable. Per cocounsel-login-first (amended
  9/7/2026), MCP-created chats never appear in History and are reachable
  **only** at that `/cocoagent/chat/` URL.
- **The 9/7 failure was not this.** Its recorded root cause is an
  unrecorded `chat_id` — with History not listing MCP chats, a chat whose
  id was never captured cannot be found by anyone — compounded by
  `get_cocounsel_output` often having no results view pushed to it. A
  permission grant would not have saved those four runs. Recording the
  `chat_id` the moment `start_cocounsel_chat` returns is what does
  (research-must-be-findable).

## Why the WealthCounsel tool is not enough

`wc-login.sh` takes an arbitrary URL, and its README says the page-shape
probe is generic. That generalization does **not** reach OnePass, for two
structural reasons:

1. **OnePass is a two-step form.** Step 1 is username + *Sign in*, with
   no password field on the page at all; the password step renders only
   after that. Live-verified 9/11/2026 on the identifier step:
   `user=true pass=false otp=false btn=true ('Sign in')`. A single-shot
   "find the password field, submit it" pass never sees step 1 —
   `wc-login.sh` stops there with exit 2, *"found no password field"*.
2. **Its "already authenticated?" test is a `/login` path marker.** That
   happens to hold on the identifier step (`/u/login/identifier`), which
   is why the failure above is a loud stop rather than a silent one. It
   need not hold on OnePass's later screens: the `/u/login/identifier`
   path and `state=` token mark this as Auth0 Universal Login, whose MFA
   challenge is not served under `/login` (not yet observed live on this
   account). A step there whose code field the probe did not recognize
   would be reported as *"already authenticated"*, exit 0 — a silent
   false success.

Classifier comparison — the identifier row from the live URL, the rest
from representative shapes:

| Page in front of the tool | `wc-login.sh` | `tr-login.sh` |
|---|---|---|
| OnePass step 1 (username) — live | exit 2, cannot proceed | `username` |
| OnePass step 2 (password) | proceeds | `password` |
| OnePass 2FA | proceeds | `otp` |
| Westlaw, signed in | authenticated, exit 0 | `authenticated` |
| CoCounsel MCP chat page | authenticated, exit 0 | `authenticated` |
| OnePass MFA, code field unrecognized | **authenticated, exit 0** | `auth-unknown` (exit 2) |

This program decides "signed in" by **host** instead: a tab still on a
Thomson Reuters auth host is mid-sign-in, whatever its path says.

## What it does

A bounded step machine (up to 8 screens) that handles whichever OnePass
step is in front of it, then waits for that step to give way before
looking again:

1. **Username step** — physically clicks the field. That one real gesture
   makes Chrome commit its autofill preview into real values; if the click
   opens the saved-credentials dropdown instead, it selects the first entry
   with real Down-arrow + Return taps. Then clicks **Sign in** (that is the
   identifier step's label on this site, not *Continue*).
2. **Password step** — same gesture, then **Sign in**.
3. **2FA screen** — clicks the code field so Apple Passwords can autofill,
   then Verify. If the code does not autofill it **stops**; codes are never
   relayed by hand.
4. **Done** — exits 0 once the tab is off the auth host.

A step that does not advance within 20s is a **stop**, never a re-submit:
repeated submits are how accounts get locked out.

The only in-page JavaScript is a read-only probe returning element
**geometry, the URL, a button's visible label, and filled/empty
booleans**. No credential value is ever read, typed, stored, logged, or
returned. Autofill does the filling; this program supplies only the
gestures Chrome insists on.

## One-time setup on the Mac mini

Identical to the WealthCounsel tool — already done if that one runs. See
`../wealthcounsel-login/README.md`: Chrome **View → Developer → Allow
JavaScript from Apple Events**; **Accessibility** and **Automation**
permission for whatever runs it; the OnePass credential saved for autofill
per the credential-handling playbook.

Verify without clicking anything:

```bash
./tr-login.sh --dry-run
```

It reports which OnePass step it sees and whether autofill has values
staged.

### Live dry-run, 9/11/2026

Run by Don Ross on the Mac mini — the tool's first run there, with no
setup beyond what the WealthCounsel tool already needed:

```
[tr-login] Opening new tab: https://1.next.westlaw.com/
[tr-login] Page: https://auth.thomsonreuters.com/u/login/identifier?state=…&ui_locales=en
[tr-login] DRY RUN - step looks like: username
[tr-login] DRY RUN - found: user=true pass=false otp=false btn=true ('Sign in') | autofilled: user=false pass=false
[tr-login] DRY RUN - no clicks performed.
```

What it establishes: Apple-Events JavaScript is on; the Westlaw entry URL
bounces to the OnePass identifier step; that step has no password field;
the probe finds the username field and the *Sign in* button. What it does
not establish: whether Chrome offers the saved OnePass credential on a
click (`autofilled: user=false` at page load is normal — Chrome commits
on a gesture), and whether Accessibility trust is granted. The real run
checks both and stops with a named fix if either is missing.

### Live real runs, 9/11/2026

Three real runs, same machine, same afternoon, each after a `git pull`:

1. **Exit 3** on the first gesture sequence — Chrome offered nothing on
   the click. Don Ross then signed in by hand, in the same profile, using
   the credential Chrome offered *him*. So the credential was never the
   problem.
2. **Exit 3** again, now logging the window: `in window 1 of 1` — one
   window, one profile. The gesture itself was wrong: Down and Return
   were fired 150 ms apart, so Return submitted the empty form before
   Chrome's suggestion list had drawn, and a second click was closing the
   list the first had opened.
3. **`OK: signed in`** on the paced sequence — click, 1.0 s; Down, 0.7 s;
   Return, 0.8 s — as reported by Don Ross. Westlaw loaded.

## Usage

```bash
./tr-login.sh                 # Westlaw, via https://1.next.westlaw.com/
./tr-login.sh --cocounsel     # CoCounsel (same OnePass identity)
./tr-login.sh --dry-run       # probe only, no clicks
./tr-login.sh https://...     # another entry URL
```

Always the clean entry URL, never a saved signon URL — one-time trace
tokens go stale (westlaw-login-first, cocounsel-login-first).

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Signed in, or already authenticated |
| 2 | Setup problem (Apple-Events JS off, Accessibility not granted, unrecognized OnePass page shape, odd zoom) — the message names which |
| 3 | Chrome autofill did not populate the credential — check the saved password; the tool does **not** guess or hammer retries (lockout risk) |
| 4 | 2FA field present but Apple Passwords did not autofill the code |
| 5 | Submitted but OnePass still shows a sign-in step — stopped (lockout risk) |
| 6 | Timed out waiting for the page to load |
| 64 | Not macOS (this must run on the Mac mini) |

## Notes and boundaries

- **Screen state:** the clicks are physical, so the Mac mini must be
  unlocked and nobody should be moving the mouse while it runs.
  Multi-display and non-100% zoom are handled (geometry is scaled by the
  measured zoom factor); Cmd+0 is the well-tested path.
- **Sessions expire silently.** Re-check at the start of each burst of
  work, not once per session. Exit 0 is cheap when already authenticated.
- **CoCounsel research still runs on the MCP.** This tool is for reading
  and for browser work; it does not change where queries are run, and it
  does not excuse failing to record the `chat_id`.
- **Run this first, every burst.** Same pattern as `wc-login.sh` (Method
  A in the WealthCounsel playbook): a session that will touch Westlaw or
  CoCounsel runs `tr-login.sh` before any browser work and proceeds only
  on exit 0. Exit 0 is cheap when already signed in. The extension's
  plain-click procedure on OnePass is the fallback, and it needs Don Ross
  at the keyboard to click *Allow this action* on every step.
- **Cancel any Claude-in-Chrome action before running this.** The tool
  reuses whatever tab is already on the OnePass host — which, when a
  browser session has just hit the wall, is that session's own tab. Two
  drivers on one tab is a coin toss.
- This tool signs in only. It never files, submits, or transmits anything
  to a court, and never fabricates a citation or a result.
