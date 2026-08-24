#!/usr/bin/env python3
"""
stage_triggers.py  v1.1  - Hi-Desert Law

Turns the ~1 MB raw list_triggers dump into the slim triggers.json that
verify-fleet.py and verify-rules.py read from verifier-in/.

WHY: list_triggers returns ~600 KB-1 MB, almost all of it trigger PROMPT text.
Staging the raw file is impractical, so verifier-in/triggers.json has been a
1,387-byte STUB - which means every coverage check that reads it has been
passing on an empty fleet. A stub is worse than a missing file.

This keeps every field the checks actually use, keeps the shape of the
job_config events (so control-event and prompt-section checks still work), and
replaces each prompt body with its length, a sha256, and the first 400 chars.
Result is a few tens of KB.

  python3 stage_triggers.py RAW_DUMP.json  [-o verifier-in/triggers.json]

RAW_DUMP may be the tool-result text file; leading non-JSON preamble is skipped.
Exit 0 on success, 1 on failure. Prints the row count it wrote - a run that
writes 0 rows exits 1 rather than quietly producing a stub.

v1.1 2026-08-24  FAIL CLOSED ON A FIELD-LEVEL LOSS, not just a row-level one.
                 On 8/21/26 the scheduled rules-verifier staged 41 rows in
                 which 0 carried enabled:true (the enabled flag was lost or
                 non-boolean), and verify-fleet.py v1.3 scored the empty
                 enabled fleet as PASS/0-fails while a local run of the same
                 script found 70 failures. A row-count tripwire cannot catch a
                 field-level loss. v1.1 therefore EXITS 1 when any row carries
                 a present-but-non-boolean `enabled` (the API omits the key
                 entirely on a disabled trigger - that is normal), or when 0
                 rows are enabled:true, and
                 prints the enabled count next to the row count so the calling
                 run can sanity-check it against the live account (~39 of 42
                 as of 8/24/26). Companion redundancy: fleet-guard.py
                 check-staged (canonical fleet-guard.py.txt in Playbooks).
"""
import hashlib
import json
import sys

KEEP_TOP = ("id", "name", "cron_expression", "run_once_at", "enabled",
            "next_run_at", "created_at", "updated_at", "last_fired_at",
            "ended_reason", "suspension_reason", "created_via",
            "notifications", "persistent_session_id", "model")


def slim_event(ev):
    data = dict(ev.get("data") or {})
    msg = data.get("message")
    if isinstance(msg, dict) and isinstance(msg.get("content"), str):
        body = msg["content"]
        data["message"] = {
            "role": msg.get("role"),
            "content_len": len(body),
            "content_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
            "content_head": body[:400],
        }
    out = {k: v for k, v in ev.items() if k != "data"}
    out["data"] = data
    return out


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    src = argv[1]
    dst = "verifier-in/triggers.json"
    if "-o" in argv:
        dst = argv[argv.index("-o") + 1]

    text = open(src, "r", encoding="utf-8", errors="replace").read()
    i = min([x for x in (text.find("{"), text.find("[")) if x >= 0] or [-1])
    if i < 0:
        print("FAIL: no JSON found in %s" % src)
        return 1
    doc = json.loads(text[i:])
    rows = doc.get("data") if isinstance(doc, dict) else doc
    if not rows:
        print("FAIL: 0 trigger rows parsed from %s - refusing to write a stub" % src)
        return 1

    nonbool = [str(r.get("id")) for r in rows
               if "enabled" in r and not isinstance(r["enabled"], bool)]
    if nonbool:
        print("FAIL: %d row(s) carry a non-boolean `enabled` value (%s%s) - "
              "the enabled flag was lost or mangled; refusing to stage an "
              "inventory a gate would score as an empty enabled fleet "
              "(8/21/26 false-PASS class)"
              % (len(nonbool), ", ".join(nonbool[:5]),
                 "..." if len(nonbool) > 5 else ""))
        return 1
    enabled_true = sum(1 for r in rows if r.get("enabled") is True)
    if enabled_true == 0:
        print("FAIL: %d rows parsed but 0 are enabled:true - this account has "
              "never had a zero-enabled fleet, so the dump is implausible; "
              "refusing to write it (8/21/26 false-PASS class)" % len(rows))
        return 1

    out = []
    for r in rows:
        s = {k: r.get(k) for k in KEEP_TOP if k in r}
        jc = r.get("job_config") or {}
        ccr = jc.get("ccr") or {}
        s["job_config"] = {"ccr": {"events": [slim_event(e)
                                              for e in (ccr.get("events") or [])]}}
        out.append(s)

    with open(dst, "w", encoding="utf-8") as fh:
        json.dump({"staged_from": src, "count": len(out), "data": out}, fh, indent=1)
    import os
    print("OK: wrote %d trigger rows (%d enabled:true) to %s (%d bytes)"
          % (len(out), enabled_true, dst, os.path.getsize(dst)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
