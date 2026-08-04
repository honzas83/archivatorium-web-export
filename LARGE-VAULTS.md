# Large Vault Exports

Archivatorium Web Export uses the server-backed multi-file format for every
export. Do not use the combined single-file format, because that format must
embed binary attachments in memory.

## Recommended Settings

- Keep `Inline media` disabled.
- Keep `Combine as single file` disabled.
- Enable `Search Bar`.
- `Server-side full-text search` is always enabled.
- RSS is disabled.
- Keep the default search endpoint `/api/search`.
- Run the exported companion server with Node 24.

Server-side search preserves the complete indexed OCR text. The Node exporter
writes metadata and FTS rows directly to `.server-data/corpus.sqlite`; it does
not create an intermediate JSON corpus. Page records contain metadata and
full-text fields, while referenced attachments contain metadata only. The
database is never served over HTTP.

## Memory Behavior

Vault attachments are represented by source and destination paths and are not
loaded into JavaScript `ArrayBuffer` objects. Only attachments referenced by a
Markdown document are added to the database and copied to the output.

Exported hardlinked attachments must be treated as read-only: deleting an
exported path is safe, but modifying its bytes in place would also modify the
vault source. Remote `rsync` deployments still transfer normal file contents;
the source hardlink does not need to exist on the remote server.

No page DOM is created during export. Markdown is parsed into a bounded record,
written to SQLite, and then released. HTML is produced by the companion server
only when a browser requests a document; its renderer uses an mtime-and-size
validated LRU cache.

`site-lib/metadata.json` is a small browser bootstrap only. Per-page and
per-file descriptors live in SQLite. The browser loads navigation from
`/api/app/bootstrap` and `/api/navigation`, and retrieves rendered content from
`/api/page` only when it opens a page.

Viewable media such as PDFs remain direct attachments and are not added to FTS.

The exporter writes `.export-progress.json` into the destination with aggregate
progress and process memory values. It never includes note paths, titles, or
content. The companion server does not serve this file.

The in-app export log is bounded as well. It retains at most 2 MB of recent text
and 200 visible warning or error cards, and is reset at the start of every
export. Per-file progress updates are shown in place instead of being appended
to the retained log.

## Recovery

SQLite transactions are committed after every 500 changed records by default;
`EXPORT_COMMIT_INTERVAL` can override this value. A subsequent export reuses
records whose source mtime and size are unchanged and resumes safely after an
interrupted run.

## Search Server

The server exposes:

- `POST /api/search` for full-text and field-filtered search.
- `GET /api/search/status` for aggregate indexing progress.
- `GET /api/metadata/bootstrap` for the browser bootstrap and tag tree.
- `GET /api/metadata/document?path=...` for metadata of an opened page.
- `POST /api/checkout` for shopping basket checkout.

## Real-vault Baseline

The optimization was exercised against an existing large production vault
without reading or transmitting note contents.
Disk usage is measured with `du`, not by summing file sizes, so hardlinked files
are not counted repeatedly:

- Source vault: `33,198,392 KiB` allocated.
- Historical interrupted export: `35,499,604 KiB` allocated, including the
  legacy generated HTML that the current SPA architecture no longer creates.
- During the 61,647-file initialization scan, `arrayBuffers` remained at zero.

The Docker wrapper starts exports with a 12 GiB container memory limit and a
16 GiB memory-plus-swap limit. Override these values when necessary, for
example `EXPORT_MEMORY=16g EXPORT_MEMORY_SWAP=20g`. Docker Desktop must itself
have enough memory allocated; container limits cannot exceed the Desktop VM's
available memory.

## Validation

Use the Node 24 commands documented in `AGENTS.md`:

```bash
/Users/honzas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run build
/Users/honzas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run test:server
```
