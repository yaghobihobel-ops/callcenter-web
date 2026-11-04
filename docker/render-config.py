#!/usr/bin/env python3
"""Render the repository's existing templates without a shell eval or sed.

Only deployment configuration is rendered. Dialplan, queue strategy, PJSIP
accounts and panel code continue to come from the original source tree.
"""
import ipaddress
import os
from pathlib import Path
import re
import sys

ROOT = Path(os.environ.get("CC_TEMPLATE_DIR", "/opt/callcenter-templates"))


def required(name):
    value = os.environ.get(name, "")
    if not value:
        raise ValueError(f"{name} is required")
    return value


def secret(name):
    value = required(name)
    if len(value) < 16 or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError(f"{name}: use at least 16 letters, digits, hyphens or underscores")
    return value


def ip(name):
    value = required(name)
    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError as exc:
        raise ValueError(f"{name} must be an IPv4 address, not a hostname") from exc


def port(name, default):
    value = int(os.environ.get(name, default))
    if not 1 <= value <= 65535:
        raise ValueError(f"{name} must be between 1 and 65535")
    return str(value)


def render(source, destination, replacements):
    text = (ROOT / source).read_text(encoding="utf-8")
    for key, value in replacements.items():
        text = text.replace(key, str(value))
    if re.search(r"__[A-Z_0-9]+__", text):
        raise ValueError(f"unresolved placeholder in {source}")
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(destination)


def main():
    mode = sys.argv[1]
    if mode == "pbx":
        out = Path("/etc/asterisk")
        out.mkdir(parents=True, exist_ok=True)
        visitor = secret("VISITOR_SIP_PASS")
        ami_user = required("AMI_USER")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", ami_user):
            raise ValueError("AMI_USER contains unsupported characters")
        pattern = required("OP_SIP_PASS_PATTERN")
        if "{ext}" not in pattern:
            raise ValueError("OP_SIP_PASS_PATTERN must contain {ext}")
        for ext in range(1000, 1006):
            secret_value = pattern.replace("{ext}", str(ext))
            if len(secret_value) < 16 or not re.fullmatch(r"[A-Za-z0-9_-]+", secret_value):
                raise ValueError("operator passwords must be 16+ safe characters")
        replacements = {
            "__VISITOR_PASS__": visitor,
            "__AMI_USER__": ami_user,
            "__AMI_PASS__": secret("AMI_PASS"),
            "__APP_HOST__": "127.0.0.1",
            "__PBX_BIND_IP__": "0.0.0.0",
        }
        for ext in range(1000, 1006):
            replacements[f"__OP_PASS_{ext}__"] = pattern.replace("{ext}", str(ext))
        render("asterisk/pjsip.conf.tmpl", out / "pjsip.conf", replacements)
        render("asterisk/extensions.conf.tmpl", out / "extensions.conf", {
            "__CCAPI__": f"http://127.0.0.1:{port('APP_PORT', '3006')}/api/internal"
        })
        # The host-networked app connects from loopback. Restrict the existing
        # AMI template to that address rather than exposing AMI on the public NIC.
        render("asterisk/manager.conf.tmpl", out / "manager.conf", replacements)
        manager = (out / "manager.conf").read_text(encoding="utf-8")
        manager = manager.replace("bindaddr=0.0.0.0", "bindaddr=127.0.0.1")
        (out / "manager.conf").write_text(manager, encoding="utf-8")
        for name in ("queues", "rtp", "logger", "cdr", "ari", "modules"):
            text = (ROOT / "asterisk" / f"{name}.conf").read_text(encoding="utf-8")
            (out / f"{name}.conf").write_text(text, encoding="utf-8")
            (out / f"{name}.conf").chmod(0o600)
        # Replace the reference deployment's fixed LAN address. WSS is terminated
        # by nginx; this raw WS listener is only accessible on the same host.
        http = (ROOT / "asterisk/http.conf").read_text(encoding="utf-8")
        http = re.sub(r"(?m)^bindaddr=.*$", "bindaddr=127.0.0.1", http)
        (out / "http.conf").write_text(http, encoding="utf-8")
        (out / "http.conf").chmod(0o600)
        # The source queue references fa-relax. Provide a local music-on-hold
        # category using the packaged music, without changing the dialplan.
        moh = Path("/etc/asterisk/musiconhold.conf")
        moh.write_text("[general]\n[default]\nmode=files\ndirectory=/usr/share/asterisk/moh\n"
                       "[fa-relax]\nmode=files\ndirectory=/usr/share/asterisk/moh\n", encoding="utf-8")
        # Asterisk drops privileges before reading its configuration.
        for path in out.iterdir():
            if path.is_file():
                os.chown(path, 0, int(os.environ.get("CC_ASTERISK_GID", "0")))
                path.chmod(0o640)
    elif mode == "turn":
        public = ip("PUBLIC_IP")
        host = ip("CC_HOST_IP")
        domain = required("CC_DOMAIN")
        if not re.fullmatch(r"[A-Za-z0-9.-]+", domain):
            raise ValueError("CC_DOMAIN must be a hostname without scheme or path")
        user = required("TURN_USER")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", user):
            raise ValueError("TURN_USER contains unsupported characters")
        render("turnserver.conf.tmpl", "/etc/coturn/turnserver.conf", {
            "__PUBLIC_IP__": public,
            "__LAN_IP__": host,
            "__TURN_USER__": user,
            "__TURN_PASS__": secret("TURN_PASS"),
            "__REALM__": domain,
        })
        path = Path("/etc/coturn/turnserver.conf")
        text = path.read_text(encoding="utf-8").replace("log-file=/var/log/turnserver.log", "log-file=stdout")
        if public == host:
            # coturn rejects an external-ip mapping whose two sides are equal.
            text = re.sub(r"(?m)^external-ip=.*\n", "", text)
        path.write_text(text, encoding="utf-8")
    elif mode == "nginx":
        domain = required("CC_DOMAIN")
        if not re.fullmatch(r"[A-Za-z0-9.-]+", domain):
            raise ValueError("CC_DOMAIN must be a hostname without scheme or path")
        render("nginx.conf.tmpl", "/etc/nginx/conf.d/default.conf", {
            "__CC_DOMAIN__": domain,
            "__APP_HOST__": "127.0.0.1",
            "__APP_PORT__": port("APP_PORT", "3006"),
            "__PBX_HOST__": "127.0.0.1",
            "__CERT__": "/etc/nginx/tls/fullchain.pem",
            "__KEY__": "/etc/nginx/tls/privkey.pem",
        })
        path = Path("/etc/nginx/conf.d/default.conf")
        text = path.read_text(encoding="utf-8")
        text = text.replace(f"/var/log/nginx/{domain}.access.log", "/dev/stdout")
        text = text.replace(f"/var/log/nginx/{domain}.error.log", "/dev/stderr")
        # An HTTP request must not be served as a plaintext panel. Certificate
        # issuance/renewal remains external, as in the original TLS_MODE=existing.
        text += "\nserver {\n    listen 80;\n    server_name " + domain + ";\n    return 301 https://$host$request_uri;\n}\n"
        path.write_text(text, encoding="utf-8")
    else:
        raise ValueError("mode must be pbx, turn or nginx")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        sys.exit(1)
