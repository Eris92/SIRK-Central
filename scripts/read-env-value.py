#!/usr/bin/env python3
"""Read one simple dotenv value without executing the file as shell code."""

from __future__ import annotations

import re
import sys
from pathlib import Path

KEY_PATTERN = re.compile(r"^[A-Z_][A-Z0-9_]*$")


def read_value(file_path: Path, key: str) -> str:
    if not KEY_PATTERN.fullmatch(key):
        raise ValueError("Environment key is invalid.")

    matches: list[str] = []
    for raw in file_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        current_key, raw_value = line.split("=", 1)
        if current_key.strip() != key:
            continue

        value = raw_value.strip()
        if value[:1] in {"'", '"'}:
            quote = value[0]
            if len(value) < 2 or value[-1] != quote:
                raise ValueError(f"{key} contains an unterminated quoted value.")
            value = value[1:-1]

        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError(f"{key} contains control characters.")
        if len(value) > 8192:
            raise ValueError(f"{key} is too long.")
        matches.append(value)

    if len(matches) > 1:
        raise ValueError(f"{key} is defined more than once.")
    return matches[0] if matches else ""


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: read-env-value.py <env-file> <KEY>", file=sys.stderr)
        return 2

    try:
        value = read_value(Path(sys.argv[1]), sys.argv[2])
    except (OSError, UnicodeError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
