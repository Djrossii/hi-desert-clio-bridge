#!/usr/bin/env python3
"""
HI-DESERT LAW FLEET GUARD  (fleet-guard.py)  v1.0  2026-08-24

WHY THIS EXISTS
---------------
DJ, 2026-08-24: "Several tasks in the Claude fleet are reporting back as
'degraded'. Explain and resolve. Ensure that the error can not occur again by
drafting new script or redundancy."

Three recurring defect classes produced those reports, and each one survived
because the check against it lived in an intention rather than a program:

  1. FALSE PASS ON A DEGRADED INVENTORY (8/21/26): the scheduled rules-verifier
     scored a staged trigger inventory of 41 rows in which 0 carried
     enabled:true, and reported PASS/0-fails while a local run of the same
     script found 70 failures. stage_triggers.py v1.0 failed closed only on
     ZERO ROWS; a field-level loss sailed through.
  2. PHANTOM / INVENTED RECEIPT IDS (8/21-8/22/26): runs wrote run receipts
     under trigger ids that do not exist (trig_rules-verifier-scheduled,
     trig_01R7FMjdnsgfsgSoLoHQimci, two others), which scores the REAL trigger
     as FIRED-NO-RECEIPT and buries the phantom.
  3. CORRUPT RECEIPTS AND SHELL-SUBSTITUTION CLOBBERS: a 28-byte receipt; state
     files destroyed by writes of a literal unexpanded `$(...)` / `${...}`.

This program is the redundancy: deterministic validators with exit codes that
the delivery paths run through. It never edits anything — it only refuses.

Canonical home: OneDrive Apps/Claude/Playbooks/fleet-guard.py.txt
Repo copy:      hi-desert-clio-bridge/tools/fleet-guard.py
Both copies must stay byte-identical; the OneDrive .txt is what scheduled runs
fetch (read_resource refuses bare .py as application/octet-stream).

USAGE
-----
  fleet-guard.py check-inventory RAW_DUMP.json [--min-enabled N]
      Parse a raw list_triggers dump (tool-result file; leading non-JSON
      preamble is skipped). Exit 1 unless >0 rows, every PRESENT `enabled` is
      a real boolean (the API omits the key on a disabled trigger - normal),
      and >= min-enabled rows (default 1) are enabled:true.

  fleet-guard.py check-staged STAGED.json [--min-enabled N] [--expect N --tolerance N]
      Same assertions against a staged verifier-in/triggers.json
      ({"data":[...]} or [...]). --expect/--tolerance additionally require the
      enabled count to be within tolerance of an expected figure (e.g. the
      registry's enabled_trigger_count_at_write).

  fleet-guard.py roster RAW_DUMP.json -o fleet-trigger-roster.json
      Emit a compact roster (id, name, enabled, cron_expression, run_once_at,
      next_run_at, last_fired_at, updated_at) — a few KB — so tasks that only
      need the roster can read this file instead of paying the ~1 MB
      list_triggers call. Runs check-inventory first; refuses to write a
      roster that would fail it.

  fleet-guard.py receipt RECEIPT.json [--roster ROSTER.json] [--filename NAME]
      Validate a run receipt BEFORE upload: required shape, status enum,
      plausible trigger_id (and, with --roster, membership in the live
      inventory — kills invented ids), minimum size, no unexpanded shell
      substitution, well-formed errors[]. With --filename, enforce the
      `<trigger_id>.<UTCcompact>.json` convention against the receipt body.

  fleet-guard.py selftest
      Run the embedded test cases (covers all three incident classes above).
      Exit 0 = all pass. Run this after ANY edit to this file.

Exit codes everywhere: 0 = pass, 1 = refuse, 2 = usage error.
stdlib only; no network; never modifies its inputs.
"""
import json
import os
import re
import sys
import tempfile

TRIGGER_ID_RE = re.compile(r"^trig_[A-Za-z0-9]{20,30}$")
STAMP_RE = re.compile(r"^\d{8}T\d{4,6}Z$")
RECEIPT_REQUIRED = ("trigger_id", "name", "started_utc", "ended_utc", "status",
                    "artifact", "work", "errors", "blocked", "next_run_should")
RECEIPT_OPTIONAL = ("usage",)
RECEIPT_STATUSES = ("ok", "degraded", "failed")
ROSTER_FIELDS = ("id", "name", "enabled", "cron_expression", "run_once_at",
                 "next_run_at", "last_fired_at", "updated_at")

MSGS = []


def say(line):
    MSGS.append(line)
    print(line)


def load_rows(path):
    """Rows from a raw dump or staged file. Returns (rows, error_or_None)."""
    try:
        text = open(path, "r", encoding="utf-8", errors="replace").read()
    except OSError as e:
        return None, "unreadable: %s" % e
    starts = [x for x in (text.find("{"), text.find("[")) if x >= 0]
    if not starts:
        return None, "no JSON found in %s" % path
    try:
        doc = json.loads(text[min(starts):])
    except ValueError as e:
        return None, "not valid JSON: %s" % e
    rows = doc.get("data") if isinstance(doc, dict) else doc
    if not isinstance(rows, list):
        return None, "no data[] list found"
    return rows, None


def check_rows(rows, min_enabled=1, expect=None, tolerance=2, label="inventory"):
    """The fail-closed inventory assertions. Returns exit code."""
    if not rows:
        say("FAIL: %s holds 0 trigger rows - a stub is worse than a missing "
            "file (every coverage check passes on an empty fleet)" % label)
        return 1
    nonbool = [str(r.get("id")) for r in rows
               if "enabled" in r and not isinstance(r["enabled"], bool)]
    if nonbool:
        say("FAIL: %s: %d row(s) carry a non-boolean `enabled` value (%s%s) - "
            "the enabled flag was lost or mangled in staging; a gate reading "
            "this would score an empty enabled fleet (the 8/21/26 false-PASS "
            "class)" % (label, len(nonbool), ", ".join(nonbool[:5]),
                        "..." if len(nonbool) > 5 else ""))
        return 1
    enabled = sum(1 for r in rows if r.get("enabled") is True)
    if enabled < min_enabled:
        say("FAIL: %s: %d rows but only %d enabled:true (minimum %d) - this "
            "account has never had a near-zero enabled fleet, so the "
            "inventory is implausible; REFUSING it rather than letting a gate "
            "pass on it" % (label, len(rows), enabled, min_enabled))
        return 1
    if expect is not None and abs(enabled - expect) > tolerance:
        say("FAIL: %s: enabled count %d deviates from expected %d by more "
            "than %d - staged inventory and registry disagree; resolve before "
            "scoring" % (label, enabled, expect, tolerance))
        return 1
    say("OK: %s: %d rows, %d enabled:true" % (label, len(rows), enabled))
    return 0


def cmd_check_inventory(argv):
    if not argv:
        say("usage: fleet-guard.py check-inventory RAW_DUMP.json [--min-enabled N]")
        return 2
    rows, err = load_rows(argv[0])
    if err:
        say("FAIL: %s" % err)
        return 1
    return check_rows(rows, min_enabled=_opt_int(argv, "--min-enabled", 1),
                      label=os.path.basename(argv[0]))


def cmd_check_staged(argv):
    if not argv:
        say("usage: fleet-guard.py check-staged STAGED.json [--min-enabled N] "
            "[--expect N --tolerance N]")
        return 2
    rows, err = load_rows(argv[0])
    if err:
        say("FAIL: %s" % err)
        return 1
    expect = _opt_int(argv, "--expect", None)
    return check_rows(rows, min_enabled=_opt_int(argv, "--min-enabled", 1),
                      expect=expect, tolerance=_opt_int(argv, "--tolerance", 2),
                      label=os.path.basename(argv[0]))


def cmd_roster(argv):
    if not argv:
        say("usage: fleet-guard.py roster RAW_DUMP.json -o OUT.json")
        return 2
    rows, err = load_rows(argv[0])
    if err:
        say("FAIL: %s" % err)
        return 1
    rc = check_rows(rows, label=os.path.basename(argv[0]))
    if rc != 0:
        say("FAIL: roster not written - the inventory failed validation above")
        return 1
    out = "-o" in argv and argv[argv.index("-o") + 1] or "fleet-trigger-roster.json"
    roster = {"schema": "hi-desert-law fleet-trigger-roster v1",
              "source": os.path.basename(argv[0]),
              "count": len(rows),
              "enabled_count": sum(1 for r in rows if r.get("enabled") is True),
              "data": [{k: r.get(k) for k in ROSTER_FIELDS} for r in rows]}
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(roster, fh, indent=1)
    say("OK: wrote %d-row roster (%d enabled) to %s (%d bytes)"
        % (len(rows), roster["enabled_count"], out, os.path.getsize(out)))
    return 0


def cmd_receipt(argv):
    if not argv:
        say("usage: fleet-guard.py receipt RECEIPT.json [--roster ROSTER.json] "
            "[--filename NAME]")
        return 2
    path = argv[0]
    try:
        raw = open(path, "r", encoding="utf-8", errors="replace").read()
    except OSError as e:
        say("FAIL: receipt unreadable: %s" % e)
        return 1
    ok = True

    if len(raw.encode("utf-8")) < 100:
        say("FAIL: receipt is %d bytes - too small to hold the required shape "
            "(the 8/21/26 28-byte receipt class)" % len(raw.encode("utf-8")))
        ok = False
    if "$(" in raw or "${" in raw:
        say("FAIL: receipt contains a literal `$(` or `${` - unexpanded shell "
            "substitution is the clobber class that destroyed "
            "morning-briefing-queue.md and two state files on 8/21-8/22/26; "
            "render the content, never the command")
        ok = False
    try:
        doc = json.loads(raw)
    except ValueError as e:
        say("FAIL: receipt is not valid JSON: %s" % e)
        return 1
    if not isinstance(doc, dict):
        say("FAIL: receipt is not a JSON object")
        return 1

    missing = [k for k in RECEIPT_REQUIRED if k not in doc]
    if missing:
        say("FAIL: receipt is missing required key(s): %s" % ", ".join(missing))
        ok = False
    extra = [k for k in doc if k not in RECEIPT_REQUIRED + RECEIPT_OPTIONAL]
    if extra:
        say("FAIL: receipt carries key(s) outside the canonical shape: %s "
            "(Playbook-Addendum-Run-Receipts.md section 4: no extra keys)"
            % ", ".join(extra))
        ok = False
    if doc.get("status") not in RECEIPT_STATUSES:
        say("FAIL: status %r is not one of %s"
            % (doc.get("status"), "|".join(RECEIPT_STATUSES)))
        ok = False

    tid = str(doc.get("trigger_id") or "")
    if not TRIGGER_ID_RE.match(tid):
        say("FAIL: trigger_id %r does not match the real id format "
            "(^trig_[A-Za-z0-9]{20,30}$) - a placeholder or invented id "
            "scores the real trigger FIRED-NO-RECEIPT (8/21/26 incident)" % tid)
        ok = False
    roster_path = _opt_str(argv, "--roster", None)
    if roster_path and TRIGGER_ID_RE.match(tid):
        rows, err = load_rows(roster_path)
        if err:
            say("FAIL: roster %s: %s" % (roster_path, err))
            ok = False
        elif tid not in {r.get("id") for r in rows}:
            say("FAIL: trigger_id %s is not in the live inventory (%s, %d "
                "rows) - this is an INVENTED id; use the id hardcoded in this "
                "task's own prompt" % (tid, os.path.basename(roster_path),
                                       len(rows)))
            ok = False

    if not isinstance(doc.get("errors"), list):
        say("FAIL: errors is not a list")
        ok = False
    else:
        for i, e in enumerate(doc["errors"]):
            if not isinstance(e, dict) or not e.get("tool") \
                    or not e.get("verbatim"):
                say("FAIL: errors[%d] must be an object with non-empty "
                    "`tool` and `verbatim`" % i)
                ok = False
    if "usage" not in doc:
        say("WARN: no `usage` block (required since the 2026-08-23 amendment; "
            "expected until the prompt-level rollout completes)")

    fname = _opt_str(argv, "--filename", None)
    if fname:
        base = os.path.basename(fname)
        parts = base.split(".")
        if len(parts) != 3 or parts[2] != "json" \
                or not STAMP_RE.match(parts[1]) or parts[0] != tid:
            say("FAIL: filename %r does not match `<trigger_id>.<UTCcompact>"
                ".json` for trigger_id %s" % (base, tid or "<missing>"))
            ok = False

    say("RESULT: %s" % ("PASS - receipt may be uploaded" if ok
                        else "FAIL - DO NOT UPLOAD; fix and re-validate"))
    return 0 if ok else 1


# ------------------------------------------------------------- selftest ----

def _case(name, fn, expect):
    got = fn()
    status = "pass" if got == expect else "FAIL"
    print("selftest %-52s expect %d got %d  %s" % (name, expect, got, status))
    return status == "pass"


def cmd_selftest(_argv):
    tmp = tempfile.mkdtemp(prefix="fleet-guard-selftest-")

    def w(name, obj, raw=None):
        p = os.path.join(tmp, name)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(raw if raw is not None else json.dumps(obj))
        return p

    good_rows = [{"id": "trig_01WwPRWGUiFA4M1uB3aHoCCa", "name": "a",
                  "enabled": True},
                 {"id": "trig_018yhr8LTgLcCBHasQmgD3bh", "name": "b",
                  "enabled": False}]
    inv_good = w("good.json", {"data": good_rows})
    inv_zero_enabled = w("zero.json", {"data": [
        dict(r, enabled=False) for r in good_rows]})
    inv_string_enabled = w("string.json", {"data": [
        dict(r, enabled="True") for r in good_rows]})   # present but non-bool
    no_key = [{"id": r["id"], "name": r["name"]} for r in good_rows]
    inv_all_absent = w("absent.json", {"data": no_key})  # the 8/21 class:
    # every row lost its enabled key -> 0 enabled:true on a full row set
    inv_mixed_absent = w("mixed.json", {"data": [
        good_rows[0], {"id": good_rows[1]["id"], "name": "b"}]})
    inv_empty = w("empty.json", {"data": []})
    inv_preamble = w("preamble.json", None,
                     raw="tool result header\n" + json.dumps({"data": good_rows}))

    receipt_good = w("r_good.json", {
        "trigger_id": "trig_01WwPRWGUiFA4M1uB3aHoCCa", "name": "rules-verifier",
        "started_utc": "2026-08-24T15:45:00Z", "ended_utc": "2026-08-24T15:59:00Z",
        "status": "ok", "artifact": "verifier-state.json", "work": "ran gates",
        "errors": [], "blocked": [], "next_run_should": None,
        "usage": {"tokens_used": 0, "tokens_left": 0, "tool_calls": 0,
                  "subagents": 0, "duration_s": 840, "note": "selftest"}})
    receipt_invented = w("r_invented.json", {
        "trigger_id": "trig_rules-verifier-scheduled", "name": "x",
        "started_utc": "", "ended_utc": "", "status": "ok", "artifact": None,
        "work": "", "errors": [], "blocked": [], "next_run_should": None})
    receipt_phantom = w("r_phantom.json", {
        "trigger_id": "trig_01R7FMjdnsgfsgSoLoHQimci", "name": "x",
        "started_utc": "", "ended_utc": "", "status": "ok", "artifact": None,
        "work": "", "errors": [], "blocked": [], "next_run_should": None})
    receipt_tiny = w("r_tiny.json", None, raw='{"trigger_id":"x"}')
    receipt_shell = w("r_shell.json", {
        "trigger_id": "trig_01WwPRWGUiFA4M1uB3aHoCCa", "name": "x",
        "started_utc": "", "ended_utc": "", "status": "ok",
        "artifact": "$(cat /tmp/x.md)", "work": "", "errors": [],
        "blocked": [], "next_run_should": None})
    receipt_badstatus = w("r_badstatus.json", {
        "trigger_id": "trig_01WwPRWGUiFA4M1uB3aHoCCa", "name": "x",
        "started_utc": "", "ended_utc": "", "status": "partial",
        "artifact": None, "work": "a run that delivered most of its work",
        "errors": [], "blocked": [], "next_run_should": None})

    results = [
        _case("check-inventory: healthy dump",
              lambda: cmd_check_inventory([inv_good]), 0),
        _case("check-inventory: 0 enabled (8/21 false-PASS class)",
              lambda: cmd_check_inventory([inv_zero_enabled]), 1),
        _case("check-inventory: enabled as string 'True'",
              lambda: cmd_check_inventory([inv_string_enabled]), 1),
        _case("check-inventory: enabled key lost on ALL rows (8/21 class)",
              lambda: cmd_check_inventory([inv_all_absent]), 1),
        _case("check-inventory: absent key on disabled row is normal",
              lambda: cmd_check_inventory([inv_mixed_absent]), 0),
        _case("check-inventory: empty data[]",
              lambda: cmd_check_inventory([inv_empty]), 1),
        _case("check-inventory: tool-result preamble skipped",
              lambda: cmd_check_inventory([inv_preamble]), 0),
        _case("check-staged: expect within tolerance",
              lambda: cmd_check_staged([inv_good, "--expect", "2",
                                        "--tolerance", "2"]), 0),
        _case("check-staged: expect deviation beyond tolerance",
              lambda: cmd_check_staged([inv_good, "--expect", "39",
                                        "--tolerance", "2"]), 1),
        _case("roster: refuses zero-enabled inventory",
              lambda: cmd_roster([inv_zero_enabled, "-o",
                                  os.path.join(tmp, "ro.json")]), 1),
        _case("roster: writes from healthy inventory",
              lambda: cmd_roster([inv_good, "-o",
                                  os.path.join(tmp, "ro.json")]), 0),
        _case("receipt: canonical shape passes",
              lambda: cmd_receipt([receipt_good, "--roster", inv_good,
                                   "--filename",
                                   "trig_01WwPRWGUiFA4M1uB3aHoCCa."
                                   "20260824T1545Z.json"]), 0),
        _case("receipt: placeholder id refused",
              lambda: cmd_receipt([receipt_invented]), 1),
        _case("receipt: invented id refused against roster",
              lambda: cmd_receipt([receipt_phantom, "--roster", inv_good]), 1),
        _case("receipt: 28-byte class refused",
              lambda: cmd_receipt([receipt_tiny]), 1),
        _case("receipt: shell substitution refused",
              lambda: cmd_receipt([receipt_shell]), 1),
        _case("receipt: unknown status refused",
              lambda: cmd_receipt([receipt_badstatus]), 1),
        _case("receipt: wrong filename refused",
              lambda: cmd_receipt([receipt_good, "--filename",
                                   "trig_wrong.20260824T1545Z.json"]), 1),
    ]
    print("SELFTEST: %d/%d pass" % (sum(results), len(results)))
    return 0 if all(results) else 1


# ---------------------------------------------------------------- driver ----

def _opt_int(argv, flag, default):
    return int(argv[argv.index(flag) + 1]) if flag in argv else default


def _opt_str(argv, flag, default):
    return argv[argv.index(flag) + 1] if flag in argv else default


COMMANDS = {"check-inventory": cmd_check_inventory,
            "check-staged": cmd_check_staged,
            "roster": cmd_roster,
            "receipt": cmd_receipt,
            "selftest": cmd_selftest}


def main(argv):
    if len(argv) < 2 or argv[1] not in COMMANDS:
        print(__doc__)
        return 2
    return COMMANDS[argv[1]](argv[2:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
