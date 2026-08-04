from pathlib import Path

path = Path('src/Sirk.Central/Portals/PortalTunnelModule.cs')
text = path.read_text(encoding='utf-8')
old = '''            "location",
            "etag",
            "last-modified"
'''
new = '''            "location",
            "etag",
            "last-modified",
            "x-sirk-sequence",
            "x-sirk-metadata"
'''
if old not in text:
    raise SystemExit('Tunnel response header allowlist marker was not found.')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
