#!/usr/bin/env python3
"""Compile private, proofread manifests or a browser backup into D1 import SQL."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import sys

SECTION_FIELDS = (
    "id", "parent_id", "kind", "number", "title", "position", "body",
    "print_from", "print_to", "print_label", "source_file", "source_from",
    "source_to", "status", "published", "deleted", "revision", "action",
    "created_at", "updated_at",
)
ASSET_FIELDS = (
    "id", "section_id", "mime", "caption", "alt", "source_file", "source_page",
    "print_page", "byte_size", "deleted", "created_at",
)
PARENT_KINDS = {
    "chapter": {None}, "section": {"chapter"}, "subsection": {"section"},
    "exercises": {"chapter", None}, "symbols": {None}, "bibliography": {None},
    "frontmatter": {None},
}
IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9_-]{0,71}\Z")
STATES = {"missing", "draft", "review", "verified"}
BACKUP = "nlp-textbook-backup/v1"
CHUNK_SIZE = 32768


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sql(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError("SQL data must be text, integers or null")
    return "'" + value.replace("'", "''") + "'"


def sql_insert(table, fields, data, expressions=None, verb="INSERT"):
    expressions = expressions or {}
    return (
        f"{verb} INTO {table} ({','.join(fields)}) VALUES ("
        + ",".join(expressions[key] if key in expressions else sql(data.get(key)) for key in fields)
        + ");"
    )


def validate_id(identifier):
    if not isinstance(identifier, str) or IDENTIFIER.fullmatch(identifier) is None:
        raise ValueError("Invalid identifier")
    return identifier


def order_sections(sections, external_parents):
    pending = dict(sections)
    emitted = dict(external_parents)
    while pending:
        batch = [key for key, row in pending.items()
                 if row.get("parent_id") is None or row["parent_id"] in emitted]
        if not batch:
            raise ValueError("Parent is missing or cyclic: " + ", ".join(pending))
        for key in batch:
            row = pending.pop(key)
            parent_kind = emitted.get(row.get("parent_id"))
            if row.get("kind") not in PARENT_KINDS or parent_kind not in PARENT_KINDS[row["kind"]]:
                raise ValueError("Invalid parent or kind: " + key)
            emitted[key] = row["kind"]
            yield row


def merge_manifests(paths):
    sections, assets = {}, []
    for path in paths:
        data = read_json(path)
        if data.get("format") or not isinstance(data.get("sections"), list):
            raise ValueError("Expected a content manifest: " + path.name)
        for row in data["sections"]:
            identifier = validate_id(row.get("id"))
            if identifier in sections and set(row).intersection({"kind", "parent_id", "title", "position", "number"}):
                raise ValueError("Repeated structural record: " + identifier)
            if set(row).difference(SECTION_FIELDS):
                raise ValueError("Unexpected section fields: " + identifier)
            sections[identifier] = {**sections.get(identifier, {}), **row}
        for asset in data.get("assets", []):
            relative = Path(asset["file"])
            file = (path.parent / relative).resolve()
            if relative.is_absolute() or not file.is_relative_to(path.parent.resolve()):
                raise ValueError("Asset file must be under the manifest directory")
            if not 0 < file.stat().st_size <= 1_500_000:
                raise ValueError("Asset exceeds 1.5 MB. Resize or split it: " + asset["id"])
            assets.append((asset, file.read_bytes()))
    return sections, assets


def read_backup(path):
    data = read_json(path)
    if data.get("format") != BACKUP:
        raise ValueError("Unsupported backup format")
    sections, assets, history = {}, [], []
    for entry in data["entries"]:
        row = entry["section"]
        key = validate_id(row.get("id"))
        if key in sections:
            raise ValueError("Duplicate section in backup: " + key)
        sections[key] = row
        for asset in entry["assets"]:
            assets.append((asset, base64.b64decode(asset["data_base64"], validate=True)))
        versions = []
        for revision in entry["history"]:
            snapshot = revision["snapshot"]
            if snapshot["id"] != key or snapshot["revision"] != revision["revision"]:
                raise ValueError("Invalid revision snapshot: " + key)
            versions.append(revision["revision"])
            history.append({**revision, "section_id": key})
        if sorted(versions) != list(range(1, row["revision"] + 1)):
            raise ValueError("Incomplete revision history: " + key)
    return data["book"], sections, assets, history


def mime_of(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def write_data(handle, book, sections, assets, history, external_parents):
    def write(statement):
        if len(statement.encode("utf-8")) >= 95_000:
            raise ValueError("Statement exceeds safe D1 import length")
        handle.write(statement + "\n")

    def large_text(key, text):
        if len(text.encode("utf-8")) < 15_000:
            return sql(text)
        for part, start in enumerate(range(0, len(text), 8_000)):
            write(f"INSERT INTO nlp_import_text VALUES ({sql(key)}, {part}, {sql(text[start:start + 8000])});")
        return f"(SELECT group_concat(piece, '') FROM (SELECT piece FROM nlp_import_text WHERE key = {sql(key)} ORDER BY part))"

    write("CREATE TABLE IF NOT EXISTS nlp_import_text (key TEXT NOT NULL, part INTEGER NOT NULL, piece TEXT NOT NULL, PRIMARY KEY(key, part));")
    if book:
        write(f"UPDATE book SET title={sql(book['title'])},language={sql(book['language'])} WHERE id=1;")
    for row in order_sections(sections, external_parents):
        row = {
            "number": "", "published": 1, "deleted": 0, "revision": 1, "action": "import",
            "body": "", "status": "missing", **row,
        }
        body = row["body"]
        if (not isinstance(body, str) or len(body.encode("utf-16-le")) // 2 > 120_000
                or row["status"] not in STATES
                or (row["status"] == "missing") != (not body.strip())
                or not isinstance(row.get("title"), str) or not row["title"].strip()
                or type(row.get("position")) is not int or not 0 <= row["position"] <= 1_000_000):
            raise ValueError("Invalid title, order, status or body: " + row["id"])
        fields = tuple(key for key in SECTION_FIELDS if key in row)
        write(sql_insert("sections", fields, row, {"body": large_text("section-" + row["id"], body)}))

    seen_assets = set()
    for row, data in assets:
        asset_id = validate_id(row.get("id"))
        owner = validate_id(row.get("section_id"))
        if asset_id in seen_assets or owner not in sections:
            raise ValueError("Repeated asset or missing owner: " + asset_id)
        seen_assets.add(asset_id)
        if not 0 < len(data) <= 1_500_000 or not mime_of(data) or mime_of(data) != row.get("mime"):
            raise ValueError("Invalid asset size or MIME: " + asset_id)
        if not isinstance(row.get("alt"), str) or not row["alt"].strip():
            raise ValueError("Missing alternative text: " + asset_id)
        if "byte_size" in row and row["byte_size"] != len(data):
            raise ValueError("Backup image size does not match: " + asset_id)
        row = {"deleted": 0, "caption": "", **row, "byte_size": len(data)}
        fields = tuple(key for key in ASSET_FIELDS if key in row)
        write(sql_insert("assets", fields, row))
        for part, start in enumerate(range(0, len(data), CHUNK_SIZE)):
            hex_bytes = data[start:start + CHUNK_SIZE].hex()
            write(f"INSERT INTO asset_chunks VALUES ({sql(asset_id)}, {part}, X'{hex_bytes}');")

    for row in history:
        fields = ("section_id", "revision", "updated_at", "action", "snapshot")
        snapshot = json.dumps(row["snapshot"], ensure_ascii=False, separators=(",", ":"))
        key = f"revision-{row['section_id']}-{row['revision']}"
        write(sql_insert("revisions", fields, row, {"snapshot": large_text(key, snapshot)}, "INSERT OR REPLACE"))
    write("DROP TABLE nlp_import_text;")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifests", type=Path, nargs="*")
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--existing-parent", action="append", default=[], metavar="ID:KIND",
                        help="Add a new child under an already registered chapter or section")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if bool(args.backup) == bool(args.manifests) or (args.backup and args.existing_parent):
        parser.error("Use either content manifests or --backup")
    external = {}
    try:
        for pair in args.existing_parent:
            identifier, kind = pair.split(":", 1)
            external[validate_id(identifier)] = kind
        if args.backup:
            book, sections, assets, history = read_backup(args.backup)
        else:
            sections, assets = merge_manifests(args.manifests)
            book, history = None, []
        if set(external).intersection(sections):
            raise ValueError("Existing parent IDs also occur in the import")
        output = args.output
        temporary = output.with_name(output.name + ".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                write_data(handle, book, sections, assets, history, external)
            if output.exists():
                raise FileExistsError("Output exists. Choose a new output path")
            temporary.rename(output)
        finally:
            temporary.unlink(missing_ok=True)
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(error, file=sys.stderr)
        return 2
    print(f"{len(sections)} sections, {len(assets)} assets, {len(history)} historical revisions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
