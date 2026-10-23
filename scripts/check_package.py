"""Validate release metadata, icon and archive without third-party dependencies."""
from pathlib import Path
import json
import struct
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
package = json.loads((root / "package.json").read_text(encoding="utf-8"))
assert manifest["name"] == package["name"] == "siyuan-translation"
assert manifest["version"] == package["version"]
assert manifest["author"] == "wave789"
assert manifest["url"] == "https://github.com/wave789/siyuan-translation"
assert manifest["disabledInPublish"] is True
icon = (root / manifest["icon"]).read_bytes()
assert icon[:8] == b"\x89PNG\r\n\x1a\n"
assert struct.unpack(">II", icon[16:24]) == (160, 160)
assert len(icon) <= 64 * 1024
expected = {"index.js", "index.css", "plugin.json", "README.md", "LICENSE", "icon.png", "img.png", "i18n/en.json", "i18n/zh-CN.json"}
with zipfile.ZipFile(root / "dist/package.zip") as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == expected
    for name in expected:
        assert archive.read(name) == (root / name).read_bytes(), name
    assert b'require("./core")' not in archive.read("index.js")
print("Release checks passed: metadata, icon size, archive contents, no settings/secrets packaged.")
