# Large Vault Exports

Large OCR vaults should use the normal multi-file export format and server-side
full-text search. Do not use the combined single-file format, because that format
must embed binary attachments in memory.

## Recommended Settings

- Keep `Inline media` disabled.
- Keep `Combine as single file` disabled.
- Enable `Search Bar`.
- Enable `Server-side full-text search` in the Search Bar settings.
- Keep the default search endpoint `/api/search`.
- Run the exported companion server with Node 24.

Server-side search preserves the complete indexed OCR text. The exporter writes
one private corpus record per changed page under `site-lib/search-corpus/`.
The companion server imports those records into `.server-data/search.sqlite`
using SQLite FTS5. Neither directory is served over HTTP.

## Memory Behavior

Vault attachments are represented by source and destination paths. For local
filesystem vaults, the exporter first creates an atomic hardlink. This avoids a
second physical copy when the vault and export are on the same filesystem. If
hardlinks are unavailable, it falls back to a copy-on-write clone or normal
`fs.copyFile()`. Attachments are never loaded into JavaScript `ArrayBuffer`
objects, and writes use a bounded concurrency of two.

Exported hardlinked attachments must be treated as read-only: deleting an
exported path is safe, but modifying its bytes in place would also modify the
vault source. Remote `rsync` deployments still transfer normal file contents;
the source hardlink does not need to exist on the remote server.

Page DOM documents are created only when a page is rendered. After the page is
written and indexed, its DOM, HTML, extracted full text, link arrays, and
attachment arrays are released.

In multi-file exports, website metadata is stored as an atomic three-part set:
`metadata.json` contains the site manifest and lookup maps,
`metadata-pages.json` contains page descriptors, and `metadata-files.json`
contains attachment descriptors. Old monolithic `metadata.json` exports remain
readable. Splitting the data avoids creating one large serialization buffer for
every checkpoint.

In server-side search mode, and automatically for exports containing more than
100 files, viewable media such as PDFs are exported as direct attachments
instead of additional HTML wrapper pages. This avoids invoking thousands of
Obsidian media renderers. Markdown pages and their complete OCR full text remain
unchanged.

The exporter writes `.export-progress.json` into the destination with aggregate
progress and process memory values. It never includes note paths, titles, or
content. The companion server does not serve this file.

The in-app export log is bounded as well. It retains at most 2 MB of recent text
and 200 visible warning or error cards, and is reset at the start of every
export. Per-file progress updates are shown in place instead of being appended
to the retained log.

## Recovery

In server-side search mode, `metadata.json` is checkpointed after every 500
rendered pages. Corpus records are written atomically per page. A subsequent
incremental export can reuse completed HTML, metadata, and corpus records after
an interrupted run.

Final `metadata.json` and browser `search-index.json` writes use a temporary file
and atomic rename. Server-side mode removes a stale browser search index after a
successful export.

## Search Server

The server exposes:

- `POST /api/search` for full-text and field-filtered search.
- `GET /api/search/status` for aggregate indexing progress.
- `POST /api/checkout` for shopping basket checkout.

The existing browser MiniSearch mode remains available for small static exports
that do not use the companion server.

## Real-vault Baseline

The optimization was exercised against an existing large production vault
without reading or transmitting note contents.
Disk usage is measured with `du`, not by summing file sizes, so hardlinked files
are not counted repeatedly:

- Source vault: `33,198,392 KiB` allocated.
- Interrupted test export: `35,499,604 KiB` allocated, including generated HTML,
  metadata, and server data.
- During the 61,647-file initialization scan, `arrayBuffers` remained at zero.

Obsidian's renderer used roughly 4.1 GiB RSS after loading the vault before a new
export was started. That baseline belongs to Obsidian and its metadata cache,
not to attachment buffers created by this plugin.

## Validation

Use the Node 24 commands documented in `AGENTS.md`:

```bash
/Users/honzas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run build
/Users/honzas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run test:server
```
