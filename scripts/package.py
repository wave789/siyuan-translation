"""Build a dependency-free SiYuan plugin and installable archive."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent.parent
core = (root / "src/core.js").read_text(encoding="utf-8")
plugin = (root / "src/plugin.js").read_text(encoding="utf-8")
bundled = plugin.replace('require("./core")', '(function () { const module = { exports: {} };\n' + core + '\nreturn module.exports; })()')
(root / "index.js").write_text(bundled, encoding="utf-8")
dist = root / "dist"
dist.mkdir(exist_ok=True)
with zipfile.ZipFile(dist / "package.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    for name in ["index.js", "index.css", "plugin.json", "README.md", "LICENSE", "icon.png", "img.png", "i18n/en.json", "i18n/zh-CN.json"]:
        archive.write(root / name, name)
print(f"Built {json.loads((root / 'plugin.json').read_text(encoding='utf-8'))['name']}: {dist / 'package.zip'}")
