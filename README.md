# Archivatorium Web Export

Archivatorium Web Export is the web-publishing component of
[Archivatorium](https://github.com/honzas83/archivatorium), a toolkit for
turning archival PDFs into cleaned, enriched, and interlinked research
collections.

Archivatorium performs the earlier stages of the workflow: local OCR and
LLM-assisted cleanup, structured metadata extraction, deterministic citekeys,
hierarchical tagging, PDF mirroring, and interlinking into an Obsidian vault.
This project takes the resulting vault and publishes it as a searchable website
while preserving the archival metadata, source relationships, and access to the
underlying collection.

## Why this fork exists

This project started as a fork of
[Webpage HTML Export](https://github.com/KosmosisDire/obsidian-webpage-export)
by Nathan George. The upstream plugin provided an excellent foundation for
rendering Obsidian notes with strong visual parity, navigation, and graph
features. It remains the right general-purpose exporter for many vaults.

Archivatorium introduced requirements beyond a conventional personal vault. A
representative collection contains around 30,000 pages and 32 GB of Markdown,
OCR text, PDFs, and metadata. At that scale, the original export workflow began
to exhaust Electron array buffers, retain too much rendered state, time out on
document previews, and spend substantial time copying media or updating the
interface.

The research interface also needed capabilities that were outside the original
exporter's scope:

- complete OCR full-text search without truncating long document bodies
- exact hierarchical tag matching and an Obsidian-like tag tree
- metadata and citekey-based document routing
- stable highlighting and scrolling from search results into documents
- bounded-memory and incremental processing for large vaults
- direct media output and hard-linking where the filesystem permits it
- progress reporting that includes documents and media, with throughput and ETA
- a persistent search basket for building a selected research collection
- server-side checkout that restores original Markdown, rewrites external
  references to the public archive, and packages the selected vault as a ZIP
- a companion server that hosts the SPA and keeps the full search
  corpus outside the browser

The current experimental architecture does not render documents in Obsidian.
It indexes Markdown directly into SQLite and renders document HTML on demand in
the companion server, while retaining the familiar exported interface.

## Relationship to upstream

Archivatorium Web Export is independently maintained by
[Jan Švec](https://honzas.cz). It is not affiliated with or supported by the
upstream maintainer. Both projects are distributed under the MIT License, and
the original copyright and attribution are preserved.

The [upstream documentation](https://docs.obsidianweb.net/) remains useful for
the common export and appearance settings. Detailed implementation records for
features added in this fork are available in the `CHANGES-*.md` files.

## Highlights

- Full-text search over OCR bodies, metadata, titles, aliases, headings, and tags
- Server-side SQLite FTS for collections too large for a browser index
- Lazy file navigation, outline, tag tree, and theme switching
- Strict hierarchical tag filtering with in-document highlighting
- Citekey routes for stable links into the published archive
- Incremental Markdown indexing based on source mtime and size
- Direct media output without attachment text extraction
- Search basket with persistent batches and individually selectable documents
- Markdown checkout with local-link preservation and public-archive rewriting
- SPA hosting, rendering, search, and checkout through the bundled Node companion server

## Installation

This fork is currently distributed through GitHub and has not been submitted to
the Obsidian Community Plugins directory.

### Manual installation

1. Download the ZIP file from the
   [latest GitHub release](https://github.com/honzas83/archivatorium-web-export/releases/latest).
2. Extract it to
   `{VaultFolder}/.obsidian/plugins/archivatorium-web-export/`.
3. Reload Obsidian and enable **Archivatorium Web Export** under Community
   plugins.

### BRAT

Install BRAT, select **Add beta plugin**, and enter:

```text
https://github.com/honzas83/archivatorium-web-export
```

## Development

Node.js 24 is the supported development runtime.

```bash
npm install
npm run dev
```

Create a production bundle with:

```bash
npm run build
```

The release workflow packages `main.js`, `manifest.json`, and `styles.css` in a
directory named `archivatorium-web-export`. GitHub Actions create plugin release
artifacts but do not automatically build or publish a Docker image.

## Docker CLI export

The optional Docker image runs Obsidian with a virtual display, injects the
bundled plugin, and starts an export without opening the desktop interface.
Vault and export data remain on the local machine.

Build the current source as a local image:

```bash
docker build -t archivatorium-web-export:local .
```

Run a complete export with an existing plugin configuration:

```bash
VAULT=/path/to/archivatorium-vault
OUTPUT=/path/to/export
CONFIG=/path/to/plugin-data.json

mkdir -p "$OUTPUT"

docker run --rm \
  -e EXPORT_ENTIRE_VAULT=1 \
  -v "${VAULT}:/vault" \
  -v "${OUTPUT}:/output" \
  -v "${CONFIG}:/config.json:ro" \
  archivatorium-web-export:local
```

The mounted configuration has the same structure as the plugin's `data.json`.
Without the `CONFIG` mount, the CLI preserves and uses an existing
`.obsidian/plugins/archivatorium-web-export/data.json` in the vault, or uses
plugin defaults when no settings exist.

The runner refreshes `main.js`, `manifest.json`, and `styles.css` inside
`.obsidian/plugins/archivatorium-web-export/` for every run. The vault must be
writable because Obsidian and the plugin update files under `.obsidian`.

Reuse the same output directory for later incremental exports. The Docker
runner retries an Electron `Renderer process killed` crash indefinitely;
completed pages are reused on the next attempt. Set
`EXPORT_RENDERER_RETRY_DELAY_SECONDS` to adjust the default 20-second wait
between attempts. Each retry also terminates orphaned Obsidian processes and
releases its remote-debugging port before starting again. Stop a running export
with `Ctrl+C`. The first image build downloads its dependencies and the pinned
Obsidian release; subsequent builds use Docker's cache.

The runner also restarts Electron when the injected script has not recorded its
initial `running` status within 90 seconds. Set
`EXPORT_STARTUP_TIMEOUT_SECONDS` to change that startup-only watchdog.
It always starts the pinned Obsidian version bundled in the image and removes
any auto-updater ASAR downloaded by a previous attempt. The runner also emits
`[docker-progress]` lines from output state files, independently of Electron's
console-log forwarding. Once page output begins, it forwards every completed
file name from `.export-files.log` to the console.

## Companion server

Hosted exports use the generated `server/shopping-basket-server.mjs` as their
web server. It serves generated HTML, PDFs, assets, full-text search, metadata,
redirects, and shopping-basket checkout from one process. The server is copied
into every generated website so the deployed server and export remain
compatible.

Run it with Node.js 24:

```bash
VAULT_ROOT=/srv/archivatorium-vault \
EXPORT_ROOT=/srv/archivatorium-export \
PUBLIC_ARCHIVE_ROOT=https://archive.example.org/ \
HOST=127.0.0.1 \
PORT=8000 \
node server/shopping-basket-server.mjs
```

Place an authenticating reverse proxy in front of the checkout endpoint. The
server deliberately does not serve files from the exported `server/` directory.
Treat `VAULT_ROOT` as read-only and do not expose the companion server directly
to an untrusted network.

## Data and network disclosure

- Exporting reads selected files and metadata from the local vault and writes
  the generated website to the destination chosen by the user.
- Remote emoji or other explicitly referenced assets may be downloaded when
  required by exported content and the selected export options.
- Static exports do not send vault contents to Archivatorium, the project
  maintainer, or a hosted AI provider.
- When enabled, the shopping basket sends selected vault-relative paths and
  titles to the archive operator's checkout endpoint. The companion server reads
  the corresponding Markdown from its configured `VAULT_ROOT`.
- Server-side full-text search sends queries to the configured archive search
  endpoint. The search corpus remains on the archive operator's server.
- The project contains no client-side telemetry.

Vault documents, PDFs, and other exported content retain their own copyright and
licensing. The MIT License for this software does not grant permission to
publish vault content.

## Attribution and license

Copyright (c) 2023 Nathan George

Copyright (c) 2026 Jan Švec

Licensed under the [MIT License](LICENSE). The original copyright notice and
license text must remain in copies or substantial portions of this software.

## Support and contributions

Use this repository's issues for reproducible bugs and feature requests, and
discussions for usage questions. The broader OCR, metadata, tagging, and
interlinking pipeline is maintained in
[honzas83/archivatorium](https://github.com/honzas83/archivatorium).

Information about the fork maintainer is available at
[honzas.cz](https://honzas.cz).
