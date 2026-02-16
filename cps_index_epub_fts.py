#!/usr/bin/env python
# -*- coding: utf-8 -*-

#  This file is part of the Calibre-Web (https://github.com/janeczku/calibre-web)
#
#  This program is free software: you can redistribute it and/or modify
#  it under the terms of the GNU General Public License as published by
#  the Free Software Foundation, either version 3 of the License, or
#  (at your option) any later version.

import argparse
import os
import sys
from types import SimpleNamespace
from datetime import datetime


path = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, path)

from cps import ub, db, config_sql, config, calibre_db, cli_param  # noqa: E402
from cps.constants import CONFIG_DIR, DEFAULT_SETTINGS_FILE  # noqa: E402
from cps.epub_fts import get_epub_fts_index  # noqa: E402
from sqlalchemy.sql.expression import func  # noqa: E402


def _default_settings_path():
    return os.path.join(CONFIG_DIR, DEFAULT_SETTINGS_FILE)


def _resolve_settings_path(path_arg):
    path_value = path_arg or _default_settings_path()
    if os.path.isdir(path_value):
        path_value = os.path.join(path_value, DEFAULT_SETTINGS_FILE)
    return path_value


def _init_configuration(settings_path):
    # Mirror the defaults that are normally set in create_app()->cli_param.init()
    cli_param.logpath = ""
    cli_param.settings_path = settings_path
    cli_param.gd_path = ""
    cli_param.certfilepath = None
    cli_param.keyfilepath = None
    cli_param.ip_address = None
    cli_param.memory_backend = None
    cli_param.dry_run = None
    cli_param.reconnect_enable = None
    cli_param.allow_localhost = None
    cli_param.user_credentials = None

    ub.init_db(settings_path)
    encrypt_key, error = config_sql.get_encryption_key(os.path.dirname(settings_path))
    config_sql.load_configuration(ub.session, encrypt_key)
    config.init_config(ub.session, encrypt_key, SimpleNamespace(
        certfilepath=None,
        keyfilepath=None,
        ip_address=None,
        logpath="",
        settings_path=settings_path
    ))
    db.CalibreDB.update_config(config, config.config_calibre_dir, settings_path)
    if error:
        print("Warning: {}".format(error))


def _render_progress_panel(processed, total, indexed, removed):
    panel = _progress_panel_lines(processed, total, indexed, removed)
    for line in panel:
        print(line)


def _progress_panel_lines(processed, total, indexed, removed):
    display_processed = min(int(processed), int(total)) if total else int(processed)
    width = 24
    done = 0
    if total:
        done = int((float(display_processed) / float(total)) * width)
    done = max(0, min(width, done))
    bar = "#" * done + "-" * (width - done)
    percent = 0.0 if not total else (float(display_processed) / float(total)) * 100.0

    border = "+--------------------------------------+"

    def fmt(content):
        return "| {:<36} |".format(content[:36])

    return [
        border,
        fmt("EPUB FTS Rebuild"),
        fmt("[{}] {:>5.1f}%".format(bar, percent)),
        fmt("processed: {:>5}/{:<5}".format(display_processed, total)),
        fmt("indexed: {:>6}  removed: {:>6}".format(indexed, removed)),
        fmt("updated: {} UTC".format(datetime.utcnow().strftime("%H:%M:%S"))),
        border,
    ]


class ProgressPanelRenderer:
    def __init__(self, stream=None):
        self.stream = stream or sys.stdout
        term = os.environ.get("TERM", "")
        self._interactive = bool(getattr(self.stream, "isatty", lambda: False)()) and term.lower() != "dumb"
        self._line_count = 0

    def render(self, processed, total, indexed, removed):
        lines = _progress_panel_lines(processed, total, indexed, removed)
        output = "\n".join(lines) + "\n"
        if self._interactive and self._line_count:
            self.stream.write("\x1b[{}F".format(self._line_count))
            self.stream.write("\x1b[J")
        self.stream.write(output)
        self.stream.flush()
        self._line_count = len(lines)

    def finish(self):
        if self._interactive and self._line_count:
            self.stream.write("\n")
            self.stream.flush()


def build_index(force_rebuild=False, show_progress=False, workers=1):
    lib_session = calibre_db.connect()
    if lib_session is None:
        raise RuntimeError("Unable to connect to calibre metadata database")
    try:
        epub_rows = (lib_session.query(db.Books.id, db.Books.path, db.Data.name)
                     .join(db.Data)
                     .filter(func.lower(db.Data.format) == "epub")
                     .all())
    finally:
        lib_session.close()
        try:
            lib_session.remove()
        except Exception:
            pass

    index = get_epub_fts_index(ub.app_DB_path)
    if force_rebuild:
        index.clear()

    renderer = ProgressPanelRenderer() if show_progress else None

    def progress_callback(processed, total, indexed, removed):
        # keep output readable on large libraries; print every 10 books and final line
        if show_progress and (processed % 10 == 0 or processed == total):
            renderer.render(processed, total, indexed, removed)

    result = index.sync_from_rows(
        epub_rows,
        config.get_book_path(),
        force=force_rebuild,
        progress_callback=progress_callback if show_progress else None,
        workers=workers,
    )
    if renderer:
        renderer.finish()
    return result, len(epub_rows), index


def _get_library_session():
    lib_session = calibre_db.connect()
    if lib_session is None:
        raise RuntimeError("Unable to connect to calibre metadata database")
    return lib_session


def _book_lookup_by_ids(book_ids):
    if not book_ids:
        return {}
    lib_session = _get_library_session()
    try:
        rows = (lib_session.query(db.Books.id, db.Books.title, db.Books.author_sort)
                .filter(db.Books.id.in_(book_ids))
                .all())
    finally:
        lib_session.close()
        try:
            lib_session.remove()
        except Exception:
            pass
    return {
        int(row[0]): {
            "title": row[1] or "",
            "author_sort": row[2] or "",
        }
        for row in rows
    }


def main():
    parser = argparse.ArgumentParser(
        description="Build or refresh EPUB full-text search index (epub_fts.db)."
    )
    parser.add_argument(
        "-p",
        "--settings",
        metavar="path",
        help="Path to Calibre-Web settings db (app.db/cw.db)."
    )
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Clear and rebuild the full EPUB text index."
    )
    parser.add_argument(
        "--stats-only",
        action="store_true",
        help="Do not index. Print current EPUB full-text index statistics only."
    )
    parser.add_argument(
        "--search",
        metavar="query",
        help="Run an EPUB full-text search query against the index and print ranked matches."
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=20,
        help="Maximum number of search results to print (default: 20)."
    )
    parser.add_argument(
        "--no-sync",
        action="store_true",
        help="Skip sync before search. Useful for fast repeated queries."
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Number of parallel EPUB extraction workers during sync/rebuild (default: 1)."
    )
    args = parser.parse_args()

    settings_path = _resolve_settings_path(args.settings)
    if not os.path.exists(settings_path):
        print("Settings database not found: {}".format(settings_path))
        return 2

    _init_configuration(settings_path)
    if not config.config_calibre_dir:
        print("Calibre library path is not configured in settings.")
        return 3

    index = get_epub_fts_index(ub.app_DB_path)
    did_sync = False
    result = {"indexed": 0, "removed": 0, "seen": 0}
    epub_total = 0
    workers = max(1, int(args.workers or 1))
    if not args.stats_only:
        should_sync = True
        if args.search and args.no_sync and not args.rebuild:
            should_sync = False
        if should_sync:
            result, epub_total, index = build_index(
                force_rebuild=args.rebuild,
                show_progress=args.rebuild,
                workers=workers,
            )
            did_sync = True

    stats = index.get_stats()

    if not args.stats_only:
        print("Sync workers: {}".format(workers))
        print("EPUB rows discovered: {}".format(epub_total))
        print("Books indexed/updated: {}".format(result["indexed"]))
        print("Index rows removed: {}".format(result["removed"]))
        print("Books seen during sync: {}".format(result["seen"]))
    print("Index database: {}".format(index.db_path))
    print("Indexed books: {}".format(stats["books_indexed"]))
    print("Indexed chunks: {}".format(stats["chunks_indexed"]))
    print("Average chunks/book: {:.2f}".format(stats["avg_chunks_per_book"]))
    print("Total indexed characters: {}".format(stats["total_indexed_characters"]))
    print("Index DB size (bytes): {}".format(stats["db_size_bytes"]))
    if stats["last_indexed_at"]:
        print("Last indexed at (UTC): {}".format(stats["last_indexed_at"]))

    if args.search:
        if not args.no_sync and not did_sync:
            sync_result, epub_total, __ = build_index(force_rebuild=False, show_progress=False, workers=workers)
            print("Synced before search: indexed={}, removed={}, seen={}".format(
                sync_result["indexed"], sync_result["removed"], sync_result["seen"]
            ))

        limit = max(1, int(args.limit))
        details = index.search_details(args.search, limit=limit)
        book_info = _book_lookup_by_ids([row["book_id"] for row in details])
        print("Search query: {}".format(args.search))
        print("Matches returned: {}".format(len(details)))
        for idx, row in enumerate(details, 1):
            meta = book_info.get(row["book_id"], {})
            title = meta.get("title", "")
            author_sort = meta.get("author_sort", "")
            if author_sort:
                print("{}. [{}] {} | {}".format(idx, row["book_id"], title, author_sort.replace("|", ", ")))
            else:
                print("{}. [{}] {}".format(idx, row["book_id"], title))
            if row["section"]:
                print("   section: {}".format(row["section"]))
            if row["snippet"]:
                print("   snippet: {}".format(row["snippet"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
