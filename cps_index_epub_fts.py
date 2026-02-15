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


path = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, path)

from cps import ub, db, config_sql, config, calibre_db  # noqa: E402
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


def build_index(force_rebuild=False):
    epub_rows = (calibre_db.session.query(db.Books.id, db.Books.path, db.Data.name)
                 .join(db.Data)
                 .filter(func.lower(db.Data.format) == "epub")
                 .all())

    index = get_epub_fts_index(ub.app_DB_path)
    if force_rebuild:
        index.clear()
    result = index.sync_from_rows(epub_rows, config.get_book_path(), force=force_rebuild)
    return result, len(epub_rows), index


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
    args = parser.parse_args()

    settings_path = _resolve_settings_path(args.settings)
    if not os.path.exists(settings_path):
        print("Settings database not found: {}".format(settings_path))
        return 2

    _init_configuration(settings_path)
    if not config.config_calibre_dir:
        print("Calibre library path is not configured in settings.")
        return 3

    result, epub_total, index = build_index(force_rebuild=args.rebuild)
    print("EPUB rows discovered: {}".format(epub_total))
    print("Books indexed/updated: {}".format(result["indexed"]))
    print("Index rows removed: {}".format(result["removed"]))
    print("Books seen during sync: {}".format(result["seen"]))
    print("Index database: {}".format(index.db_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
