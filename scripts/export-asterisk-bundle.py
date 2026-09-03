#!/usr/bin/env python3
"""Export the configured Asterisk installation from dev85 (192.168.100.85)
as a deployable external bundle:

  asterisk-configured-bundle-<ver>-<date>.tar.gz
    ├─ manifest.json            (versions, file list + sha256, origin)
    ├─ install-bundle.sh        (deploys onto a target PBX: backs up + copies)
    ├─ etc-asterisk/*.conf      (8 callcenter-relevant configs, exact deployed state)
    ├─ sounds/                  (Persian IVR wav files under fa/custom/)
    └─ README-bundle.md

Output: /home/z/my-project/download/<bundle>.tar.gz (+ .sha256)
Also a copy at /home/z/my-project/callcenter-web/asterisk/bundle/ for release upload.
"""
import hashlib
import json
import os
import posixpath
import stat
import sys
import tarfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts"))
try:
    from ssh_run import dev85_client
except ImportError:
    sys.path.insert(0, "/home/z/my-project/scripts")
    from ssh_run import dev85_client  # noqa: E402

CONF_FILES = ["pjsip.conf", "extensions.conf", "manager.conf", "queues.conf",
              "rtp.conf", "http.conf", "cdr.conf", "logger.conf"]
SOUNDS_DIR = "/usr/share/asterisk/sounds/fa/custom"
OUT_DIR = "/home/z/my-project/download"
BUNDLE_DIR = "/home/z/my-project/callcenter-web/asterisk/bundle"


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main():
    c = dev85_client()
    sftp = c.open_sftp()
    try:
        # ---- read asterisk version ----
        _, out, _ = c.exec_command("/usr/sbin/asterisk -V 2>/dev/null || asterisk -V")
        ast_ver = out.read().decode().strip() or "Asterisk unknown"
        print("PBX:", ast_ver)

        os.makedirs(os.path.join(BUNDLE_DIR, "etc-asterisk"), exist_ok=True)
        os.makedirs(os.path.join(BUNDLE_DIR, "sounds", "fa", "custom"), exist_ok=True)

        files = []
        # ---- configs ----
        for f in CONF_FILES:
            remote = posixpath.join("/etc/asterisk", f)
            try:
                st = sftp.stat(remote)
                if not stat.S_ISREG(st.st_mode):
                    continue
                data = sftp.open(remote, "rb").read()
            except IOError:
                print(f"  skip (missing): {remote}")
                continue
            open(os.path.join(BUNDLE_DIR, "etc-asterisk", f), "wb").write(data)
            files.append({"path": f"etc-asterisk/{f}", "source": remote,
                          "bytes": len(data), "sha256": sha256_bytes(data)})
            print(f"  conf: {f} ({len(data)} B)")

        # ---- sounds ----
        try:
            for name in sftp.listdir(SOUNDS_DIR):
                remote = posixpath.join(SOUNDS_DIR, name)
                st = sftp.stat(remote)
                if not stat.S_ISREG(st.st_mode):
                    continue
                data = sftp.open(remote, "rb").read()
                open(os.path.join(BUNDLE_DIR, "sounds", "fa", "custom", name), "wb").write(data)
                files.append({"path": f"sounds/fa/custom/{name}", "source": remote,
                              "bytes": len(data), "sha256": sha256_bytes(data)})
                print(f"  sound: {name} ({len(data)} B)")
        except IOError:
            print("  no sounds dir on source")

        # ---- install-bundle.sh ----
        installer = """#!/usr/bin/env bash
# Deploys this pre-configured Asterisk bundle onto a target PBX.
# Usage: bash install-bundle.sh <bundle-dir> <asterisk-conf-dir> <sounds-dir>
set -Eeuo pipefail
B="${1:?bundle dir}"; AC="${2:?asterisk conf dir}"; SD="${3:?sounds dir}"
ts="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$AC" "$SD/fa/custom"
for f in "$B"/etc-asterisk/*.conf; do
  [ -f "$f" ] || continue
  [ -f "$AC/$(basename "$f")" ] && cp -a "$AC/$(basename "$f")" "$AC/$(basename "$f").pre-bundle-$ts"
  cp "$f" "$AC/"
done
cp -r "$B/sounds/." "$SD/"
echo "[bundle] deployed $(ls "$B"/etc-asterisk/*.conf | wc -l) configs + $(ls "$B"/sounds/fa/custom/ | wc -l) sounds"
echo "[bundle] previous configs kept as *.pre-bundle-$ts"
"""
        open(os.path.join(BUNDLE_DIR, "install-bundle.sh"), "w").write(installer)
        os.chmod(os.path.join(BUNDLE_DIR, "install-bundle.sh"), 0o755)

        # ---- README ----
        readme = f"""# Pre-configured Asterisk bundle
Exact configuration deployed on the reference PBX ({ast_ver}, 192.168.100.85).
Deploy with:  `sudo bash install-bundle.sh <extracted-dir> /etc/asterisk /usr/share/asterisk/sounds`
Then: `asterisk -rx "core restart now"`
NOTE: contains live SIP/AMI secrets — keep in the private repo/release only.
"""
        open(os.path.join(BUNDLE_DIR, "README-bundle.md"), "w").write(readme)

        # ---- manifest ----
        manifest = {
            "bundle": "asterisk-configured",
            "asterisk_version": ast_ver,
            "source_host": "192.168.100.85 (firuzo dev PBX)",
            "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "files": files,
            "note": "Contains live credentials — private distribution only.",
        }
        open(os.path.join(BUNDLE_DIR, "manifest.json"), "w").write(
            json.dumps(manifest, indent=1, ensure_ascii=False))

        # ---- tarball ----
        tag = "18.10" if "18.10" in ast_ver else ast_ver.split()[-1][:5]
        date = time.strftime("%Y%m%d")
        name = f"asterisk-configured-bundle-{tag}-{date}"
        tgz = os.path.join(OUT_DIR, name + ".tar.gz")
        with tarfile.open(tgz, "w:gz") as t:
            for root, _, fns in os.walk(BUNDLE_DIR):
                for fn in sorted(fns):
                    full = os.path.join(root, fn)
                    t.add(full, arcname=os.path.join(name, os.path.relpath(full, BUNDLE_DIR)))
        print("bundle:", tgz)
    finally:
        c.close()


if __name__ == "__main__":
    main()
