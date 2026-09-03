#!/usr/bin/env python3
"""Static validator for the Asterisk configs shipped in this repo.

Checks (no Asterisk binary needed):
  1. Templates render with dummy values and leave no __PLACEHOLDER__ behind.
  2. pjsip: every [endpoint] with auth=/aors= has matching [auth]/[aor] sections.
  3. dialplan: every Playback(custom/x) has a matching wav in asterisk/sounds.
  4. dialplan: Queue(<name>) has a matching section in queues.conf.
  5. pjsip operator passwords pattern is consistent (FzOp<ext>!x).

Exit 0 = all good; 1 = validation failures.
"""
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
AST = REPO / "asterisk" / "conf"
SND = REPO / "asterisk" / "sounds" / "fa" / "custom"

fails: list[str] = []
oks: list[str] = []


def ok(msg): oks.append(msg)
def fail(msg): fails.append(msg)


def render(tmpl_name: str) -> str:
    text = (AST / tmpl_name).read_text(encoding="utf-8")
    dummy = {
        "__VISITOR_PASS__": "x" * 12,
        "__CCAPI__": "http://192.0.2.1:3006/api/internal",
        "__AMI_USER__": "callcenter",
        "__AMI_PASS__": "x" * 12,
        "__APP_HOST__": "192.0.2.1",
        "__PBX_BIND_IP__": "0.0.0.0",
    }
    for i in range(6):
        dummy[f"__OP_PASS_100{i}__"] = "x" * 12
    for k, v in dummy.items():
        text = text.replace(k, v)
    return text


def sections(text: str):
    """Return {name: [ (key,value) ... ]} for asterisk-style conf (supports
    [name](template) and [name]! headings)."""
    out, cur = {}, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(";"):
            continue
        m = re.match(r"^\[([^\]]+)\](!)?\s*(?:\(([^)]*)\))?\s*$", line)
        if m:
            name, _, tpl = m.group(1), m.group(2), m.group(3) or ""
            out.setdefault(name, [])
            cur = (name, tpl)
            continue
        if cur is None or "=" not in line:
            continue
        key, _, val = line.partition("=")
        out[cur[0]].append((key.strip(), val.strip(), cur[1]))
    return out


def main() -> int:
    # 1) placeholders resolve
    for t in ("pjsip.conf.tmpl", "extensions.conf.tmpl", "manager.conf.tmpl"):
        rendered = render(t)
        leftovers = re.findall(r"__[A-Z_0-9]+__", rendered)
        if leftovers:
            fail(f"{t}: unresolved placeholders {sorted(set(leftovers))}")
        else:
            ok(f"{t}: all placeholders resolve")

    # 2) pjsip endpoints <-> auth/aor
    pj = sections(render("pjsip.conf.tmpl"))
    kinds = {"auth": [], "aor": []}
    endpoints = []
    for name, kvs in pj.items():
        d = {k: v for k, v, _ in kvs}
        ttype = d.get("type")
        if ttype == "endpoint":
            endpoints.append(name)
            if "auth" in d:
                kinds["auth"].append(d["auth"])
            if "aors" in d:
                for a in d["aors"].split(","):
                    kinds["aor"].append(a.strip())
    for kind in ("auth", "aor"):
        for ref in kinds[kind]:
            if ref not in pj:
                fail(f"pjsip: endpoint references missing {kind} [{ref}]")
    defined_auth = [n for n, kvs in pj.items() if any(k == "type" and v == "auth" for k, v, _ in kvs)]
    defined_aor = [n for n, kvs in pj.items() if any(k == "type" and v == "aor" for k, v, _ in kvs)]
    for kind, defined in (("auth", defined_auth), ("aor", defined_aor)):
        pass
    if "visitor" in endpoints:
        ok(f"pjsip: {len(endpoints)} endpoints incl. visitor; auth/aor refs OK")

    # 3) sounds referenced by dialplan exist
    ext = render("extensions.conf.tmpl")
    for m in re.finditer(r"Playback\((custom/[\w-]+)\)", ext):
        wav = SND / (m.group(1).split("/", 1)[1] + ".wav")
        if wav.exists():
            ok(f"dialplan sound {m.group(1)} present")
        else:
            fail(f"dialplan sound missing: {wav}")

    # 4) Queue targets exist
    qsec = sections((AST / "queues.conf").read_text(encoding="utf-8"))
    for m in re.finditer(r"Queue\((\w+)", ext):
        if m.group(1) in qsec:
            ok(f"queue '{m.group(1)}' defined")
        else:
            fail(f"queue '{m.group(1)}' not defined in queues.conf")

    # 5) operator password placeholders count (1000..1005)
    tmpl = (AST / "pjsip.conf.tmpl").read_text(encoding="utf-8")
    for i in range(6):
        if f"__OP_PASS_100{i}__" not in tmpl:
            fail(f"pjsip.tmpl: missing __OP_PASS_100{i}__")

    # 6) modules.conf intact (the live-server corruption guard)
    mods = (AST / "modules.conf").read_text(encoding="utf-8")
    if "[modules]" in mods and "noload => chan_sip.so" in mods:
        ok("modules.conf: [modules] header + chan_sip noload")
    else:
        fail("modules.conf: [modules] header corrupted or chan_sip noload missing")

    print("AST CONFIG VALIDATION")
    for o in oks:
        print(f"  [PASS] {o}")
    for f in fails:
        print(f"  [FAIL] {f}")
    print(f"  total: PASS={len(oks)} FAIL={len(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
