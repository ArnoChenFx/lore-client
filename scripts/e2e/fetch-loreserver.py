#!/usr/bin/env python3
"""Extracts the loreserver binary from a published lore-server image, without Docker.

The image is read anonymously from GHCR. The linux/amd64 manifest digest and the digest of
every blob are checked against their content addresses before anything is extracted, so the
binary is exactly the content published under the tag.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

REGISTRY = "https://ghcr.io"
BINARY_MEMBER = "usr/local/bin/loreserver"
MANIFEST_ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)


class StripAuthOnRedirect(urllib.request.HTTPRedirectHandler):
    """Blob downloads redirect to signed storage URLs, which must not receive the registry token."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            redirected.headers.pop("Authorization", None)
        return redirected


OPENER = urllib.request.build_opener(StripAuthOnRedirect)


def registry_token(repository):
    query = urllib.parse.urlencode({"service": "ghcr.io", "scope": f"repository:{repository}:pull"})
    with urllib.request.urlopen(f"{REGISTRY}/token?{query}", timeout=60) as response:
        return json.load(response)["token"]


def open_registry(url, token, accept=None):
    headers = {"Authorization": f"Bearer {token}"}
    if accept:
        headers["Accept"] = accept
    return OPENER.open(urllib.request.Request(url, headers=headers), timeout=600)


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def read_manifest(repository, token, reference):
    with open_registry(f"{REGISTRY}/v2/{repository}/manifests/{reference}", token, MANIFEST_ACCEPT) as response:
        body = response.read()
    return json.loads(body), f"sha256:{hashlib.sha256(body).hexdigest()}"


def download_blob(repository, token, digest, destination):
    with open_registry(f"{REGISTRY}/v2/{repository}/blobs/{digest}", token) as response, open(destination, "wb") as handle:
        shutil.copyfileobj(response, handle, 1 << 20)
    actual = sha256_of(destination)
    if actual != digest:
        sys.exit(f"blob {digest} downloaded with digest {actual}; refusing to use it")


def resolve_linux_amd64(repository, token, tag):
    top, top_digest = read_manifest(repository, token, tag)
    if "manifests" not in top:
        return top, top_digest
    matches = [
        entry
        for entry in top["manifests"]
        if (entry.get("platform") or {}).get("os") == "linux"
        and (entry.get("platform") or {}).get("architecture") == "amd64"
    ]
    if len(matches) != 1:
        sys.exit(f"{repository}:{tag} ({top_digest}) has no single linux/amd64 manifest")
    manifest, manifest_digest = read_manifest(repository, token, matches[0]["digest"])
    if manifest_digest != matches[0]["digest"]:
        sys.exit(f"linux/amd64 manifest digest mismatch: {manifest_digest}")
    return manifest, manifest_digest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", default="arnochenfx/lore-server", help="GHCR repository (lowercase)")
    parser.add_argument("--tag", default="0.10.1", help="image tag")
    parser.add_argument("--expect-digest", help="required sha256 digest of the linux/amd64 manifest")
    parser.add_argument("--out", required=True, help="where to write the extracted loreserver binary")
    args = parser.parse_args()

    token = registry_token(args.image)
    manifest, manifest_digest = resolve_linux_amd64(args.image, token, args.tag)
    if args.expect_digest and manifest_digest != args.expect_digest:
        sys.exit(f"linux/amd64 manifest is {manifest_digest}, expected {args.expect_digest}")

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out_dir) as scratch:
        config_path = os.path.join(scratch, "config.json")
        download_blob(args.image, token, manifest["config"]["digest"], config_path)
        with open(config_path, encoding="utf-8") as handle:
            labels = (json.load(handle).get("config") or {}).get("Labels") or {}
        print(f"image: {args.image}:{args.tag}@{manifest_digest}")
        print(f"upstream version: {labels.get('org.opencontainers.image.version', 'unknown')}")
        print(f"upstream revision: {labels.get('org.opencontainers.image.revision', 'unknown')}")

        binary_tmp = os.path.join(scratch, "loreserver")
        found = False
        for index, layer in enumerate(manifest["layers"]):
            layer_path = os.path.join(scratch, f"layer-{index}.tar.gz")
            download_blob(args.image, token, layer["digest"], layer_path)
            with tarfile.open(layer_path, "r:*") as archive:
                for member in archive.getmembers():
                    if member.isfile() and member.name.removeprefix("./") == BINARY_MEMBER:
                        source = archive.extractfile(member)
                        with open(binary_tmp, "wb") as handle:
                            shutil.copyfileobj(source, handle, 1 << 20)
                        found = True
            os.remove(layer_path)
        if not found:
            sys.exit(f"{BINARY_MEMBER} not found in the image layers")

        os.chmod(binary_tmp, 0o755)
        os.replace(binary_tmp, args.out)
    print(f"loreserver written to {args.out}")
    print(f"sha256: {sha256_of(args.out).removeprefix('sha256:')}")


if __name__ == "__main__":
    main()
