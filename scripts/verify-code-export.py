"""Verify the selected code snapshot without requiring private source access."""
from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "PUBLIC-SOURCE-MANIFEST.json").read_text(encoding="utf-8"))
allowed = {entry["path"] for entry in manifest["files"]}
allowed.update({"README.md", "EXPORT-VALIDATION.md", "PUBLIC-SOURCE-MANIFEST.json", "scripts/verify-code-export.py"})
for entry in manifest["files"]:
    path = root / entry["path"]
    assert path.resolve().is_relative_to(root)
    data = path.read_bytes()
    data.decode("utf-8-sig")
    assert hashlib.sha256(data).hexdigest() == entry["exportSha256"], entry["path"]
    if not entry["adapted"]:
        assert hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() == entry["blob"], entry["path"]
tracked = set(subprocess.check_output(["git", "-C", str(root), "ls-files", "-z"]).decode().strip("\0").split("\0"))
assert tracked == allowed, {"unexpected": sorted(tracked - allowed), "missing": sorted(allowed - tracked)}
assert not any(path.startswith(("public/", "src-tauri/icons/", ".agents/")) for path in tracked)
print(f"Verified {len(manifest['files'])} imports and {len(tracked)} allowed snapshot paths.")
