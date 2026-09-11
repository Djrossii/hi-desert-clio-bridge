#!/usr/bin/env osascript -l JavaScript
// tr-onepass-login.js
//
// Thomson Reuters (Westlaw / CoCounsel) sign-in via PHYSICAL clicks.
//
// Sibling of ../wealthcounsel-login/wc-autofill-login.js and
// ../infotrack-reconnect/it-reconnect.js - same CGEvent engine, aimed at
// OnePass, which the WealthCounsel tool structurally cannot drive (see
// README.md, "Why the WealthCounsel tool is not enough").
//
// Two things make this its own program:
//
//   1. OnePass is a MULTI-STEP form. Step 1 is username + Continue, with no
//      password field on the page at all; the password step renders only
//      after Continue. A single-shot "find the password field and submit"
//      pass never sees step 1.
//   2. "Already authenticated?" cannot be decided by a "/login" path
//      marker - OnePass sign-in URLs on auth.thomsonreuters.com carry no
//      such segment. This program decides it by HOST instead: if the tab
//      is still on a Thomson Reuters auth host, it is not signed in,
//      whatever the path says.
//
// Because this runs OUTSIDE the browser as OS-level input, the
// Claude-in-Chrome extension's missing site permission on
// auth.thomsonreuters.com does not apply to it.
//
// The program never reads, stores, types, or transmits a credential. Only
// element geometry, the URL, a button's visible label, and filled/empty
// booleans ever cross out of the page. Autofill does the filling; this
// supplies the gestures Chrome insists on.
//
// Usage:   osascript -l JavaScript tr-onepass-login.js [--dry-run] [url]
//          (or use the tr-login.sh wrapper)
//
// Exit codes:
//   0  signed in (or already authenticated)
//   2  setup problem (Chrome JS-from-Apple-Events off, page shape unknown)
//   3  Chrome autofill did not populate a credential field
//   4  2FA code field present but Apple Passwords did not autofill it
//   5  submitted but OnePass still showing a sign-in step - stopped
//   6  timeout waiting for Chrome / page load
//
// Requirements (one-time setup on the Mac mini - see README.md):
//   * Chrome: View > Developer > Allow JavaScript from Apple Events
//   * System Settings > Privacy & Security > Accessibility: allow the
//     terminal (or launchd runner) that invokes this script
//   * System Settings > Privacy & Security > Automation: same runner may
//     control Google Chrome

"use strict";

ObjC.import("CoreGraphics");
ObjC.import("stdlib");

// ---------------------------------------------------------------- constants

// Per westlaw-login-first: enter via the clean entry URL, never a saved
// signon URL (one-time trace tokens go stale). Westlaw is the default;
// CoCounsel shares the same OnePass identity.
var DEFAULT_URL = "https://1.next.westlaw.com/";

// A tab sitting on any of these is mid-sign-in, never "authenticated".
var AUTH_HOST_MARKERS = [
  "auth.thomsonreuters.com",
  "signon.thomsonreuters.com",
  "onepass.thomsonreuters.com"
];

// Tabs on any of these are ours to reuse rather than opening another.
var OWNED_HOST_MARKERS = AUTH_HOST_MARKERS.concat([
  "next.westlaw.com",
  "cocounsel.thomsonreuters.com"
]);

var MAX_STEPS = 8;          // username, password, 2FA, redirects, slack
var CHANGE_TIMEOUT_SEC = 20; // how long a step gets to advance

// CGEvent numeric constants (the ObjC bridge does not export these enums)
var LEFT_MOUSE_DOWN = 1;
var LEFT_MOUSE_UP = 2;
var MOUSE_MOVED = 5;
var MOUSE_BUTTON_LEFT = 0;
var HID_EVENT_TAP = 0;
var KEY_RETURN = 36;
var KEY_DOWN_ARROW = 125;

// ------------------------------------------------------------------ logging

function log(msg) {
  console.log("[tr-login] " + msg);
}

function fail(code, msg) {
  console.log("[tr-login] FAIL: " + msg);
  $.exit(code);
}

// --------------------------------------------------------- physical events

function postMouse(type, x, y) {
  var ev = $.CGEventCreateMouseEvent($(), type, { x: x, y: y }, MOUSE_BUTTON_LEFT);
  $.CGEventPost(HID_EVENT_TAP, ev);
}

function physicalClick(pt) {
  postMouse(MOUSE_MOVED, pt.x, pt.y);
  delay(0.15);
  postMouse(LEFT_MOUSE_DOWN, pt.x, pt.y);
  delay(0.06);
  postMouse(LEFT_MOUSE_UP, pt.x, pt.y);
  delay(0.2);
}

function keyTap(keyCode) {
  var down = $.CGEventCreateKeyboardEvent($(), keyCode, true);
  var up = $.CGEventCreateKeyboardEvent($(), keyCode, false);
  $.CGEventPost(HID_EVENT_TAP, down);
  delay(0.04);
  $.CGEventPost(HID_EVENT_TAP, up);
  delay(0.15);
}

// ------------------------------------------------------------ chrome logic

function getChrome() {
  var chrome = Application("Google Chrome");
  chrome.includeStandardAdditions = true;
  if (!chrome.running()) {
    log("Chrome is not running - launching it");
    chrome.activate();
    var waited = 0;
    while (!chrome.running() && waited < 20) { delay(0.5); waited += 0.5; }
    delay(1.5);
  }
  return chrome;
}

function matchesAny(url, markers) {
  for (var i = 0; i < markers.length; i++) {
    if (url.indexOf(markers[i]) !== -1) return true;
  }
  return false;
}

// Find an existing tab on the target host OR anywhere in the OnePass /
// Westlaw / CoCounsel family - a tab that has already bounced to the auth
// host is the tab we want, not a reason to open a second one.
function findOrOpenTab(chrome, url, markers) {
  var wins = chrome.windows();
  for (var wi = 0; wi < wins.length; wi++) {
    var tabs;
    try { tabs = wins[wi].tabs(); } catch (e) { continue; }
    for (var ti = 0; ti < tabs.length; ti++) {
      var u = "";
      try { u = tabs[ti].url() || ""; } catch (e) { u = ""; }
      if (u && matchesAny(u, markers)) {
        log("Reusing existing tab: " + u);
        return { win: wins[wi], tabIndex: ti + 1 };
      }
    }
  }
  log("Opening new tab: " + url);
  var win;
  if (wins.length === 0) {
    chrome.windows.push(chrome.Window());
    delay(0.5);
    win = chrome.windows[0];
    win.tabs[0].url = url;
    return { win: win, tabIndex: 1 };
  }
  win = chrome.windows[0];
  win.tabs.push(chrome.Tab({ url: url }));
  return { win: win, tabIndex: win.tabs.length };
}

function tabOf(handle) {
  return handle.win.tabs[handle.tabIndex - 1];
}

function focusTab(chrome, handle) {
  handle.win.activeTabIndex = handle.tabIndex;
  handle.win.index = 1;
  chrome.activate();
  delay(0.6);
}

function waitLoaded(handle, timeoutSec) {
  var waited = 0;
  while (waited < timeoutSec) {
    var loading = true;
    try { loading = tabOf(handle).loading(); } catch (e) { loading = true; }
    if (!loading) { delay(0.6); return true; }
    delay(0.25);
    waited += 0.25;
  }
  return false;
}

// -------------------------------------------------------------- page probe
//
// Runs inside the page via Apple Events. Returns ONLY geometry, the URL, a
// button's visible label, and filled/empty booleans - never a field's
// contents.

var PROBE_JS = "(function () {\n" +
  "  function rect(el) {\n" +
  "    if (!el) return null;\n" +
  "    var r = el.getBoundingClientRect();\n" +
  "    if (!r.width || !r.height) return null;\n" +
  "    return { x: r.left, y: r.top, w: r.width, h: r.height };\n" +
  "  }\n" +
  "  function visible(el) {\n" +
  "    return !!(el && el.offsetParent !== null && !el.disabled);\n" +
  "  }\n" +
  "  var pass = document.querySelector('input[type=password]');\n" +
  "  if (!visible(pass)) pass = null;\n" +
  "  var otp = document.querySelector(\n" +
  "    'input[autocomplete=one-time-code], input[name*=\"code\" i]:not([type=hidden]), input[id*=\"code\" i]:not([type=hidden])');\n" +
  "  if (otp && otp.type === 'password') otp = null;\n" +
  "  if (!visible(otp)) otp = null;\n" +
  "  var anchor = pass || otp;\n" +
  "  if (anchor) anchor.scrollIntoView({ block: 'center' });\n" +
  "  var scope = anchor ? (anchor.form || document) : document;\n" +
  "  var user = null;\n" +
  "  var cands = scope.querySelectorAll(\n" +
  "    'input[autocomplete=username], input[type=email], input[name*=\"user\" i], input[name*=\"email\" i], input[type=text]');\n" +
  "  for (var u = 0; u < cands.length; u++) {\n" +
  "    if (cands[u] !== otp && visible(cands[u])) { user = cands[u]; break; }\n" +
  "  }\n" +
  "  if (!anchor && user) user.scrollIntoView({ block: 'center' });\n" +
  "  var btn = null;\n" +
  "  var btns = scope.querySelectorAll('button, input[type=submit]');\n" +
  "  var vis = [];\n" +
  "  for (var i = 0; i < btns.length; i++) {\n" +
  "    if (visible(btns[i])) vis.push(btns[i]);\n" +
  "  }\n" +
  "  for (var j = 0; j < vis.length; j++) {\n" +
  "    var t = (vis[j].innerText || vis[j].value || '').trim();\n" +
  "    if (/log\\s*in|sign\\s*in|continue|next|submit|verify/i.test(t)) { btn = vis[j]; break; }\n" +
  "  }\n" +
  "  if (!btn && vis.length === 1) btn = vis[0];\n" +
  "  return JSON.stringify({\n" +
  "    href: location.href,\n" +
  "    metrics: { sx: window.screenX, sy: window.screenY,\n" +
  "               iw: window.innerWidth, ih: window.innerHeight,\n" +
  "               ow: window.outerWidth, oh: window.outerHeight },\n" +
  "    hasPass: !!pass, hasOtp: !!otp,\n" +
  "    btnText: btn ? (btn.innerText || btn.value || '').trim().slice(0, 40) : '',\n" +
  "    userFilled: !!(user && user.value.length),\n" +
  "    passFilled: !!(pass && pass.value.length),\n" +
  "    otpFilled: !!(otp && otp.value.length),\n" +
  "    user: rect(user), pass: rect(pass), otp: rect(otp), btn: rect(btn)\n" +
  "  });\n" +
  "})();";

function probe(chrome, handle) {
  var raw;
  try {
    raw = chrome.execute(tabOf(handle), { javascript: PROBE_JS });
  } catch (e) {
    fail(2, "Chrome refused JavaScript via Apple Events. Enable it once: " +
            "Chrome menu View > Developer > Allow JavaScript from Apple Events. " +
            "(" + e.message + ")");
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(2, "Could not parse page probe result: " + raw);
  }
}

// Convert a page-CSS rect center to global screen points.
// Chrome on macOS has no side window borders, so the horizontal scale
// (outerWidth / innerWidth) is exactly the page zoom factor; all of the
// browser chrome (tab strip + toolbar) sits above the viewport.
function toScreen(m, r) {
  var zoom = m.ow / m.iw;
  if (!(zoom > 0.4 && zoom < 4.0)) {
    fail(2, "Implausible zoom factor " + zoom.toFixed(2) +
            " - reset Chrome page zoom to 100% (Cmd+0) and retry.");
  }
  var chromeHeight = m.oh - m.ih * zoom;
  return {
    x: m.sx + (r.x + r.w / 2) * zoom,
    y: m.sy + chromeHeight + (r.y + r.h / 2) * zoom
  };
}

// Physically click an element (by probe key), re-probing first so the
// geometry is fresh even if the page shifted.
function clickElement(chrome, handle, key) {
  var p = probe(chrome, handle);
  if (!p[key]) return null;
  var pt = toScreen(p.metrics, p[key]);
  log("Physical click on '" + key + "' at (" + Math.round(pt.x) + ", " + Math.round(pt.y) + ")");
  physicalClick(pt);
  return p;
}

// ------------------------------------------------------------ step machine

// Which OnePass step (if any) is on screen. Deliberately host-based for the
// "authenticated" verdict: a path marker like "/login" does not appear in
// OnePass URLs, so keying off one reports a false success on step 1.
function classify(p) {
  if (p.hasOtp) return "otp";
  if (p.hasPass) return "password";
  if (matchesAny(p.href, AUTH_HOST_MARKERS)) {
    if (p.user && p.btn) return "username";
    return "auth-unknown";
  }
  return "authenticated";
}

// Poll until the step or the URL changes - OnePass advances in-page as
// often as it navigates, so waitLoaded() alone returns far too early.
function waitForChange(chrome, handle, fromKind, fromHref) {
  var waited = 0;
  while (waited < CHANGE_TIMEOUT_SEC) {
    delay(0.5);
    waited += 0.5;
    var loading = true;
    try { loading = tabOf(handle).loading(); } catch (e) { loading = true; }
    if (loading) continue;
    var p = probe(chrome, handle);
    if (classify(p) !== fromKind || p.href !== fromHref) {
      delay(0.8); // let the new step settle before measuring geometry
      return probe(chrome, handle);
    }
  }
  return null;
}

// One real gesture on a field, escalating to the saved-credentials dropdown
// if Chrome staged an autofill preview instead of committing it.
// Returns the latest probe. Never reads the value - only the filled flag.
function commitAutofill(chrome, handle, fieldKey, filledKey) {
  clickElement(chrome, handle, fieldKey);
  delay(0.5);
  var p = probe(chrome, handle);
  if (p[filledKey]) return p;

  log("Autofill not committed yet - selecting from the dropdown");
  clickElement(chrome, handle, fieldKey);
  keyTap(KEY_DOWN_ARROW);
  keyTap(KEY_RETURN);
  delay(0.6);
  return probe(chrome, handle);
}

function submitStep(chrome, handle, fallbackFieldKey, p) {
  if (p.btn) {
    log("Submitting step via '" + (p.btnText || "button") + "'");
    clickElement(chrome, handle, "btn");
  } else {
    log("No submit button recognized - pressing Return in the field");
    clickElement(chrome, handle, fallbackFieldKey);
    keyTap(KEY_RETURN);
  }
}

// ---------------------------------------------------------------- the flow

function run(argv) {
  var dryRun = false;
  var url = DEFAULT_URL;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i].indexOf("http") === 0) url = argv[i];
  }
  var host = url.replace(/^https?:\/\//, "").split("/")[0];
  var markers = OWNED_HOST_MARKERS.indexOf(host) === -1
    ? OWNED_HOST_MARKERS.concat([host])
    : OWNED_HOST_MARKERS;

  var chrome = getChrome();
  var handle = findOrOpenTab(chrome, url, markers);
  if (!waitLoaded(handle, 30)) fail(6, "Page did not finish loading within 30s.");

  var p = probe(chrome, handle);
  log("Page: " + p.href);
  var kind = classify(p);

  if (dryRun) {
    log("DRY RUN - step looks like: " + kind);
    log("DRY RUN - found: user=" + !!p.user + " pass=" + !!p.pass +
        " otp=" + !!p.otp + " btn=" + !!p.btn +
        (p.btnText ? " ('" + p.btnText + "')" : "") +
        " | autofilled: user=" + p.userFilled + " pass=" + p.passFilled);
    log("DRY RUN - no clicks performed.");
    $.exit(0);
  }

  if (kind === "authenticated") {
    log("OK: already authenticated - no OnePass step present (" + p.href + ").");
    $.exit(0);
  }

  focusTab(chrome, handle);

  // Walk the steps OnePass puts in front of us. Each iteration handles
  // exactly one screen, then waits for it to change before looking again.
  for (var step = 0; step < MAX_STEPS; step++) {
    p = probe(chrome, handle);
    kind = classify(p);
    var href = p.href;
    log("Step " + (step + 1) + ": " + kind + " (" + href + ")");

    if (kind === "authenticated") {
      log("OK: signed in - now at " + href);
      $.exit(0);
    }

    if (kind === "auth-unknown") {
      fail(2, "On the OnePass host (" + href + ") but no username, password, " +
              "or code field is recognizable - page shape changed or is still " +
              "rendering. Re-run; if it persists the probe selectors need " +
              "updating.");
    }

    if (kind === "username") {
      p = commitAutofill(chrome, handle, "user", "userFilled");
      if (!p.userFilled) {
        fail(3, "Chrome autofill did not populate the OnePass username field. " +
                "Check that the Thomson Reuters credential is saved in Chrome / " +
                "Apple Passwords and that its autofill extension is on. " +
                "Not guessing or retrying further (lockout risk).");
      }
      log("Username committed by autofill.");
      submitStep(chrome, handle, "user", p);

    } else if (kind === "password") {
      p = commitAutofill(chrome, handle, "pass", "passFilled");
      if (!p.passFilled) {
        // One more gesture, this time starting from the username field -
        // some OnePass renders only offer the dropdown from there.
        if (p.user) {
          clickElement(chrome, handle, "user");
          keyTap(KEY_DOWN_ARROW);
          keyTap(KEY_RETURN);
          delay(0.6);
          p = probe(chrome, handle);
        }
      }
      if (!p.passFilled) {
        fail(3, "Chrome autofill did not populate the OnePass password field. " +
                "Check that the Thomson Reuters credential is saved in Chrome / " +
                "Apple Passwords and that its autofill extension is on. " +
                "Not guessing or retrying further (lockout risk).");
      }
      log("Password committed by autofill (never read by this program).");
      submitStep(chrome, handle, "pass", p);

    } else if (kind === "otp") {
      log("2FA code field present - giving Apple Passwords a gesture to fill it");
      p = commitAutofill(chrome, handle, "otp", "otpFilled");
      if (!p.otpFilled) {
        fail(4, "2FA field did not autofill from Apple Passwords. Stopping - " +
                "codes are never relayed by hand. Check the Apple Passwords " +
                "Chrome extension on the Mac mini.");
      }
      submitStep(chrome, handle, "otp", p);
    }

    // Wait for this step to give way to the next one. If it never does,
    // stop rather than re-submitting - a repeated submit is how accounts
    // get locked out.
    waitLoaded(handle, 30);
    var next = waitForChange(chrome, handle, kind, href);
    if (!next) {
      fail(5, "Submitted the " + kind + " step but OnePass is still showing it " +
              "after " + CHANGE_TIMEOUT_SEC + "s (" + href + "). Stopping rather " +
              "than retrying (lockout risk) - sign in by hand and check whether " +
              "the saved credential is still valid.");
    }
  }

  fail(5, "Still on a OnePass sign-in step after " + MAX_STEPS + " steps. " +
          "Stopping rather than retrying (lockout risk).");
}
