#!/usr/bin/env python3
"""Validate and safely extract a SIRK Central offline backup archive."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath


class ArchiveValidationError(RuntimeError):
    pass


def safe_member_name(raw_name: str) -> tuple[str, ...]:
    if not raw_name or "\x00" in raw_name or "\\" in raw_name:
        raise ArchiveValidationError("Archive contains an unsafe path.")
    path = PurePosixPath(raw_name)
    if path.is_absolute():
        raise ArchiveValidationError("Archive contains an absolute path.")
    parts = tuple(part for part in path.parts if part not in ("", "."))
    if not parts or any(part == ".." for part in parts):
        raise ArchiveValidationError("Archive contains path traversal.")
    return parts


def validate(
    archive_path: Path,
    max_entries: int,
    max_total_bytes: int,
    max_file_bytes: int,
) -> tuple[list[tuple[tarfile.TarInfo, tuple[str, ...]]], str]:
    if not archive_path.is_file() or archive_path.stat().st_size < 1:
        raise ArchiveValidationError("Archive is missing or empty.")

    validated: list[tuple[tarfile.TarInfo, tuple[str, ...]]] = []
    names: set[tuple[str, ...]] = set()
    top_level: str | None = None
    total_bytes = 0
    required: set[str] = set()

    try:
        with tarfile.open(archive_path, mode="r:gz") as archive:
            for index, member in enumerate(archive, start=1):
                if index > max_entries:
                    raise ArchiveValidationError("Archive contains too many entries.")
                parts = safe_member_name(member.name)
                if parts in names:
                    raise ArchiveValidationError("Archive contains duplicate paths.")
                names.add(parts)

                if top_level is None:
                    top_level = parts[0]
                elif parts[0] != top_level:
                    raise ArchiveValidationError("Archive must contain exactly one top-level directory.")

                if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                    raise ArchiveValidationError("Archive contains a link, device or FIFO entry.")
                if not member.isdir() and not member.isfile():
                    raise ArchiveValidationError("Archive contains an unsupported entry type.")

                if member.isfile():
                    if member.size < 0 or member.size > max_file_bytes:
                        raise ArchiveValidationError("Archive contains an oversized file.")
                    total_bytes += member.size
                    if total_bytes > max_total_bytes:
                        raise ArchiveValidationError("Archive expands beyond the configured size limit.")

                relative = "/".join(parts[1:])
                if relative in {".env", "commit.txt"}:
                    required.add(relative)
                if len(parts) >= 2 and parts[1] == "data":
                    required.add("data")
                validated.append((member, parts))
    except (tarfile.TarError, OSError) as exc:
        raise ArchiveValidationError(f"Archive cannot be read: {exc}") from exc

    if not top_level or not {".env", "commit.txt", "data"}.issubset(required):
        raise ArchiveValidationError("Archive does not contain the required SIRK Central structure.")
    return validated, top_level


def safe_extract(
    archive_path: Path,
    destination: Path,
    validated: list[tuple[tarfile.TarInfo, tuple[str, ...]]],
) -> None:
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    destination_root = destination.resolve()
    try:
        with tarfile.open(archive_path, mode="r:gz") as archive:
            for member, parts in validated:
                target = destination.joinpath(*parts)
                resolved_parent = target.parent.resolve()
                if resolved_parent != destination_root and destination_root not in resolved_parent.parents:
                    raise ArchiveValidationError("Archive extraction escaped the destination.")
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    os.chmod(target, 0o700)
                    continue

                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if target.exists():
                    raise ArchiveValidationError("Archive extraction encountered a duplicate target.")
                source = archive.extractfile(member)
                if source is None:
                    raise ArchiveValidationError("Archive regular file has no data stream.")
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    with os.fdopen(descriptor, "wb", closefd=True) as output:
                        shutil.copyfileobj(source, output, length=1024 * 1024)
                        output.flush()
                        os.fsync(output.fileno())
                finally:
                    source.close()
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--extract-to", type=Path)
    parser.add_argument("--max-entries", type=int, default=200_000)
    parser.add_argument("--max-total-bytes", type=int, default=100 * 1024**3)
    parser.add_argument("--max-file-bytes", type=int, default=20 * 1024**3)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        validated, top_level = validate(
            args.archive,
            max_entries=max(100, min(args.max_entries, 1_000_000)),
            max_total_bytes=max(1024**2, args.max_total_bytes),
            max_file_bytes=max(1024**2, args.max_file_bytes),
        )
        if args.extract_to:
            safe_extract(args.archive, args.extract_to, validated)
        print(top_level)
        return 0
    except ArchiveValidationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
