#!/usr/bin/env python3
"""Restore the Turnstile (Cloudflare security-check) keys on the Pages project.

The site needs two variables:
    TURNSTILE_SITE_KEY    - public, looks like 0x4AAAAAAA...
    TURNSTILE_SECRET_KEY  - secret, looks like 0x4AAAAAAA...

They are read from the environment (a local shell or a GitHub secret), never
printed, and PATCHed into both the production and preview environments. The
Pages project itself is not touched otherwise, so the address and every other
setting stay exactly as they are.

Usage:
    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
    TURNSTILE_SITE_KEY=0x... TURNSTILE_SECRET_KEY=0x... \
    python3 scripts/restore_turnstile.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
PROJECT = os.environ.get("PAGES_PROJECT", "singvaza")
SITE = os.environ.get("TURNSTILE_SITE_KEY", "").strip()
SECRET = os.environ.get("TURNSTILE_SECRET_KEY", "").strip()


def call(method, path, body=None):
    req = urllib.request.Request(
        f"{API}/accounts/{ACCOUNT}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def shape(value):
    return f"{value[:6]}…{value[-4:]} ({len(value)} chars)" if value else "(missing)"


def main():
    missing = [n for n, v in (("CLOUDFLARE_API_TOKEN", TOKEN), ("CLOUDFLARE_ACCOUNT_ID", ACCOUNT),
                              ("TURNSTILE_SITE_KEY", SITE), ("TURNSTILE_SECRET_KEY", SECRET)) if not v]
    if missing:
        print("missing:", ", ".join(missing))
        return 1
    print("site key  ", shape(SITE))
    print("secret key", shape(SECRET))

    status, body = call("GET", f"/pages/projects/{PROJECT}")
    if not body.get("success"):
        print("cannot read the project:", json.dumps(body)[:300])
        return 1
    configs = body["result"].get("deployment_configs") or {}

    patch = {}
    for env_name in ("production", "preview"):
        env_vars = dict((configs.get(env_name) or {}).get("env_vars") or {})
        env_vars["TURNSTILE_SITE_KEY"] = {"type": "plain_text", "value": SITE}
        env_vars["TURNSTILE_SECRET_KEY"] = {"type": "secret_text", "value": SECRET}
        patch[env_name] = {"env_vars": env_vars}

    status, body = call("PATCH", f"/pages/projects/{PROJECT}", {"deployment_configs": patch})
    if not body.get("success"):
        print("PATCH failed:", json.dumps(body)[:400])
        return 1
    print(f"both variables saved on {PROJECT} (production + preview)")
    print("the live site picks them up on its next deployment")
    return 0


if __name__ == "__main__":
    sys.exit(main())
