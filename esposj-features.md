# esposj Features

- Bulk shelf mode on home/search pages with click-to-select covers and one-shot add to shelf.
- Bulk mode UX hardening: disables details overlay/navigation, supports keyboard navigation (arrows + space), and keeps custom actions styled in green.
- Bulk actions expanded: `Select all`, `Select none`, and inline shelf creation (optional public) directly from bulk mode.
- Search enhancements for bulk workflows: hide books already in any shelf and optional one-page result mode.
- Advanced search parity: same hide-shelved and one-page toggles added to advanced results.
- EPUB full-text search (SQLite FTS5) integrated into app search with separate index database.
- EPUB FTS CLI tooling: rebuild, stats, CLI search, progress panel, and search snippets.
- EPUB index robustness/performance improvements: worker-based extraction with single-writer indexing, malformed-EPUB skip handling, and smoother rebuild progress reporting.
- Scrolling Reader (Beta) added in parallel to existing EPUB reader with separate route/UI.
- Scrolling Reader (Beta) controls include play/pause, speed controls, chapter nav, keyboard shortcuts, and persistent typography/layout/theme settings.
