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
//   1. OnePass is a MULTI-STEP form. Step 1 is username + Sign in, with no
//      password field on the page at all (live-verified 9/11/2026); the
//      password step renders only after that. A single-shot "find the
//      password field and submit" pass never sees step 1.
//   2. "Already authenticated?" should not be decided by a "/login" path
//      marker. The identifier step happens to carry one
//      (/u/login/identifier), but OnePass runs on Auth0 Universal Login,
//      whose later screens (MFA) need not - a step there with an
//      unrecognized field would read as "signed in". This program decides
//      by HOST instead: a tab still on a Thomson Reuters auth host is not
//      signed in, whatever the path says.
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
ObjC.import("ApplicationServices"); // AXIsProcessTrusted
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

// Window title for the log - the only handle a human has for telling
// Chrome windows (and profiles) apart when the wrong one gets the click.
function windowLabel(win) {
  var t = "";
  try { t = win.name() || ""; } catch (e) {}
  return "\"" + t.slice(0, 60) + "\"";
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
        log("  in window " + (wi + 1) + " of " + wins.length + ": " + windowLabel(wins[wi]));
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
  log("  in the frontmost of " + wins.length + " Chrome window(s): " + windowLabel(win));
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
  "  function describe(el) {\n" +
  "    if (!el) return null;\n" +
  "    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +\n" +
  "      '[name=' + (el.name || '') + ' type=' + (el.type || '') +\n" +
  "      ' ac=' + (el.getAttribute('autocomplete') || '') +\n" +
  "      ' ph=' + (el.placeholder || '').slice(0, 30) + ']';\n" +
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
  "  var ae = document.activeElement;\n" +
  "  var activeKey = ae === user ? 'user' : ae === pass ? 'pass' : ae === otp ? 'otp' :\n" +
  "    (ae && ae.tagName ? ae.tagName.toLowerCase() : 'none');\n" +
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
  "    hasFocus: document.hasFocus(), activeKey: activeKey,\n" +
  "    userDesc: describe(user), passDesc: describe(pass),\n" +
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

// What the probe found and where the window is - enough to check a click
// position by hand against the screen. Nothing here is a field's value.
function logFields(p) {
  var m = p.metrics;
  log("Fields: user=" + (p.userDesc || "none") + " pass=" + (p.passDesc || "none") +
      " | focus: page=" + p.hasFocus + " on='" + p.activeKey + "'");
  log("Window: screen(" + m.sx + "," + m.sy + ") inner " + m.iw + "x" + m.ih +
      " outer " + m.ow + "x" + m.oh + " zoom " + (m.ow / m.iw).toFixed(2));
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
// "authenticated" verdict: the identifier step's path does contain "/login"
// (/u/login/identifier, seen live), but Auth0's later screens need not, and
// a path marker would call an unrecognized one "signed in". The host cannot
// lie about that.
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
  // 1. One real click, then a full second: on some forms focus alone
  //    commits the saved value, and Chrome's suggestion list takes time
  //    to draw. If this click did not focus the field, the problem is
  //    geometry, not autofill - stop here rather than fire keystrokes
  //    into whatever does have focus.
  clickElement(chrome, handle, fieldKey);
  delay(1.0);
  var p = probe(chrome, handle);
  var landed = (p.activeKey === fieldKey);
  log("  after click: page focus=" + p.hasFocus + " on '" + p.activeKey +
      "', " + filledKey + "=" + p[filledKey]);
  p.landed = landed;
  if (p[filledKey] || !landed) return p;

  // 2. Field is focused. Down opens the suggestion list; give it time to
  //    draw before Return takes the first entry. Fired back-to-back, Return
  //    arrives before the list exists and submits the empty form instead.
  //    No second click here - clicking a field whose list is open closes it.
  keyTap(KEY_DOWN_ARROW);
  delay(0.7);
  keyTap(KEY_RETURN);
  delay(0.8);
  p = probe(chrome, handle);
  p.landed = landed;
  log("  after Down, Return: focus on '" + p.activeKey + "', " +
      filledKey + "=" + p[filledKey]);
  if (p[filledKey]) return p;

  // 3. Some forms only offer the list on a click of an already-focused
  //    field. Click again, then the same paced keys.
  clickElement(chrome, handle, fieldKey);
  delay(1.0);
  keyTap(KEY_DOWN_ARROW);
  delay(0.7);
  keyTap(KEY_RETURN);
  delay(0.8);
  p = probe(chrome, handle);
  p.landed = landed;
  log("  after click, Down, Return: focus on '" + p.activeKey + "', " +
      filledKey + "=" + p[filledKey]);
  return p;
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
  logFields(p);
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

  // CGEvents posted without Accessibility trust are silently dropped - the
  // run would then time out on every step and report a misleading exit 5.
  // Check once, up front, and name the fix. (The dry run above never
  // clicks, so it deliberately does not need this.)
  if (!$.AXIsProcessTrusted()) {
    fail(2, "This process is not trusted for Accessibility, so its clicks " +
            "would be silently dropped. System Settings > Privacy & Security > " +
            "Accessibility: enable the app running this script (Terminal, or " +
            "the launchd runner), then re-run.");
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
        if (!p.landed) {
          fail(2, "The click did not land on the username field - afterwards " +
                  "focus was on '" + p.activeKey + "' (page focused: " +
                  p.hasFocus + "). Geometry, not autofill: compare the Window " +
                  "line above with where the field really is (second display? " +
                  "page zoom not 100%? Chrome in full-screen?).");
        }
        fail(3, "The click focused the username field, but Chrome offered no " +
                "saved entry on click, Down+Return, or click+Down+Return. " +
                "Not guessing or retrying further (lockout risk).");
      }
      log("Username committed by autofill.");
      submitStep(chrome, handle, "user", p);

    } else if (kind === "password") {
      p = commitAutofill(chrome, handle, "pass", "passFilled");
      if (!p.passFilled && p.landed && p.user) {
        // One more gesture, this time starting from the username field -
        // some OnePass renders only offer the list from there. Same pacing.
        var landed = p.landed;
        clickElement(chrome, handle, "user");
        delay(1.0);
        keyTap(KEY_DOWN_ARROW);
        delay(0.7);
        keyTap(KEY_RETURN);
        delay(0.8);
        p = probe(chrome, handle);
        p.landed = landed;
        log("  after user-field click, Down, Return: passFilled=" + p.passFilled);
      }
      if (!p.passFilled) {
        if (!p.landed) {
          fail(2, "The click did not land on the password field - afterwards " +
                  "focus was on '" + p.activeKey + "' (page focused: " +
                  p.hasFocus + "). Geometry, not autofill.");
        }
        fail(3, "The click focused the password field, but Chrome offered no " +
                "saved entry on any gesture. Not guessing or retrying further " +
                "(lockout risk).");
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
