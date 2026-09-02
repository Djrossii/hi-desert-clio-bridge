# InfoTrack reconnect — physical-click OAuth workaround

Completes the **InfoTrack ↔ Clio reconnect** (the "InfoTrack: File, Serve
and Sync" tab showing *"Please click the button to reconnect and continue"*)
by driving Chrome with **real OS-level mouse clicks and key taps** on the
Mac mini. Sibling of the WealthCounsel login tool in
`../wealthcounsel-login/` — same engine, aimed at a different blocker.

## Why this exists

When the integration lapses, the Connect button in the Clio matter's
InfoTrack pane opens a separate **authorization popup window**. Two things
make that popup un-automatable from inside the browser:

1. Browser-extension automation (Claude-in-Chrome) cannot see or drive a
   popup window it didn't open — the session goes blind the moment Connect
   is clicked.
2. The sign-in form inside the popup is subject to Chrome's autofill
   nullification: the credentials only become real, submittable values
   after a genuine user gesture.

This program sidesteps both. AppleScript enumerates **every** Chrome window
— popups included — and CoreGraphics CGEvents deliver clicks the OS treats
as a human on the physical mouse.

## What it does

A watch-and-act loop (up to ~3 minutes) that handles whichever screen is
in front of it:

1. **Reconnect pane** (Clio matter tab): physically clicks the Connect
   button. If the button lives inside InfoTrack's cross-origin iframe
   (where the read-only probe can't see it), it tries a ladder of likely
   positions — upper-center first, working outward — one every ~8 seconds
   until the popup appears. Then waits for the popup. Any brand-new Chrome
   window that appears mid-run is treated as the auth popup regardless of
   URL, so clicking Connect by hand while the tool runs also works.
2. **Sign-in form**: real click on the username field commits Chrome's
   autofill (Down+Return fallback for the saved-credentials dropdown),
   then clicks Log In. Never types or reads a credential — autofill does
   the filling, this supplies only the gestures.
3. **2FA screen**: clicks the code field so Apple Passwords autofills,
   clicks Verify. If the code doesn't autofill it **stops** — codes are
   never relayed by hand.
4. **Consent screen**: clicks Authorize / Allow / Approve / Connect.
5. **Success**: the auth page shows success text (popup is closed for you)
   or the popup closes itself. The Clio InfoTrack tab is then reloaded so
   the pane shows connected.

The only in-page JavaScript is a read-only probe returning geometry, the
URL, and filled/empty booleans.

## Setup

Identical to the WealthCounsel tool (already done if that one runs):
Chrome **View → Developer → Allow JavaScript from Apple Events**;
**Accessibility** + **Automation** permission for Terminal (or whatever
runs it). See `../wealthcounsel-login/README.md`.

## Usage

Open the matter in Clio and select its **InfoTrack: File, Serve and Sync**
tab (or leave the auth popup open if one is already up), then:

```bash
./it-reconnect.sh              # do the reconnect
./it-reconnect.sh --dry-run    # report what it sees, no clicks
```

Screen unlocked, hands off the mouse while it runs. When it prints
`OK: InfoTrack reconnect flow complete`, the blocked session can re-stage
the eFiling envelope.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Reconnected (or the auth popup finished and closed) |
| 2 | Setup problem (Apple-Events JS off, odd zoom) |
| 3 | Chrome autofill did not populate the InfoTrack sign-in — check the saved credential; no retries (lockout risk) |
| 4 | 2FA field present but Apple Passwords did not autofill the code |
| 5 | Sign-in kept looping back to the login form — stopped (lockout risk) |
| 6 | Nothing to act on (open the matter's InfoTrack tab first) or timed out |
| 64 | Not macOS (must run on the Mac mini) |

## Boundaries

- Reconnects the integration only. It never stages, submits, or files
  anything — eFiling staging stays with the session, and **Submit stays
  with Don Ross**.
- Stop-and-report on failure; no credential guessing, no retry hammering.
- The InfoTrack credential must be saved for autofill (Chrome password
  manager / Apple Passwords), per the credential-handling playbook.
