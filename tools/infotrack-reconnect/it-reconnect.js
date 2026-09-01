#!/usr/bin/env osascript -l JavaScript
// it-reconnect.js
//
// Complete the InfoTrack <-> Clio reconnect (OAuth re-authorization) with
// PHYSICAL clicks on the Mac mini's Chrome.
//
// Why: when InfoTrack's Clio integration lapses, the matter's "InfoTrack:
// File, Serve and Sync" tab shows a Connect/reconnect button that opens a
// separate authorization POPUP WINDOW. Browser-extension automation cannot
// see or drive that popup, and the sign-in form inside it needs a genuine
// user gesture before Chrome will commit its autofilled credentials. This
// program works at the OS level instead: AppleScript enumerates EVERY
// Chrome window (popups included) and CoreGraphics CGEvents deliver real
// mouse clicks and key taps, indistinguishable from a human on the mouse.
//
// What it does, in a watch-and-act loop (up to ~3 minutes):
//   1. If an InfoTrack auth page is already open (popup or tab), drives it.
//      Otherwise looks for the Clio matter tab showing the InfoTrack
//      reconnect pane and physically clicks its Connect button, then waits
//      for the popup. Any brand-new Chrome window that appears mid-run is
//      also treated as the auth popup, whatever its URL.
//   2. On a sign-in form: physically clicks the username field so Chrome
//      commits its autofill preview (Down+Return fallback if the saved-
//      credentials dropdown opens), then clicks Log In.
//   3. On a 2FA screen: clicks the code field so Apple Passwords autofills,
//      then clicks Verify. If the code does not autofill it STOPS - codes
//      are never relayed by hand.
//   4. On a consent screen: clicks Authorize / Allow / Connect.
//   5. Success = the auth page shows success text or the popup closes.
//      The Clio InfoTrack tab is then reloaded so the integration shows
//      connected.
//
// The only in-page JavaScript is a read-only probe returning element
// geometry, the URL, and filled/empty booleans - no credential value is
// ever read, typed, stored, logged, or returned.
//
// Usage:   osascript -l JavaScript it-reconnect.js [--dry-run]
//          (or use the it-reconnect.sh wrapper)
//
// Exit codes:
//   0  reconnected (or auth popup finished and closed)
//   2  setup problem (Apple-Events JS off, odd zoom)
//   3  Chrome autofill did not populate the sign-in credentials
//   4  2FA code field present but Apple Passwords did not autofill it
//   5  sign-in submitted but the auth page still shows the login form
//   6  timed out - no reconnect pane and no auth popup found, or flow stalled
//
// Same one-time Mac mini setup as the WealthCounsel tool (see that README):
// Chrome "Allow JavaScript from Apple Events", Accessibility + Automation
// permission for the runner.

"use strict";

ObjC.import("CoreGraphics");
ObjC.import("stdlib");

// ---------------------------------------------------------------- constants

var AUTH_URL_HINT = /infotrack/i;   // auth pages carry infotrack in the URL
var CLIO_URL_HINT = "app.clio.com"; // the matter tab hosting the pane
var TOTAL_TIMEOUT_SEC = 180;
var CONNECT_RECLICK_SEC = 25;       // wait before re-clicking Connect

var LEFT_MOUSE_DOWN = 1;
var LEFT_MOUSE_UP = 2;
var MOUSE_MOVED = 5;
var MOUSE_BUTTON_LEFT = 0;
var HID_EVENT_TAP = 0;
var KEY_RETURN = 36;
var KEY_DOWN_ARROW = 125;

// ------------------------------------------------------------------ logging

function log(msg) { console.log("[it-reconnect] " + msg); }

function fail(code, msg) {
  console.log("[it-reconnect] FAIL: " + msg);
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

// -------------------------------------------------------------- page probe
// Read-only: geometry, URL, filled/empty booleans, and which kind of screen
// this looks like. Never a field's contents.

var PROBE_JS = "(function () {\n" +
  "  function vis(el) {\n" +
  "    if (!el) return false;\n" +
  "    var r = el.getBoundingClientRect();\n" +
  "    return r.width > 4 && r.height > 4;\n" +
  "  }\n" +
  "  function rect(el) {\n" +
  "    if (!vis(el)) return null;\n" +
  "    var r = el.getBoundingClientRect();\n" +
  "    return { x: r.left, y: r.top, w: r.width, h: r.height };\n" +
  "  }\n" +
  "  function findBtn(scope, re) {\n" +
  "    var els = scope.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], a.btn, a[class*=button i]');\n" +
  "    for (var i = 0; i < els.length; i++) {\n" +
  "      var t = (els[i].innerText || els[i].value || els[i].getAttribute('aria-label') || '').trim();\n" +
  "      if (re.test(t) && vis(els[i])) return els[i];\n" +
  "    }\n" +
  "    return null;\n" +
  "  }\n" +
  "  var pass = document.querySelector('input[type=password]');\n" +
  "  if (pass && !vis(pass)) pass = null;\n" +
  "  var otp = document.querySelector(\n" +
  "    'input[autocomplete=one-time-code], input[name*=\"code\" i]:not([type=hidden]), input[id*=\"code\" i]:not([type=hidden])');\n" +
  "  if (otp && (otp.type === 'password' || !vis(otp))) otp = null;\n" +
  "  var anchor = pass || otp;\n" +
  "  if (anchor) anchor.scrollIntoView({ block: 'center' });\n" +
  "  var scope = anchor ? (anchor.form || document) : document;\n" +
  "  var user = scope.querySelector(\n" +
  "    'input[autocomplete=username], input[type=email], input[name*=\"user\" i], input[name*=\"email\" i], input[type=text]');\n" +
  "  if (user && !vis(user)) user = null;\n" +
  "  var submitBtn = findBtn(scope, /log\\s*in|sign\\s*in|submit|continue|next|verify/i);\n" +
  "  var connectBtn = findBtn(document, /connect|reconnect/i);\n" +
  "  var consentBtn = findBtn(document, /authorize|allow|approve|accept|grant|connect/i);\n" +
  "  var itFrame = null;\n" +
  "  var frames = document.querySelectorAll('iframe');\n" +
  "  for (var i = 0; i < frames.length; i++) {\n" +
  "    if (/infotrack/i.test(frames[i].src || '') && vis(frames[i])) { itFrame = frames[i]; break; }\n" +
  "  }\n" +
  "  var bodyText = (document.body && document.body.innerText || '').slice(0, 6000);\n" +
  "  return JSON.stringify({\n" +
  "    href: location.href,\n" +
  "    metrics: { sx: window.screenX, sy: window.screenY,\n" +
  "               iw: window.innerWidth, ih: window.innerHeight,\n" +
  "               ow: window.outerWidth, oh: window.outerHeight },\n" +
  "    hasPass: !!pass, hasOtp: !!otp,\n" +
  "    userFilled: !!(user && user.value.length),\n" +
  "    passFilled: !!(pass && pass.value.length),\n" +
  "    otpFilled: !!(otp && otp.value.length),\n" +
  "    successText: /(success|connected|complete|thank you|you (can|may) (now )?close)/i.test(bodyText),\n" +
  "    reconnectText: /reconnect and continue|click the button to (re)?connect/i.test(bodyText),\n" +
  "    user: rect(user), pass: rect(pass), otp: rect(otp),\n" +
  "    submitBtn: rect(submitBtn), connectBtn: rect(connectBtn),\n" +
  "    consentBtn: rect(consentBtn), itFrame: rect(itFrame)\n" +
  "  });\n" +
  "})();";

function probe(chrome, handle) {
  var raw;
  try {
    raw = chrome.execute(handle.win.tabs[handle.tabIndex - 1], { javascript: PROBE_JS });
  } catch (e) {
    if (/JavaScript through AppleScript|turned off/i.test(e.message || "")) {
      fail(2, "Chrome refused JavaScript via Apple Events. Enable: View > Developer > Allow JavaScript from Apple Events.");
    }
    return null; // tab busy/navigating/chrome:// page - caller retries
  }
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function toScreenAt(m, r, fx, fy) {
  var zoom = m.ow / m.iw;
  if (!(zoom > 0.4 && zoom < 4.0)) {
    fail(2, "Implausible zoom factor " + zoom.toFixed(2) + " - reset page zoom (Cmd+0) and retry.");
  }
  var chromeHeight = m.oh - m.ih * zoom;
  return {
    x: m.sx + (r.x + r.w * fx) * zoom,
    y: m.sy + chromeHeight + (r.y + r.h * fy) * zoom
  };
}

function toScreen(m, r) { return toScreenAt(m, r, 0.5, 0.5); }

// ------------------------------------------------------------ chrome logic

function getChrome() {
  var chrome = Application("Google Chrome");
  chrome.includeStandardAdditions = true;
  if (!chrome.running()) fail(6, "Chrome is not running - open the Clio matter's InfoTrack tab first.");
  return chrome;
}

function windowIds(chrome) {
  var ids = [];
  var wins = chrome.windows();
  for (var i = 0; i < wins.length; i++) {
    try { ids.push(wins[i].id()); } catch (e) {}
  }
  return ids;
}

// Find the tab to act on. Preference order:
//   1. any tab whose URL matches AUTH_URL_HINT (the auth popup/tab)
//   2. the active tab of any window not present at start (popup, any URL)
// Returns { win, tabIndex, isNewWindow } or null.
function findAuthTab(chrome, startIds) {
  var wins = chrome.windows();
  var newWin = null;
  for (var wi = 0; wi < wins.length; wi++) {
    var tabs;
    try { tabs = wins[wi].tabs(); } catch (e) { continue; }
    for (var ti = 0; ti < tabs.length; ti++) {
      var u = "";
      try { u = tabs[ti].url() || ""; } catch (e) { u = ""; }
      if (AUTH_URL_HINT.test(u) && u.indexOf(CLIO_URL_HINT) === -1) {
        return { win: wins[wi], tabIndex: ti + 1, isNewWindow: false };
      }
    }
    var id = -1;
    try { id = wins[wi].id(); } catch (e) {}
    if (!newWin && id !== -1 && startIds.indexOf(id) === -1) {
      newWin = { win: wins[wi], tabIndex: wins[wi].activeTabIndex(), isNewWindow: true };
    }
  }
  return newWin;
}

// Find the Clio tab that hosts the InfoTrack pane (probe confirms it).
function findClioInfoTrackTab(chrome) {
  var wins = chrome.windows();
  for (var wi = 0; wi < wins.length; wi++) {
    var tabs;
    try { tabs = wins[wi].tabs(); } catch (e) { continue; }
    for (var ti = 0; ti < tabs.length; ti++) {
      var u = "";
      try { u = tabs[ti].url() || ""; } catch (e) { u = ""; }
      if (u.indexOf(CLIO_URL_HINT) === -1) continue;
      var handle = { win: wins[wi], tabIndex: ti + 1 };
      var p = probe(chrome, handle);
      if (p && (p.itFrame || p.reconnectText || p.connectBtn)) return { handle: handle, probe: p };
    }
  }
  return null;
}

function focus(chrome, handle) {
  try { handle.win.activeTabIndex = handle.tabIndex; } catch (e) {}
  handle.win.index = 1;
  chrome.activate();
  delay(0.6);
}

function clickKey(chrome, handle, p, key) {
  if (!p[key]) return false;
  var pt = toScreen(p.metrics, p[key]);
  log("Physical click on '" + key + "' at (" + Math.round(pt.x) + ", " + Math.round(pt.y) + ")");
  physicalClick(pt);
  return true;
}

// ------------------------------------------------------- sign-in sub-flows

function doLogin(chrome, handle) {
  var p = probe(chrome, handle);
  if (!p || !p.hasPass) return;
  focus(chrome, handle);
  clickKey(chrome, handle, p, "user") || clickKey(chrome, handle, p, "pass");
  delay(0.5);
  p = probe(chrome, handle);
  if (p && !p.passFilled) {
    log("Autofill not committed - selecting from the dropdown");
    clickKey(chrome, handle, p, "user");
    keyTap(KEY_DOWN_ARROW); keyTap(KEY_RETURN);
    delay(0.6);
    p = probe(chrome, handle);
  }
  if (p && !p.passFilled) {
    clickKey(chrome, handle, p, "pass");
    keyTap(KEY_DOWN_ARROW); keyTap(KEY_RETURN);
    delay(0.6);
    p = probe(chrome, handle);
  }
  if (p && !p.passFilled) {
    fail(3, "Chrome autofill did not populate the InfoTrack password. Check the saved credential, " +
            "then re-run. Not retrying further (lockout risk).");
  }
  log("Credentials committed by autofill.");
  p = probe(chrome, handle);
  if (p && p.submitBtn) clickKey(chrome, handle, p, "submitBtn");
  else { clickKey(chrome, handle, p, "pass"); keyTap(KEY_RETURN); }
  delay(2.0);
}

function doOtp(chrome, handle, otpAttempts) {
  var p = probe(chrome, handle);
  if (!p || !p.hasOtp) return;
  focus(chrome, handle);
  log("2FA code field - giving Apple Passwords a gesture to fill it");
  clickKey(chrome, handle, p, "otp");
  delay(1.2);
  p = probe(chrome, handle);
  if (p && !p.otpFilled) {
    clickKey(chrome, handle, p, "otp");
    keyTap(KEY_DOWN_ARROW); keyTap(KEY_RETURN);
    delay(1.0);
    p = probe(chrome, handle);
  }
  if (p && !p.otpFilled) {
    if (otpAttempts >= 2) {
      fail(4, "2FA field did not autofill from Apple Passwords. Stopping - codes are never relayed by hand.");
    }
    return; // let the outer loop come back around once
  }
  p = probe(chrome, handle);
  if (p && p.submitBtn) clickKey(chrome, handle, p, "submitBtn");
  else { clickKey(chrome, handle, p, "otp"); keyTap(KEY_RETURN); }
  delay(2.0);
}

// ---------------------------------------------------------------- the flow

function run(argv) {
  var dryRun = argv.indexOf("--dry-run") !== -1;
  var chrome = getChrome();
  var startIds = windowIds(chrome);

  if (dryRun) {
    var auth = findAuthTab(chrome, startIds);
    if (auth) {
      var pa = probe(chrome, auth);
      log("DRY RUN - auth page found: " + (pa ? pa.href : "(unprobed)"));
      if (pa) log("DRY RUN - hasPass=" + pa.hasPass + " hasOtp=" + pa.hasOtp +
                  " consentBtn=" + !!pa.consentBtn + " successText=" + pa.successText);
    } else {
      log("DRY RUN - no auth popup/tab open.");
    }
    var clio = findClioInfoTrackTab(chrome);
    if (clio) {
      log("DRY RUN - Clio InfoTrack pane: " + clio.probe.href);
      log("DRY RUN - reconnectText=" + clio.probe.reconnectText +
          " connectBtn=" + !!clio.probe.connectBtn + " itFrame=" + !!clio.probe.itFrame);
    } else {
      log("DRY RUN - no Clio tab with an InfoTrack pane found (open the matter's InfoTrack tab).");
    }
    log("DRY RUN - no clicks performed.");
    $.exit(0);
  }

  var deadline = Date.now() + TOTAL_TIMEOUT_SEC * 1000;
  var authWasSeen = false;
  var nextConnectAllowed = 0;
  var everTriedConnect = false;
  var frameAttempt = 0;
  var loginRounds = 0;
  var otpRounds = 0;

  // Where to try clicking inside the InfoTrack iframe when the probe cannot
  // see the button (cross-origin): the reconnect pane is a short message
  // with the button near the top, so work down from upper-center. Fractions
  // of the iframe's width/height.
  var FRAME_CANDIDATES = [
    [0.5, 0.20], [0.5, 0.35], [0.5, 0.50], [0.5, 0.12], [0.35, 0.25], [0.5, 0.65]
  ];

  while (Date.now() < deadline) {
    var auth = findAuthTab(chrome, startIds);

    if (auth) {
      authWasSeen = true;
      var p = probe(chrome, auth);
      if (!p) { delay(1); continue; }

      if (p.successText && !p.hasPass && !p.hasOtp) {
        log("Auth page reports success: " + p.href);
        try { auth.win.tabs[auth.tabIndex - 1].close(); log("Closed the auth popup."); } catch (e) {}
        break;
      }
      if (p.hasPass) {
        loginRounds++;
        if (loginRounds > 3) fail(5, "Still on the sign-in form after " + (loginRounds - 1) +
                                     " attempts (" + p.href + "). Stopping (lockout risk).");
        doLogin(chrome, auth);
        continue;
      }
      if (p.hasOtp) {
        otpRounds++;
        doOtp(chrome, auth, otpRounds);
        continue;
      }
      if (p.consentBtn) {
        focus(chrome, auth);
        log("Consent screen (" + p.href + ")");
        clickKey(chrome, auth, p, "consentBtn");
        delay(2.0);
        continue;
      }
      delay(1); // auth page mid-navigation
      continue;
    }

    if (authWasSeen) {
      log("Auth popup closed - treating as authorization complete.");
      break;
    }

    // No auth page yet: click Connect in the Clio InfoTrack pane.
    var clio = findClioInfoTrackTab(chrome);
    if (clio && Date.now() >= nextConnectAllowed) {
      focus(chrome, clio.handle);
      var cp = probe(chrome, clio.handle);
      if (cp && cp.connectBtn) {
        log("Clicking the Connect button in the Clio InfoTrack pane");
        clickKey(chrome, clio.handle, cp, "connectBtn");
        everTriedConnect = true;
        nextConnectAllowed = Date.now() + CONNECT_RECLICK_SEC * 1000;
      } else if (cp && cp.itFrame) {
        // The button lives inside InfoTrack's cross-origin iframe where the
        // probe cannot see it. Try a ladder of likely positions, one per
        // pass, until the popup appears.
        var cand = FRAME_CANDIDATES[Math.min(frameAttempt, FRAME_CANDIDATES.length - 1)];
        var pt = toScreenAt(cp.metrics, cp.itFrame, cand[0], cand[1]);
        log("Connect button is inside the InfoTrack iframe - trying position " +
            (frameAttempt + 1) + " (" + cand[0] + ", " + cand[1] + ") at (" +
            Math.round(pt.x) + ", " + Math.round(pt.y) + ")");
        physicalClick(pt);
        frameAttempt++;
        everTriedConnect = true;
        nextConnectAllowed = Date.now() + 8 * 1000; // short gap between ladder tries
      }
      delay(2);
      continue;
    }
    if (!clio && !authWasSeen && !everTriedConnect) {
      // Nothing to work with at all - say so early rather than spinning.
      fail(6, "No InfoTrack auth page open and no Clio tab showing the InfoTrack pane. " +
              "Open the matter in Clio, select the 'InfoTrack: File, Serve and Sync' tab, then re-run.");
    }
    delay(1);
  }

  if (Date.now() >= deadline) {
    fail(6, "Timed out after " + TOTAL_TIMEOUT_SEC + "s without completing the reconnect.");
  }

  // Reload the Clio pane so the integration shows connected.
  var clioAfter = findClioInfoTrackTab(chrome);
  if (clioAfter) {
    try {
      clioAfter.handle.win.tabs[clioAfter.handle.tabIndex - 1].reload();
      log("Reloaded the Clio InfoTrack tab.");
    } catch (e) {}
  }
  log("OK: InfoTrack reconnect flow complete. Verify the pane shows connected, then re-stage the eFiling.");
  $.exit(0);
}
