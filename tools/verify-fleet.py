#!/usr/bin/env python3
"""
HI-DESERT LAW FLEET HEALTH VERIFIER  (verify-fleet.py)  v1.4

WHY THIS EXISTS
---------------
DJ, 2026-08-18: "Clio OneDrive sweep daily reports a failure. Did you address
this? If not create redundancy or script or whatever to catch these issues with
tasks system wide."

The sweep was not broken. It ran, wrote its artifact, and honestly reported that
its TRANSPORT was blocked. It reported that every weekday. Nothing in the fleet
noticed that the same failure had been reported N days running with nobody
owning it, because verifier-state.json keeps only the LATEST run: a finding
failing for the 40th time looks identical to one failing for the first.

This script is the missing program. It enforces three things no other check does:

  1. COVERAGE  - every ENABLED scheduled task must be registered with the
                 artifact that proves it worked. A task cannot be born
                 unmonitored.
  2. ARTIFACT  - a task is judged by its artifact, never by last_fired_at.
                 "Fired but silent" is its own failure class.
  3. AGE       - every finding carries a first-seen date, a consecutive-run
                 streak and an owner. A repeat is a MORE serious class than a
                 first occurrence, and a finding nobody has moved escalates on
                 a clock instead of repeating forever at the same volume.

Canonical home: Apps/Claude/Playbooks/Playbook-Addendum-Fleet-Health.md
Companion:      verify-rules.py (rule correctness) / verify-threads.py (threads)
This script owns FLEET HEALTH only. Do not duplicate its checks elsewhere.

INPUT (all in ./verifier-in/, fetched fresh by the calling session)
-------------------------------------------------------------------
  triggers.json                raw list_triggers output: {"data":[...]} or [...]
  fleet-artifact-registry.json the registry (canonical copy lives in Playbooks)
  fleet-artifacts.json         this run's artifact snapshot, assembled via MCP
  fleet-watch-state.json       (optional) prior run's state; created if absent

OUTPUT
------
  stdout banner in the house format; exit 1 if any FAIL, else 0.
  rewrites verifier-in/fleet-watch-state.json (caller uploads it back).

FAIL CLASS NAMING
-----------------
Every fail() message is "CLASS NAME: detail". The one-morning-email mail gate
keys on "<script>|<text up to and including the first ':'>" - do not reword an
existing class without bumping the version and saying so in the changelog.

CHANGELOG
---------
 v1.4 2026-08-24  Added the FLEET INVENTORY IMPLAUSIBLE fail-closed guard.
                  On 8/21/26 the scheduled verifier staged 41 trigger rows in
                  which 0 carried enabled:true (field-level loss in staging),
                  and v1.3 scored the empty enabled fleet as PASS/0-fails
                  while a local run of the same script on good inputs found
                  70 failures; the false PASS then clobbered
                  fleet-watch-state.json and wiped every finding's age clock.
                  v1.4 REFUSES to score an inventory whose rows are present
                  but whose enabled:true count is zero, and warns when fewer
                  than half the rows are enabled. Companion guards:
                  stage_triggers.py v1.1 (refuses to stage such a file) and
                  fleet-guard.py check-staged (independent validator). This
                  guard ADDS a failure mode and relaxes nothing.
 v1.3 2026-08-18  Added F11 SELF-REPORTS FAILURE and an explicit "missing"
                  class. F11 is the check that answers the question this
                  script was commissioned by: a task that honestly reports its
                  own failure every day was passing every artifact check in
                  the fleet.
 v1.2 2026-08-18  Added status "not_collected" -> FLEET ARTIFACT UNPROVEN, a
                  distinct class from ARTIFACT MISSING. A gap in the monitor
                  and a gap in the monitored task are different defects and
                  must never be merged into one number.
 v1.1 2026-08-18  F4 fired-but-silent compared the artifact to the PREVIOUS
                  firing instead of the current one, so a run that fired and
                  wrote nothing passed. Caught by selftest.py case 3, not by
                  reading the code. Added a grace window for runs in flight.
 v1.0 2026-08-18  First version. Checks F1-F10. Written after the Clio->OneDrive
                  mirror sweep reported the same transport failure on 8/15,
                  8/17 and 8/18 with no owner, no age and no escalation.
"""

import json
import os
import sys
import datetime as dt

VERSION = "1.4"
IN = os.environ.get("FLEET_VERIFIER_IN", "verifier-in")

FAILS, WARNS, NOTES = [], [], []


def fail(msg):
    FAILS.append(msg)


def warn(msg):
    WARNS.append(msg)


def note(msg):
    NOTES.append(msg)


# ---------------------------------------------------------------- helpers ---

def load(name, required=True, default=None):
    p = os.path.join(IN, name)
    if not os.path.exists(p):
        if required:
            fail("INPUT MISSING: %s was not staged in %s/ - a fleet check that "
                 "cannot read its input has not run, and silence here is the "
                 "exact failure this script exists to prevent" % (name, IN))
        return default
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as e:
        fail("INPUT UNREADABLE: %s could not be parsed (%s)" % (name, e))
        return default


def parse_utc(s):
    """Tolerant ISO-8601 -> aware UTC datetime. None on anything unusable."""
    if not s or not isinstance(s, str):
        return None
    t = s.strip().replace("Z", "+00:00")
    # trim over-long fractional seconds (Graph/CCR emit 6-7 digits)
    if "." in t:
        head, _, tail = t.partition(".")
        digits = ""
        rest = ""
        for i, ch in enumerate(tail):
            if ch.isdigit() and len(digits) < 6:
                digits += ch
            elif ch.isdigit():
                continue
            else:
                rest = tail[i:]
                break
        t = head + "." + (digits or "0") + rest
    try:
        d = dt.datetime.fromisoformat(t)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc)


def hours_since(d, now):
    return None if d is None else (now - d).total_seconds() / 3600.0


def business_days_between(a, b):
    """Whole weekdays from a to b. Court holidays are NOT modelled - this is a
    nudge clock, not a statutory one; never use it for a legal deadline."""
    if a is None or b is None or b < a:
        return 0
    n = 0
    cur = a.date()
    end = b.date()
    while cur < end:
        cur += dt.timedelta(days=1)
        if cur.weekday() < 5:
            n += 1
    return n


def iso(d):
    return None if d is None else d.strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------ input ---

now = parse_utc(os.environ.get("FLEET_VERIFIER_NOW")) or dt.datetime.now(dt.timezone.utc)

raw_triggers = load("triggers.json")
registry_doc = load("fleet-artifact-registry.json")
snapshot = load("fleet-artifacts.json")
prior = load("fleet-watch-state.json", required=False, default={}) or {}

triggers = []
if isinstance(raw_triggers, dict):
    triggers = raw_triggers.get("data") or []
elif isinstance(raw_triggers, list):
    triggers = raw_triggers

if raw_triggers is not None and not triggers:
    fail("INPUT MISSING: triggers.json contained no trigger rows - a stub file "
         "is worse than an absent one, because every coverage check silently "
         "passes on an empty fleet")

registry = {}
if isinstance(registry_doc, dict):
    registry = {e.get("trigger_id"): e
                for e in (registry_doc.get("entries") or [])
                if e.get("trigger_id")}

artifacts = {}
if isinstance(snapshot, dict):
    artifacts = snapshot.get("artifacts") or {}

snapshot_utc = parse_utc((snapshot or {}).get("collected_utc"))
if snapshot and snapshot_utc is None:
    fail("SNAPSHOT UNDATED: fleet-artifacts.json has no usable collected_utc - "
         "an undated snapshot cannot prove freshness of anything in it")
elif snapshot_utc is not None:
    age = hours_since(snapshot_utc, now)
    if age is not None and age > 6:
        fail("SNAPSHOT STALE: fleet-artifacts.json was collected %.1f h ago "
             "(%s); this run is scoring the fleet on yesterday's evidence"
             % (age, iso(snapshot_utc)))

prior_findings = (prior or {}).get("findings") or {}
prior_fired = (prior or {}).get("last_fired_seen") or {}

enabled = [t for t in triggers if t.get("enabled") is True]
by_id = {t.get("id"): t for t in triggers}

# fail-closed guard (v1.4): rows present but zero enabled is a staging loss,
# not a fleet state this account has ever had. A row-count tripwire cannot
# catch a field-level loss - this is the check the 8/21/26 false PASS lacked.
if triggers and not enabled:
    fail("FLEET INVENTORY IMPLAUSIBLE: triggers.json holds %d rows but 0 are "
         "enabled:true - the enabled flag was lost in staging (8/21/26 false-"
         "PASS incident class); REFUSING to score coverage, artifacts or age "
         "on it. Re-stage with stage_triggers.py v1.1+ and re-run."
         % len(triggers))
elif triggers and len(enabled) * 2 < len(triggers):
    warn("INVENTORY SKEW: only %d of %d staged rows are enabled:true - "
         "verify the staging step before trusting this run's coverage math"
         % (len(enabled), len(triggers)))

note("triggers seen: %d (enabled %d) | registry entries: %d | artifacts in "
     "snapshot: %d" % (len(triggers), len(enabled), len(registry), len(artifacts)))


# =========================================================== the checks =====
# Each check appends findings to FINDINGS with a stable key so that age and
# streak survive across runs. The key must not contain a timestamp.

FINDINGS = {}   # key -> {"class":..., "detail":..., "owner":..., "sla_days":...}


def finding(key, cls, detail, owner="chief-of-staff", sla_days=2):
    FINDINGS[key] = {"class": cls, "detail": detail, "owner": owner,
                     "sla_days": sla_days}


# ---- F1. COVERAGE: every enabled trigger is registered --------------------
for t in enabled:
    tid = t.get("id")
    if tid not in registry:
        finding("F1:" + str(tid), "FLEET COVERAGE GAP",
                "enabled trigger %s (%s) has no fleet-artifact-registry entry, "
                "so no check anywhere proves it produced anything"
                % (tid, str(t.get("name"))[:60]))

# ---- F2. STALE REGISTRY: registered trigger that no longer exists ---------
for tid, e in registry.items():
    if tid not in by_id:
        finding("F2:" + str(tid), "FLEET REGISTRY STALE",
                "registry names trigger %s (%s) which no longer resolves in "
                "the account inventory - the monitor is watching a hole"
                % (tid, str(e.get("name"))[:60]))
    elif by_id[tid].get("enabled") is not True and not e.get("expect_disabled"):
        finding("F2d:" + str(tid), "FLEET REGISTRY STALE",
                "registry expects %s (%s) to be live but the account reports it "
                "disabled; either re-enable it or set expect_disabled with a "
                "reason" % (tid, str(e.get("name"))[:60]))

# ---- F9. registry hygiene: owner + escalation clock required -------------
for tid, e in registry.items():
    missing = [k for k in ("artifact_key", "owner", "max_age_hours",
                           "escalation_after_days") if not e.get(k)]
    if missing:
        finding("F9:" + str(tid), "FLEET REGISTRY INCOMPLETE",
                "registry entry %s (%s) is missing %s - an entry without an "
                "owner and a clock is a finding that will repeat forever"
                % (tid, str(e.get("name"))[:50], ", ".join(missing)))

# ---- F3/F4/F5. the artifact checks ---------------------------------------
for tid, e in registry.items():
    t = by_id.get(tid)
    if t is None or (t.get("enabled") is not True and e.get("expect_disabled")):
        continue

    owner = e.get("owner") or "chief-of-staff"
    sla = e.get("escalation_after_days") or 2
    name = str(e.get("name") or (t or {}).get("name") or tid)[:60]
    akey = e.get("artifact_key")
    art = artifacts.get(akey) if akey else None

    fired = parse_utc(t.get("last_fired_at"))
    nextrun = parse_utc(t.get("next_run_at"))
    maxage = e.get("max_age_hours")

    # F5. enabled, overdue, never fired
    if fired is None:
        if nextrun is not None and nextrun < now - dt.timedelta(hours=1):
            finding("F5:" + tid, "FLEET NEVER FIRED",
                    "%s (%s) is enabled, its next_run_at %s is in the past and "
                    "it has never fired" % (name, tid, iso(nextrun)),
                    owner, sla)
        continue

    # weekend / out-of-cadence grace: if the task is not due yet, skip scoring
    if e.get("skip_when_not_due") and maxage and hours_since(fired, now) is not None \
            and hours_since(fired, now) > float(maxage) * 3 and nextrun and nextrun > now:
        note("%s (%s): idle outside cadence, not scored this run" % (name, tid))
        continue

    if art is None:
        finding("F3:" + tid, "FLEET ARTIFACT MISSING",
                "%s (%s) last fired %s but its artifact '%s' was not present in "
                "this run's snapshot - a run that fired and left nothing behind "
                "did not do its job" % (name, tid, iso(fired), akey),
                owner, sla)
        continue

    if art.get("status") == "missing":
        finding("F3m:" + tid, "FLEET ARTIFACT MISSING",
                "%s (%s) last fired %s but its artifact '%s' does not exist "
                "(%s)" % (name, tid, iso(fired), akey,
                          str(art.get("detail"))[:140]), owner, sla)
        continue

    if art.get("status") == "not_collected":
        finding("F3n:" + tid, "FLEET ARTIFACT UNPROVEN",
                "%s (%s): the collector did not look for artifact '%s' this "
                "run, so this task is UNPROVEN, not healthy - an uncollected "
                "artifact must never be reported as a pass (%s)"
                % (name, tid, akey, str(art.get("detail"))[:120]), owner, sla)
        continue

    if art.get("status") == "error":
        finding("F3e:" + tid, "FLEET ARTIFACT UNREADABLE",
                "%s (%s): artifact '%s' could not be read (%s)"
                % (name, tid, akey, str(art.get("detail"))[:160]), owner, sla)
        continue

    a_utc = parse_utc(art.get("last_utc"))
    if a_utc is None:
        finding("F3u:" + tid, "FLEET ARTIFACT UNDATED",
                "%s (%s): artifact '%s' has no usable timestamp, so its "
                "freshness cannot be proved" % (name, tid, akey), owner, sla)
        continue

    # F4. FIRED BUT SILENT - the trigger advanced, the artifact did not.
    # This is section 3 of the Chief of Staff charter turned into code:
    # last_fired_at advancing is NOT evidence that a run worked. A run can
    # fire, error halfway, and still stamp its timestamp.
    #   caught when: a new firing has happened since the previous check AND
    #                the artifact is older than that firing.
    #   grace:       a run in flight has not written yet, so a firing younger
    #                than grace_minutes (default 45) is not scored.
    prev_fire = parse_utc(prior_fired.get(tid))
    grace = float(e.get("grace_minutes") or 45)
    in_flight = hours_since(fired, now) is not None and \
        hours_since(fired, now) * 60.0 < grace
    if prev_fire is not None and fired > prev_fire and a_utc < fired \
            and not in_flight:
        finding("F4:" + tid, "FLEET FIRED BUT SILENT",
                "%s (%s) fired at %s (previous check saw %s) but its artifact "
                "'%s' is still dated %s - it fired and left nothing behind"
                % (name, tid, iso(fired), iso(prev_fire), akey, iso(a_utc)),
                owner, sla)
        continue

    # F3. plain staleness against the task's own cadence
    if maxage:
        age_h = hours_since(a_utc, now)
        if age_h is not None and age_h > float(maxage):
            finding("F3s:" + tid, "FLEET ARTIFACT STALE",
                    "%s (%s): artifact '%s' is %.1f h old (limit %s h), last "
                    "written %s" % (name, tid, akey, age_h, maxage, iso(a_utc)),
                    owner, sla)

    # F7. self-modifying tasks are currently a silent no-op headless
    if e.get("self_modifies"):
        warn("SELF-HEAL NO-OP: %s (%s) is declared self_modifies - headless "
             "scheduled runs on this account get 'MCP tool call requires "
             "approval' on update_trigger/create_trigger/delete_trigger, so its "
             "self-repair path does nothing and reports nothing" % (name, tid))

# ---- F11. SELF-REPORTED FAILURE ------------------------------------------
# The check that closes DJ's actual complaint (8/18/26): "Clio OneDrive sweep
# daily reports a failure. Did you address this?"
#
# The sweep was NOT broken. It ran, wrote its artifact, and honestly recorded
# "FAILED RUN - transport blocked". Every artifact check in the fleet passed it,
# because the artifact was there and fresh. A task that faithfully reports its
# own failure every weekday is invisible to a monitor that only asks whether
# the artifact exists. So: an artifact may declare its own verdict, and a
# declared failure gets a first-seen date, a streak, an owner and a clock like
# any other finding.
#
# Snapshot shape:
#   "<artifact_key>": {"last_utc": ..., "status": "ok",
#                      "self_reported": {"verdict": "FAILED"|"DEGRADED"|"OK",
#                                        "since_utc": "...", "owner": "DJ",
#                                        "detail": "one line",
#                                        "decision_utc": null}}
for tid, e in registry.items():
    t = by_id.get(tid)
    if t is None or t.get("enabled") is not True:
        continue
    art = artifacts.get(e.get("artifact_key")) or {}
    sr = art.get("self_reported") or {}
    verdict = str(sr.get("verdict") or "OK").upper()
    if verdict in ("OK", ""):
        continue
    sr_owner = sr.get("owner") or e.get("owner") or "chief-of-staff"
    sr_since = parse_utc(sr.get("since_utc"))
    key = "F11:" + tid
    if sr_since is not None and key not in prior_findings:
        # honour the artifact's own first-seen date rather than restarting the
        # clock at zero the day the monitor was built
        prior_findings[key] = {"first_seen_utc": iso(sr_since), "streak": 0,
                               "class": "TASK SELF-REPORTS FAILURE",
                               "decision_utc": sr.get("decision_utc")}
    elif sr.get("decision_utc") and key in prior_findings:
        prior_findings[key]["decision_utc"] = sr.get("decision_utc")
    finding(key, "TASK SELF-REPORTS FAILURE",
            "%s (%s) ran and wrote its artifact, but the artifact records "
            "verdict %s: %s" % (str(e.get("name"))[:60], tid, verdict,
                                str(sr.get("detail"))[:220]),
            sr_owner, e.get("escalation_after_days") or 2)

# ---- F6. structural lint on the raw inventory (advisory) ------------------
no_ctrl = []
for t in triggers:
    try:
        evs = ((t.get("job_config") or {}).get("ccr") or {}).get("events") or []
    except AttributeError:
        evs = []
    if evs and not any("message" not in (ev.get("data") or {}) for ev in evs):
        no_ctrl.append("%s (%s)" % (str(t.get("name"))[:40], t.get("id")))
if no_ctrl:
    warn("PERMISSION-EVENT ABSENT (advisory, NOT a failure): %d trigger(s) "
         "carry no set_permission_mode control event: %s. Verified 2026-08-18 "
         "by artifact that these runs still write files, Clio records and "
         "OAuth calls normally - do NOT report this to DJ as a broken task."
         % (len(no_ctrl), "; ".join(no_ctrl[:8])))

# ---- F10. sidecar drain backlog ------------------------------------------
side = (snapshot or {}).get("sidecars") or {}
if side:
    for kind, lim in (("journal", 12), ("briefing_queue", 8)):
        blk = side.get(kind) or {}
        cnt = blk.get("undrained")
        oldest = parse_utc(blk.get("oldest_utc"))
        if isinstance(cnt, int) and cnt > lim:
            finding("F10c:" + kind, "SIDECAR BACKLOG",
                    "%d undrained %s sidecars (limit %d) - a queue nobody "
                    "drains is an agent that stopped and nobody noticed"
                    % (cnt, kind, lim), "chief-of-staff", 1)
        if oldest is not None and business_days_between(oldest, now) > 2:
            finding("F10a:" + kind, "SIDECAR BACKLOG",
                    "oldest undrained %s sidecar is from %s (%d business days)"
                    % (kind, iso(oldest), business_days_between(oldest, now)),
                    "chief-of-staff", 1)


# ================================================== F8. AGE AND OWNERSHIP ===
# This is the check the fleet did not have. A finding is not just true or
# false - it has a birthday, a streak and an owner, and a repeat is a
# different and more serious class than a first occurrence.

new_findings_state = {}
for key, f in FINDINGS.items():
    p = prior_findings.get(key) or {}
    first = parse_utc(p.get("first_seen_utc")) or now
    streak = int(p.get("streak") or 0) + 1
    age_bd = business_days_between(first, now)
    sla = int(f.get("sla_days") or 2)
    owner = f.get("owner") or "chief-of-staff"
    decided = p.get("decision_utc")

    new_findings_state[key] = {
        "class": f["class"], "owner": owner, "sla_days": sla,
        "first_seen_utc": iso(first), "last_seen_utc": iso(now),
        "streak": streak, "age_business_days": age_bd,
        "decision_utc": decided, "detail": f["detail"][:400],
    }

    age_tag = ("FIRST SEEN THIS RUN" if streak == 1 else
               "seen %d runs running, first %s, %d business day(s) old"
               % (streak, iso(first), age_bd))

    line = "%s: %s [owner %s | %s]" % (f["class"], f["detail"], owner, age_tag)

    # escalation by age, not by repetition
    if decided:
        warn("PARKED (%s decided %s): %s" % (owner, decided, line))
        continue
    if age_bd >= max(sla * 2, 5) and owner not in ("DJ", "dj"):
        fail("SYSTEMIC NO VIABLE OWNER: %s has now failed for %d business days "
             "under owner '%s' with no movement - three failed revivals means "
             "the owner is wrong, not that the item is late. || %s"
             % (f["class"], age_bd, owner, line))
    elif owner in ("DJ", "dj") and age_bd >= sla:
        fail("AWAITING DJ %d DAYS: %s" % (age_bd, line))
    elif streak >= 3:
        fail("UNOWNED REPEAT: %s" % line)
    else:
        fail(line)

# findings that were open last run and are gone this run
resolved = [k for k in prior_findings if k not in FINDINGS]
for k in resolved:
    p = prior_findings[k]
    note("RESOLVED since last run: %s (%s) - was open %s run(s) from %s"
         % (p.get("class"), k, p.get("streak"), p.get("first_seen_utc")))


# ---------------------------------------------------------------- output ---
state = {
    "schema": "hi-desert-law fleet-watch-state v1",
    "version": VERSION,
    "lastRunUtc": iso(now),
    "result": "FAIL" if FAILS else "PASS",
    "failCount": len(FAILS),
    "warnCount": len(WARNS),
    "findings": new_findings_state,
    "last_fired_seen": {t.get("id"): t.get("last_fired_at")
                        for t in triggers if t.get("id")},
    "runs": ((prior or {}).get("runs") or [])[-29:] + [{
        "utc": iso(now), "fails": len(FAILS), "warns": len(WARNS),
        "open_findings": len(FINDINGS), "resolved_this_run": len(resolved),
        "triggers_seen": len(triggers), "enabled": len(enabled),
    }],
}

try:
    os.makedirs(IN, exist_ok=True)
    with open(os.path.join(IN, "fleet-watch-state.json"), "w",
              encoding="utf-8") as fh:
        json.dump(state, fh, indent=1)
except Exception as e:                                   # pragma: no cover
    fail("STATE UNWRITABLE: fleet-watch-state.json could not be written (%s) - "
         "without it every finding is born new again next run and the age "
         "clock never starts" % e)

bar = "=" * 60
print(bar)
print("HI-DESERT LAW FLEET HEALTH VERIFIER v%s - %s"
      % (VERSION, now.strftime("%Y-%m-%d %H:%M UTC")))
for n in NOTES:
    print("NOTE: " + n)
for f in FAILS:
    print("FAIL: " + f)
for w in WARNS:
    print("WARN: " + w)
print("RESULT: %s (%d fail / %d warn / %d open findings / %d resolved)"
      % ("FAIL - REFUSING TO PASS" if FAILS else "PASS",
         len(FAILS), len(WARNS), len(FINDINGS), len(resolved)))
print(bar)

sys.exit(1 if FAILS else 0)
