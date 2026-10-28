#!/usr/bin/env python3
"""Make sure the Cloudflare Pages project exists and keeps every binding and
variable the site needs - without ever deleting or recreating the project, so
the address https://singvaza.pages.dev is preserved.

Idempotent: run it as often as you like. It only PATCHes the fields below and
leaves everything else in deployment_configs untouched.

Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and optionally
     D1_DATABASE_ID, TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY,
     MODEL_R2_BUCKET (set to "" to skip the R2 binding).
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]
PROJECT = os.environ.get("PAGES_PROJECT", "singvaza")
DB_ID = os.environ.get("D1_DATABASE_ID", "88b28623-1da8-42ff-8b52-479097f44650")
# The site key is public - it is printed into every page - so it is safe to keep
# here as the default. The secret is never in this file.
SITE_KEY = os.environ.get("TURNSTILE_SITE_KEY", "0x4AAAAAAFniOJ4h6ZeO8qhC").strip()
SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY", "").strip()
R2_BUCKET = os.environ.get("MODEL_R2_BUCKET", "singvaza-models")


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}/accounts/{ACCOUNT}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read() or b"{}")
        except Exception:
            return err.code, {"success": False, "errors": [{"message": str(err)}]}


def main():
    status, body = call("GET", f"/pages/projects/{PROJECT}")
    if status == 404:
        print(f"project {PROJECT} is missing - creating it (same name, so the address is unchanged)")
        status, body = call("POST", "/pages/projects", {"name": PROJECT, "production_branch": "main"})
        if not body.get("success"):
            print("could not create the project:", body)
            return 1
        status, body = call("GET", f"/pages/projects/{PROJECT}")
    if not body.get("success"):
        print("cannot read the project:", json.dumps(body)[:400])
        return 1

    project = body["result"]
    print(f"project: {project['name']}  ({project.get('subdomain')})")

    configs = project.get("deployment_configs") or {}

    # A binding to a bucket that does not exist makes the whole deployment fail,
    # so only bind R2 once the bucket is really there.
    r2_ready = False
    if R2_BUCKET:
        status, listing = call("GET", "/r2/buckets")
        names = [b.get("name") for b in (listing.get("result") or {}).get("buckets", [])] if listing.get("success") else []
        r2_ready = R2_BUCKET in names
        if not r2_ready and listing.get("success"):
            print(f"R2 bucket {R2_BUCKET} is missing - creating it")
            status, created = call("POST", "/r2/buckets", {"name": R2_BUCKET})
            r2_ready = bool(created.get("success"))
            if not r2_ready:
                print("  could not create the bucket (token needs Workers R2 Storage: Edit):", json.dumps(created)[:200])
        elif not listing.get("success"):
            print("  cannot list R2 buckets - leaving the R2 binding alone")
    wanted_r2 = {"MODEL_BUCKET": {"name": R2_BUCKET}} if r2_ready else {}
    patch = {}
    for env_name in ("production", "preview"):
        current = configs.get(env_name) or {}
        env_vars = dict(current.get("env_vars") or {})
        if SITE_KEY:
            env_vars["TURNSTILE_SITE_KEY"] = {"type": "plain_text", "value": SITE_KEY}
        if SECRET_KEY:
            env_vars["TURNSTILE_SECRET_KEY"] = {"type": "secret_text", "value": SECRET_KEY}
        d1 = dict(current.get("d1_databases") or {})
        if DB_ID:
            d1["DB"] = {"id": DB_ID}
        r2 = dict(current.get("r2_buckets") or {})
        if r2_ready:
            r2.update(wanted_r2)
        else:
            r2.pop("MODEL_BUCKET", None)
        # Always send r2_buckets, even when empty: an omitted key means "leave
        # the old binding alone", and a stale binding to a missing bucket makes
        # every deployment fail.
        patch[env_name] = {"env_vars": env_vars, "d1_databases": d1, "r2_buckets": r2}
        r2_state = f"MODEL_BUCKET -> {R2_BUCKET}" if r2_ready else "skipped (bucket not ready)"
        print(f"  {env_name}: D1={'yes' if DB_ID else 'no'}  "
              f"site_key={'set' if SITE_KEY else 'MISSING'}  "
              f"secret_key={'set' if SECRET_KEY else 'MISSING (dashboard only)'}  R2={r2_state}")

    status, body = call("PATCH", f"/pages/projects/{PROJECT}", {"deployment_configs": patch})
    if not body.get("success"):
        print("PATCH failed:", json.dumps(body)[:600])
        print("  (the deployment can still work - bindings may need a manual check)")
        return 0
    print("bindings + variables saved")
    return 0


if __name__ == "__main__":
    sys.exit(main())
