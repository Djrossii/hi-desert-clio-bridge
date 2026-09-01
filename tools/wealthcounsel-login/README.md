# WealthCounsel login — physical-click autofill workaround

A small macOS program that logs the Mac mini's Chrome into
`member.wealthcounsel.com` by posting **real, OS-level mouse clicks and key
taps** (CoreGraphics `CGEvent`s through the HID event tap). To Chrome these
are indistinguishable from a human at the physical mouse — which is the
whole point.

## Why this exists (the autofill nullification problem)

Chrome deliberately hides autofilled credentials from page JavaScript. On
the login form the password field *displays* dots, but `field.value` reads
as an empty string until the page receives a genuine user gesture. Verified
live on the WealthCounsel form 8/6/2026: `pwValueLen 0`. So the login `.js`
bookmarklet approach is structurally dead for automation:

1. There is nothing for a script to read and re-dispatch — the value is
   nulled until a real gesture happens.
2. The script's `alert()` guard freezes the Claude-in-Chrome extension.
3. The extension's safety filter blocks returning anything that looks like
   credential/cookie data anyway.

This program sidesteps all three by never touching the page from the inside.
It performs the firm's plain-click procedure mechanically:

1. Finds (or opens) a tab on the clean `/login` URL; if the site is already
   authenticated (no login form), it exits 0 immediately.
2. Physically clicks the username field. That one real gesture makes Chrome
   commit its autofill preview into real values. If the click opens the
   saved-credentials dropdown instead, it selects the first entry with real
   Down-arrow + Return key taps.
3. Physically clicks the **Log In** button (falls back to a real Return
   keystroke in the password field if no button is recognized).
4. If a 2FA screen appears, it clicks the code field so Apple Passwords can
   autofill the code, then clicks Verify. If the code does not autofill it
   **stops** — codes are never relayed by hand.
5. Confirms the page left the login form before reporting success.

The only in-page JavaScript it runs is a read-only probe returning element
**geometry, the URL, and filled/empty booleans**. No credential value is
ever read, typed, stored, logged, or returned. Autofill does the filling;
this program only supplies the gestures Chrome insists on. It contains no
`alert()` and runs outside the browser extension, so none of the three
failure modes above apply.

## One-time setup on the Mac mini

1. **Chrome:** menu **View → Developer → Allow JavaScript from Apple
   Events** (needed for the read-only geometry probe).
2. **System Settings → Privacy & Security → Accessibility:** enable the app
   that will run the script (Terminal, or the launchd/automation runner).
   This is what authorizes posting CGEvents.
3. **System Settings → Privacy & Security → Automation:** the same runner
   must be allowed to control **Google Chrome** (macOS prompts on first
   run — click OK).
4. The WealthCounsel credential must already be saved for autofill (Chrome
   password manager or Apple Passwords with its Chrome extension), per the
   firm's credential-handling playbook.

Verify the setup without clicking anything:

```bash
./wc-login.sh --dry-run
```

It reports whether it found the username field, password field, submit
button, and whether autofill has values staged.

## Usage

```bash
./wc-login.sh                 # log in to member.wealthcounsel.com
./wc-login.sh --dry-run       # probe only, no clicks
./wc-login.sh https://...     # same procedure for another login-first site
```

The page-shape probe is generic (any form with a password field, a
username/email field, and a Log In/Sign In button), so the same tool works
against the firm's other login-first sites when pointed at their sign-in
URL.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Logged in, or already authenticated |
| 2 | Setup problem (Apple-Events JS off, unrecognized page shape, odd zoom) |
| 3 | Chrome autofill did not populate the credentials — check the saved password; the tool does **not** guess or hammer retries (lockout risk) |
| 4 | 2FA field present but Apple Passwords did not autofill the code |
| 5 | Submitted but the site still shows the login form — stopped (lockout risk) |
| 6 | Timed out waiting for the page to load |
| 64 | Not macOS (this must run on the Mac mini) |

## Notes and boundaries

- **Screen state:** because the clicks are physical, the Mac mini's screen
  must be unlocked and nobody should be moving the mouse while it runs.
  Multi-display and non-100% page zoom are handled (geometry is scaled by
  the measured zoom factor), but Cmd+0 zoom is the well-tested path.
- **Claude sessions are unchanged:** interactive Claude-in-Chrome sessions
  keep using the plain-click procedure in the WealthCounsel login-first
  playbook. This program is the same procedure packaged for the Mac mini
  itself (hand-run or scheduled), where no extension is in the loop.
- **Failure posture:** per the credential-handling rule, a login that still
  fails after autofill is a stop-and-report, never a retry-with-variations.
- This tool signs in only. It never files, submits, or transmits anything
  to a court.
