#!/usr/bin/env python3
"""Creates the E2E test users through the lore-auth-service admin API. Safe to run repeatedly.

Reads LORE_E2E_HOME/auth/auth.env and LORE_E2E_HOME/auth/users.env directly, so no password is
placed on a command line. Only usernames are printed.
"""

import json
import os
import ssl
import sys
import urllib.error
import urllib.request


def read_env(path):
    values = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
    return values


def call(method, url, context, token=None, payload=None):
    headers = {"Accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, context=context, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None


def main():
    home = os.environ["LORE_E2E_HOME"]
    auth = read_env(os.path.join(home, "auth", "auth.env"))
    users = read_env(os.path.join(home, "auth", "users.env"))
    base = f"https://{auth['HOST']}:{auth['PORT']}"
    context = ssl.create_default_context(cafile=os.path.join(home, "tls", "ca.pem"))

    status, body = call(
        "POST",
        f"{base}/auth/login",
        context,
        payload={"username": auth["ADMIN_USERNAME"], "password": auth["ADMIN_PASSWORD"]},
    )
    if status != 200 or not body:
        sys.exit(f"admin login failed with HTTP {status}; check ADMIN_PASSWORD in auth/auth.env")
    token = body["token"]

    status, listing = call("GET", f"{base}/admin/users", context, token=token)
    if status != 200 or not listing:
        sys.exit(f"listing users failed with HTTP {status}")
    existing = {user["username"] for user in listing["users"]}

    for prefix in ("ALICE", "BOB"):
        username = users[f"E2E_{prefix}_USER"]
        if username in existing:
            print(f"exists: {username}")
            continue
        status, _ = call(
            "POST",
            f"{base}/admin/users",
            context,
            token=token,
            payload={
                "username": username,
                "password": users[f"E2E_{prefix}_PASSWORD"],
                "is_admin": False,
            },
        )
        if status not in (200, 201):
            sys.exit(f"creating {username} failed with HTTP {status}")
        print(f"created: {username}")


if __name__ == "__main__":
    main()
