# -*- coding: utf-8 -*-

#  This file is part of the Calibre-Web (https://github.com/janeczku/calibre-web)
#
#  This program is free software: you can redistribute it and/or modify
#  it under the terms of the GNU General Public License as published by
#  the Free Software Foundation, either version 3 of the License, or
#  (at your option) any later version.

import os
import posixpath
import re
import sqlite3
import threading
from datetime import datetime
from zipfile import ZipFile, BadZipFile

from lxml import etree

from . import logger

log = logger.create()

_NS = {
    'n': 'urn:oasis:names:tc:opendocument:xmlns:container',
    'pkg': 'http://www.idpf.org/2007/opf',
}

_CHUNK_SIZE = 4000
_SYNC_INTERVAL_SECONDS = 300


class EpubFTSIndex:
    def __init__(self, app_db_path):
        settings_dir = os.path.dirname(app_db_path) if app_db_path else "."
        self._db_path = os.path.join(settings_dir, "epub_fts.db")
        self._lock = threading.Lock()
        self._last_sync = 0

    @property
    def db_path(self):
        return self._db_path

    def _connect(self):
        conn = sqlite3.connect(self._db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_schema(self, conn):
        conn.execute(
            "CREATE TABLE IF NOT EXISTS epub_fts_meta ("
            "book_id INTEGER PRIMARY KEY, "
            "file_path TEXT NOT NULL, "
            "file_mtime REAL NOT NULL, "
            "file_size INTEGER NOT NULL, "
            "indexed_at TEXT NOT NULL)"
        )
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS epub_fts USING fts5("
            "book_id UNINDEXED, "
            "section, "
            "content, "
            "tokenize='porter unicode61')"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_epub_fts_meta_path ON epub_fts_meta(file_path)")
        conn.commit()

    def clear(self):
        with self._lock:
            with self._connect() as conn:
                self._init_schema(conn)
                conn.execute("DELETE FROM epub_fts")
                conn.execute("DELETE FROM epub_fts_meta")
                conn.commit()
            self._last_sync = 0

    def _build_match_query(self, term):
        tokens = [t for t in re.split(r"\s+", term) if t]
        if not tokens:
            return ""
        return " ".join('"{}"'.format(token.replace('"', '""')) for token in tokens)

    def _split_text(self, text):
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return []
        chunks = []
        start = 0
        while start < len(text):
            end = min(start + _CHUNK_SIZE, len(text))
            if end < len(text):
                split_at = text.rfind(" ", start, end)
                if split_at > start:
                    end = split_at
            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)
            start = end + 1
        return chunks

    def _extract_epub_sections(self, epub_file):
        sections = []
        try:
            with ZipFile(epub_file) as epub_zip:
                container = epub_zip.read("META-INF/container.xml")
                container_tree = etree.fromstring(container)
                opf_path = container_tree.xpath('n:rootfiles/n:rootfile/@full-path', namespaces=_NS)[0]

                opf = epub_zip.read(opf_path)
                opf_tree = etree.fromstring(opf)
                opf_dir = posixpath.dirname(opf_path)

                manifest = {}
                for item in opf_tree.xpath('//pkg:manifest/pkg:item', namespaces=_NS):
                    item_id = item.get("id")
                    if not item_id:
                        continue
                    manifest[item_id] = (item.get("href", ""), item.get("media-type", ""))

                spine = opf_tree.xpath('//pkg:spine/pkg:itemref', namespaces=_NS)
                for itemref in spine:
                    idref = itemref.get("idref")
                    if not idref or idref not in manifest:
                        continue
                    href, media_type = manifest[idref]
                    if not href:
                        continue
                    lower_href = href.lower()
                    is_html = ("html" in media_type) or lower_href.endswith((".xhtml", ".html", ".htm"))
                    if not is_html:
                        continue

                    content_path = posixpath.normpath(posixpath.join(opf_dir, href))
                    try:
                        html_content = epub_zip.read(content_path)
                    except KeyError:
                        continue

                    parser = etree.HTMLParser(recover=True)
                    tree = etree.fromstring(html_content, parser)
                    if tree is None:
                        continue

                    for node in tree.xpath("//script|//style"):
                        parent = node.getparent()
                        if parent is not None:
                            parent.remove(node)

                    section_name = None
                    for xpath in ("//title/text()", "//h1//text()", "//h2//text()"):
                        title_text = tree.xpath(xpath)
                        if title_text:
                            section_name = re.sub(r"\s+", " ", title_text[0]).strip()
                            if section_name:
                                break
                    if not section_name:
                        section_name = posixpath.basename(content_path)

                    text_content = " ".join(t.strip() for t in tree.xpath("//text()") if t and t.strip())
                    for chunk in self._split_text(text_content):
                        sections.append((section_name[:200], chunk))
        except (BadZipFile, OSError, IOError, etree.XMLSyntaxError, IndexError) as ex:
            log.debug("Unable to index EPUB '%s': %s", epub_file, ex)
        return sections

    def _reindex_book(self, conn, book_id, file_path, stat_result):
        sections = self._extract_epub_sections(file_path)
        conn.execute("DELETE FROM epub_fts WHERE book_id = ?", (book_id,))
        if sections:
            conn.executemany(
                "INSERT INTO epub_fts(book_id, section, content) VALUES(?, ?, ?)",
                [(book_id, section, content) for section, content in sections],
            )
        conn.execute(
            "INSERT OR REPLACE INTO epub_fts_meta(book_id, file_path, file_mtime, file_size, indexed_at) "
            "VALUES(?, ?, ?, ?, ?)",
            (book_id, file_path, stat_result.st_mtime, stat_result.st_size, datetime.utcnow().isoformat()),
        )

    def sync_from_rows(self, rows, base_book_path, force=False):
        now = datetime.utcnow().timestamp()
        if not force and now - self._last_sync < _SYNC_INTERVAL_SECONDS:
            return {"indexed": 0, "removed": 0, "seen": 0}

        with self._lock:
            now = datetime.utcnow().timestamp()
            if not force and now - self._last_sync < _SYNC_INTERVAL_SECONDS:
                return {"indexed": 0, "removed": 0, "seen": 0}

            with self._connect() as conn:
                self._init_schema(conn)
                existing = {
                    row[0]: row[1:]
                    for row in conn.execute(
                        "SELECT book_id, file_path, file_mtime, file_size FROM epub_fts_meta"
                    ).fetchall()
                }
                seen_ids = set()
                indexed_count = 0
                removed_count = 0

                for row in rows:
                    book_id = int(row[0])
                    book_rel_path = row[1]
                    book_name = row[2]
                    epub_path = os.path.join(base_book_path, book_rel_path, book_name + ".epub")
                    seen_ids.add(book_id)

                    try:
                        stat_result = os.stat(epub_path)
                    except OSError:
                        conn.execute("DELETE FROM epub_fts WHERE book_id = ?", (book_id,))
                        conn.execute("DELETE FROM epub_fts_meta WHERE book_id = ?", (book_id,))
                        removed_count += 1
                        continue

                    meta = existing.get(book_id)
                    if not force and meta is not None:
                        _, mtime, size = meta
                        if mtime == stat_result.st_mtime and size == stat_result.st_size:
                            continue

                    self._reindex_book(conn, book_id, epub_path, stat_result)
                    indexed_count += 1

                stale_ids = [book_id for book_id in existing if book_id not in seen_ids]
                if stale_ids:
                    conn.executemany("DELETE FROM epub_fts WHERE book_id = ?", [(book_id,) for book_id in stale_ids])
                    conn.executemany("DELETE FROM epub_fts_meta WHERE book_id = ?", [(book_id,) for book_id in stale_ids])
                    removed_count += len(stale_ids)

                conn.commit()
                self._last_sync = now
                return {"indexed": indexed_count, "removed": removed_count, "seen": len(seen_ids)}

    def search(self, term, limit=1000):
        query = strip_search_term(term)
        if not query:
            return []

        with self._lock:
            with self._connect() as conn:
                self._init_schema(conn)
                try:
                    rows = conn.execute(
                        "SELECT book_id, MIN(bm25(epub_fts)) AS rank "
                        "FROM epub_fts WHERE epub_fts MATCH ? "
                        "GROUP BY book_id ORDER BY rank LIMIT ?",
                        (query, int(limit)),
                    ).fetchall()
                except sqlite3.OperationalError:
                    fallback = self._build_match_query(term)
                    if not fallback:
                        return []
                    try:
                        rows = conn.execute(
                            "SELECT book_id, MIN(bm25(epub_fts)) AS rank "
                            "FROM epub_fts WHERE epub_fts MATCH ? "
                            "GROUP BY book_id ORDER BY rank LIMIT ?",
                            (fallback, int(limit)),
                        ).fetchall()
                    except sqlite3.OperationalError:
                        return []
        return [int(book_id) for (book_id, __) in rows]


def strip_search_term(term):
    return re.sub(r"\s+", " ", str(term or "").strip())


_instance = None
_instance_lock = threading.Lock()


def get_epub_fts_index(app_db_path):
    global _instance
    with _instance_lock:
        if _instance is None:
            _instance = EpubFTSIndex(app_db_path)
        return _instance
