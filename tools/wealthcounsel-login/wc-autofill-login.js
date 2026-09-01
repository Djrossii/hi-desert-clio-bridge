#!/usr/bin/env osascript -l JavaScript
// wc-autofill-login.js
//
// WealthCounsel login via PHYSICAL clicks (Chrome autofill workaround).
//
// Chrome deliberately hides autofilled credentials from page JavaScript:
// the password field *shows* dots, but its .value reads as empty ("") until
// the page receives a REAL user gesture. So no bookmarklet, extension
// script, or injected JS can ever submit the autofilled credentials.
//
// This program works at the operating-system level instead. It posts
// genuine CGEvent mouse clicks and key taps through the HID event tap —
// indistinguishable from a human on the physical mouse — so Chrome
// converts its autofill preview into real values and submits them
// natively. The script never reads, stores, types, or transmits the
// credential itself; only booleans ("is the field filled?") and element
// geometry ever cross out of the page.
//
// Usage:   osascript -l JavaScript wc-autofill-login.js [--dry-run] [url]
//          (or use the wc-login.sh wrapper)
//
// Exit codes:
//   0  logged in (or already authenticated)
//   2  setup problem (Chrome JS-from-Apple-Events off, page shape unknown)
//   3  Chrome autofill did not populate the credentials
//   4  2FA code field present but Apple Passwords did not autofill it
//   5  login submitted but the site still shows the login form
//   6  timeout waiting for Chrome / page load
//
// Requirements (one-time setup on the Mac mini — see README.md):
//   * Chrome: View > Developer > Allow JavaScript from Apple Events
//   * System Settings > Privacy & Security > Accessibility: allow the
//     terminal (or launchd runner) that invokes this script
//   * System Settings > Privacy & Security > Automation: same runner may
//     control Google Chrome

"use strict";

ObjC.import("CoreGraphics");
ObjC.import("stdlib");

// ---------------------------------------------------------------- constants

var DEFAULT_URL = "https://member.wealthcounsel.com/login";
var LOGIN_PATH_MARKER = "/login";

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
  console.log("[wc-login] " + msg);
}

function fail(code, msg) {
  console.log("[wc-login] FAIL: " + msg);
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

// Find the newest tab already on the target host, else open one.
// Returns { win, tabIndex } with tabIndex 1-based (Chrome's convention).
function findOrOpenTab(chrome, host, url) {
  var wins = chrome.windows();
  for (var wi = 0; wi < wins.length; wi++) {
    var tabs;
    try { tabs = wins[wi].tabs(); } catch (e) { continue; }
    for (var ti = 0; ti < tabs.length; ti++) {
      var u = "";
      try { u = tabs[ti].url() || ""; } catch (e) { u = ""; }
      if (u.indexOf(host) !== -1) {
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
// Runs inside the page via Apple Events. Returns ONLY geometry, the URL,
// and filled/empty booleans - never a field's contents.

var PROBE_JS = "(function () {\n" +
  "  function rect(el) {\n" +
  "    if (!el) return null;\n" +
  "    var r = el.getBoundingClientRect();\n" +
  "    if (!r.width || !r.height) return null;\n" +
  "    return { x: r.left, y: r.top, w: r.width, h: r.height };\n" +
  "  }\n" +
  "  var pass = document.querySelector('input[type=password]');\n" +
  "  var otp = document.querySelector(\n" +
  "    'input[autocomplete=one-time-code], input[name*=\"code\" i]:not([type=hidden]), input[id*=\"code\" i]:not([type=hidden])');\n" +
  "  if (otp && otp.type === 'password') otp = null;\n" +
  "  var anchor = pass || otp;\n" +
  "  if (anchor) anchor.scrollIntoView({ block: 'center' });\n" +
  "  var scope = anchor ? (anchor.form || document) : document;\n" +
  "  var user = scope.querySelector(\n" +
  "    'input[autocomplete=username], input[type=email], input[name*=\"user\" i], input[name*=\"email\" i], input[type=text]');\n" +
  "  var btn = null;\n" +
  "  var btns = scope.querySelectorAll('button, input[type=submit]');\n" +
  "  for (var i = 0; i < btns.length; i++) {\n" +
  "    var t = (btns[i].innerText || btns[i].value || '').trim();\n" +
  "    if (/log\\s*in|sign\\s*in|submit|continue|verify/i.test(t)) { btn = btns[i]; break; }\n" +
  "  }\n" +
  "  if (!btn && btns.length === 1) btn = btns[0];\n" +
  "  return JSON.stringify({\n" +
  "    href: location.href,\n" +
  "    metrics: { sx: window.screenX, sy: window.screenY,\n" +
  "               iw: window.innerWidth, ih: window.innerHeight,\n" +
  "               ow: window.outerWidth, oh: window.outerHeight },\n" +
  "    hasPass: !!pass, hasOtp: !!otp,\n" +
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

// ---------------------------------------------------------------- the flow

function run(argv) {
  var dryRun = false;
  var url = DEFAULT_URL;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i].indexOf("http") === 0) url = argv[i];
  }
  var host = url.replace(/^https?:\/\//, "").split("/")[0];

  var chrome = getChrome();
  var handle = findOrOpenTab(chrome, host, url);
  if (!waitLoaded(handle, 30)) fail(6, "Page did not finish loading within 30s.");

  var p = probe(chrome, handle);
  log("Page: " + p.href);

  if (!p.hasPass && !p.hasOtp) {
    if (p.href.indexOf(LOGIN_PATH_MARKER) === -1) {
      log("OK: already authenticated - no login form present.");
      $.exit(0);
    }
    fail(2, "On " + p.href + " but found no password field - page shape " +
            "changed or still rendering. Re-run; if it persists the probe " +
            "selectors need updating.");
  }

  if (dryRun) {
    log("DRY RUN - found: user=" + !!p.user + " pass=" + !!p.pass +
        " btn=" + !!p.btn + " otp=" + !!p.otp +
        " | autofilled: user=" + p.userFilled + " pass=" + p.passFilled);
    log("DRY RUN - no clicks performed.");
    $.exit(0);
  }

  focusTab(chrome, handle);

  // --- Step 1: real gesture on the username field. This single physical
  // click is what flips Chrome's autofill preview into real values.
  if (p.hasPass) {
    clickElement(chrome, handle, "user") || clickElement(chrome, handle, "pass");
    delay(0.5);
    p = probe(chrome, handle);

    // If the click opened the autofill dropdown instead of committing it,
    // pick the first saved credential with real Down + Return keystrokes.
    if (!p.passFilled) {
      log("Autofill not committed yet - selecting from the dropdown");
      clickElement(chrome, handle, "user");
      keyTap(KEY_DOWN_ARROW);
      keyTap(KEY_RETURN);
      delay(0.6);
      p = probe(chrome, handle);
    }
    if (!p.passFilled) {
      // One more gesture directly on the password field.
      clickElement(chrome, handle, "pass");
      keyTap(KEY_DOWN_ARROW);
      keyTap(KEY_RETURN);
      delay(0.6);
      p = probe(chrome, handle);
    }
    if (!p.passFilled) {
      fail(3, "Chrome autofill did not populate the password field. " +
              "Check that the credential is saved in Chrome/Apple Passwords " +
              "for " + host + " and that its autofill extension is on. " +
              "Not guessing or retrying further (lockout risk).");
    }
    log("Credentials committed by autofill (user=" + p.userFilled + ", pass=filled).");

    // --- Step 2: submit with a real click on the button (or Return in the
    // password field if no recognizable button).
    if (p.btn) {
      clickElement(chrome, handle, "btn");
    } else {
      log("No submit button recognized - pressing Return in the password field");
      clickElement(chrome, handle, "pass");
      keyTap(KEY_RETURN);
    }
    waitLoaded(handle, 30);
    delay(1.5);
    p = probe(chrome, handle);
  }

  // --- Step 3: 2FA screen, if the site presents one. The code autofills
  // from Apple Passwords; we only supply the real gesture and the click.
  if (p.hasOtp) {
    log("2FA code field present - giving Apple Passwords a gesture to fill it");
    clickElement(chrome, handle, "otp");
    delay(1.2);
    p = probe(chrome, handle);
    if (!p.otpFilled) {
      clickElement(chrome, handle, "otp");
      keyTap(KEY_DOWN_ARROW);
      keyTap(KEY_RETURN);
      delay(1.0);
      p = probe(chrome, handle);
    }
    if (!p.otpFilled) {
      fail(4, "2FA field did not autofill from Apple Passwords. Stopping - " +
              "codes are never relayed by hand. Check the Apple Passwords " +
              "Chrome extension on the Mac mini.");
    }
    if (p.btn) clickElement(chrome, handle, "btn");
    else { clickElement(chrome, handle, "otp"); keyTap(KEY_RETURN); }
    waitLoaded(handle, 30);
    delay(1.5);
    p = probe(chrome, handle);
  }

  // --- Step 4: verify.
  if (p.hasPass && p.href.indexOf(LOGIN_PATH_MARKER) !== -1) {
    fail(5, "Still on the login form after submitting (" + p.href + "). " +
            "Stopping rather than retrying (lockout risk).");
  }
  log("OK: logged in - now at " + p.href);
  $.exit(0);
}
