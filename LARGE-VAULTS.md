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

Server-side search preserves the complete indexed OCR text. The exporter writes
one private corpus record per exported file under `site-lib/corpus/`. Page
records contain both their metadata and full-text search fields; attachment
records contain metadata only. The companion server imports this corpus in one
pass into `.server-data/corpus.sqlite`. The corpus directory is never served
over HTTP.

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

The hidden Obsidian render view is recreated after a renderer failure or
watchdog timeout. A 120-second watchdog skips a document
whose complete render pipeline does not return, records the source path in the
private timing log, and resets the renderer before continuing.

When a virtualized preview contains at least 300 sections and its section cache
is complete, the exporter uses lightweight cached HTML assembly instead of
cloning every section and running `postProcess` again. This avoids a second
large DOM allocation for documents with hundreds of sections. If the cache is
incomplete, the exporter keeps the safer repair and fallback path rather than
silently producing an incomplete page. The private
`.export-current-render.json` marker records the document currently being
rendered and remains available after a renderer crash for diagnosis.

Markdown files at least 64 KiB long with 3,000 or more lines bypass Obsidian's
virtualized preview leaf and use its direct Markdown renderer. OCR exports often
contain one short line per paragraph, so this avoids creating thousands of
preview sections for a small text file.

`site-lib/metadata.json` is a small browser bootstrap only. Per-page and
per-file descriptors, including page search fields, are written atomically to
the private corpus and imported by the companion server. The browser loads tag navigation from
`/api/metadata/bootstrap` and retrieves a page descriptor from
`/api/metadata/document` only when it opens that page.

Viewable media such as PDFs are exported as direct attachments instead of
additional HTML wrapper pages. This avoids invoking thousands of Obsidian media
renderers. Markdown pages and their complete OCR full text remain unchanged.

The exporter writes `.export-progress.json` into the destination with aggregate
progress and process memory values. It never includes note paths, titles, or
content. The companion server does not serve this file.

The in-app export log is bounded as well. It retains at most 2 MB of recent text
and 200 visible warning or error cards, and is reset at the start of every
export. Per-file progress updates are shown in place instead of being appended
to the retained log.

## Recovery

The small bootstrap `metadata.json` is checkpointed after every 500 rendered
pages. Unified corpus records are written atomically per file.
A subsequent export can reuse completed HTML and corpus records after an
interrupted run.

Bootstrap `metadata.json` writes use a temporary file and atomic rename. The
export removes a stale browser `search-index.json` after a successful export.

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
- Interrupted test export: `35,499,604 KiB` allocated, including generated HTML,
  metadata, and server data.
- During the 61,647-file initialization scan, `arrayBuffers` remained at zero.

Obsidian's renderer used roughly 4.1 GiB RSS after loading the vault before a new
export was started. That baseline belongs to Obsidian and its metadata cache,
not to attachment buffers created by this plugin.

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
