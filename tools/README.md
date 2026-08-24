# Fleet reliability tools

Deterministic validators for the firm's scheduled-task fleet ("degraded"-report
incident of 2026-08-24). Each is stdlib-only Python with an exit code, meant to
run inside the delivery path it guards — a fix that lives in a check, not in an
intention.

| Script | Role |
|---|---|
| `fleet-guard.py` | The redundancy layer: `check-inventory` / `check-staged` refuse a trigger inventory whose rows lost their `enabled` flags (the 8/21/26 false-PASS class); `roster` emits a ~15 KB trigger roster so tasks stop paying the ~1 MB `list_triggers` call; `receipt` validates a run receipt before upload (shape, status enum, real trigger id, minimum size, no unexpanded shell substitution). `selftest` runs 18 embedded cases. |
| `stage_triggers.py` | v1.1 of the verifier staging step: slims the raw `list_triggers` dump for the gate scripts, and now fails closed on a field-level loss (zero rows enabled, or a present-but-non-boolean `enabled`), not just on zero rows. |
| `verify-fleet.py` | v1.4 of the fleet health gate: adds the `FLEET INVENTORY IMPLAUSIBLE` hard failure — the gate refuses to score coverage on an inventory with rows but zero enabled tasks, instead of passing on an empty fleet. |

Canonical copies live in the firm's OneDrive `Apps/Claude/Playbooks/` as
`fleet-guard.py.txt`, `stage_triggers.py.txt`, `verify-fleet.py.txt` (stored as
`.txt` because the connector refuses to serve bare `.py`). The repo copies here
are the version-controlled source of truth for review and diffing; keep the two
byte-identical when either changes, and run `fleet-guard.py selftest` after any
edit.
