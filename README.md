# Archivatorium Web Export

Archivatorium Web Export publishes an Obsidian research vault as a searchable,
server-rendered web application. It is designed for large archival collections
containing Markdown, OCR text, structured metadata, hierarchical tags, PDFs,
and other source attachments.

The project is the publishing component of
[Archivatorium](https://github.com/honzas83/archivatorium). It can also be used
with a standalone Obsidian vault.

## Architecture

The current version is not a static HTML exporter. It uses the vault itself as
the content directory and writes generated data to one hidden folder:

```text
vault/
├── .archivatorium/
│   ├── corpus.sqlite
│   ├── index.html
│   ├── favicon.png
│   ├── server/                 # installed by the Obsidian plugin
│   └── site-lib/
├── .obsidian/
├── Notes/
├── Attachments/
└── ...
```

The generated application works as follows:

1. Markdown is indexed directly into SQLite and FTS without rendering every
   note in Obsidian or creating one HTML file per note.
2. The browser loads one SPA shell. File navigation and the tag tree are loaded
   lazily from the server.
3. The server renders a Markdown document only when it is requested.
4. Rendered pages are held in an LRU cache and invalidated from source `mtime`
   and file size.
5. PDFs and other referenced attachments are served directly from the vault.

This keeps export memory bounded and makes collections with tens of thousands
of documents practical.

## Features

- SQLite FTS over titles, aliases, headings, metadata, paths, tags, and document
  text
- Obsidian-compatible inline and frontmatter tag parsing
- Hierarchical tag filtering and lazy tag navigation
- Lazy file tree that preserves its state during SPA navigation
- Server-side Markdown rendering with tables, callouts, wikilinks, embeds,
  headings, raw HTML, and code blocks
- On-demand PDF display without extracting or indexing PDF text
- Light and dark themes, responsive sidebars, and table of contents
- Stable document URLs and metadata/citekey redirects
- Incremental indexing based on Markdown `mtime` and size
- Persistent search basket and server-side checkout of original Markdown
- Public-archive link rewriting in checkout archives

## Requirements

- Node.js 26 (recommended) or Node.js 24
- Obsidian desktop when using the plugin workflow
- A writable vault during generation and indexing

The supported package range is `>=24 <27`. Node 24 and Node 26 have been
verified directly with the complete build and server test suite.

## Installation

The plugin is distributed from GitHub and is not currently listed in the
Obsidian Community Plugins directory.

### Manual plugin installation

1. Download the ZIP from the
   [latest release](https://github.com/honzas83/archivatorium-web-export/releases/latest).
2. Extract it to
   `<vault>/.obsidian/plugins/archivatorium-web-export/`.
3. Reload Obsidian and enable **Archivatorium Web Export**.

### BRAT

Install BRAT, choose **Add beta plugin**, and use:

```text
https://github.com/honzas83/archivatorium-web-export
```

## Generate a vault application

There are two supported workflows. Both write to `<vault>/.archivatorium` and
do not require a separate output directory.

### From Obsidian

Use the ribbon action or the command **Export using previous settings**. Select
the files to publish and run the export. The plugin installs the SPA, companion
server files, configuration, and index inside `.archivatorium`.

Useful plugin settings include:

- **Search Bar**: enables server-side full-text search; the generated endpoint
  is `/api/search`.
- **Shopping Basket**: enables collection checkout; the generated endpoint is
  `/api/checkout`.
- **Maximum checkout items**: maximum number of unique Markdown documents in
  one checkout. `0`, the default, means unlimited.
- **File Navigation / Show document titles**: uses frontmatter or heading
  titles in the file tree and basket. Disabled by default, so source filenames
  are shown.
- **Favicon**, theme, sidebars, outline, tags, aliases, backlinks, and document
  width are carried into the generated application where supported.

The server-rendered architecture always uses server-side search. RSS and the
interactive graph are currently disabled.

### Directly from Node

This is the simplest headless workflow and does not start Obsidian:

```bash
git clone https://github.com/honzas83/archivatorium-web-export.git
cd archivatorium-web-export
npm install
npm run build

node server/export-markdown-spa.mjs /absolute/path/to/vault
```

An optional second argument supplies plugin-compatible settings from another
location:

```bash
node server/export-markdown-spa.mjs \
  /absolute/path/to/vault \
  /absolute/path/to/data.json
```

Without that argument, the exporter reads
`<vault>/.obsidian/plugins/archivatorium-web-export/data.json`. If it does not
exist, defaults are used.

The exporter updates records in transactions and reuses unchanged Markdown
records. `EXPORT_COMMIT_INTERVAL` controls the transaction interval and
defaults to `500` changed records.

## Run the server

The recommended development and upgrade-safe command runs the server from the
current repository:

```bash
cd /path/to/archivatorium-web-export

PUBLIC_ARCHIVE_ROOT=http://127.0.0.1:8000/ \
HOST=127.0.0.1 \
PORT=8000 \
node server/server.mjs /absolute/path/to/vault
```

Open <http://127.0.0.1:8000/>.

`PUBLIC_ARCHIVE_ROOT` is required. It is used when the server creates public
document references, especially in checkout archives. Use the final external
archive URL in production.

When started from a repository checkout, the server compares the current
frontend application with the copy in `.archivatorium`. Missing or older SPA
assets are rebuilt automatically without rebuilding a valid SQLite database.

The server can also be run from the files installed into the vault by the
Obsidian plugin:

```bash
npm install --prefix /absolute/path/to/vault/.archivatorium/server

PUBLIC_ARCHIVE_ROOT=https://archive.example.org/ \
HOST=127.0.0.1 \
PORT=8000 \
node /absolute/path/to/vault/.archivatorium/server/server.mjs \
  /absolute/path/to/vault
```

### Server environment

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PUBLIC_ARCHIVE_ROOT` | required | Public base URL used in generated references |
| `HOST` | `127.0.0.1` | Listening interface |
| `PORT` | `8000` | Listening port |
| `VAULT_ROOT` | CLI argument | Alternative way to provide the vault path |
| `PAGE_CACHE_ENTRIES` | `256` | Maximum rendered Markdown pages in the LRU cache |
| `MAX_CHECKOUT_ITEMS` | plugin setting | Deployment override; `0` means unlimited |
| `MAX_CHECKOUT_BYTES` | `1000000` | Maximum checkout request-body size |

## Index lifecycle

If `.archivatorium/corpus.sqlite` is missing or incomplete, repository
`server.mjs` builds or resumes it before opening the listening port.

For an existing complete database:

- page rendering notices a changed Markdown file from its `mtime` and size and
  immediately invalidates the rendered-page cache;
- search, tag counts, metadata, and file navigation continue to use the SQLite
  snapshot;
- rerun `server/export-markdown-spa.mjs` or the Obsidian export to update that
  snapshot incrementally.

Only referenced attachments receive attachment records. Attachment contents
are not extracted into FTS. In particular, PDF text is not indexed unless it
also exists in a Markdown document.

## Upgrade an existing vault

When serving from the repository:

```bash
cd /path/to/archivatorium-web-export
git pull --ff-only
npm install
npm run build
```

Restart `server/server.mjs`. It refreshes stale application assets in the vault
automatically. Rerun the direct exporter only when Markdown, metadata, tags, or
the desired plugin configuration changed and the SQLite snapshot must be
updated.

Do not delete `corpus.sqlite` for a normal code upgrade.

## Optional Docker workflow

The repository retains an Obsidian/Electron Docker runner for environments
that require the plugin workflow:

```bash
./run-archivatorium-docker.sh \
  /absolute/path/to/vault \
  [/absolute/path/to/data.json]
```

It builds `archivatorium-web-export:local`, mounts the vault at `/vault`, and
writes `.archivatorium` inside the vault. Both paths passed to the script must
be absolute. The direct Node exporter is preferred when Obsidian rendering is
not required.

## Deployment and security

The companion server is intentionally small and does not provide authentication
or TLS. In production:

- bind it to localhost and place an authenticating HTTPS reverse proxy in front
  of it;
- protect `/api/checkout`, because it packages original Markdown from the
  vault;
- keep the vault and `.archivatorium` writable only by trusted processes;
- do not expose `.archivatorium/server` or `corpus.sqlite` as static files;
- treat raw HTML in Markdown as trusted content. It is rendered without
  sanitization to preserve Obsidian output compatibility.

The server validates requested paths and does not serve its generated server
modules or SQLite database through the static file handler.

## Development

Use Node.js 26 (or the supported Node.js 24 release):

```bash
npm install
npm run dev
```

Production build and server tests:

```bash
npm run build
npm run test:server
```

The release artifact contains `main.js`, `manifest.json`, and `styles.css` for
the Obsidian plugin. The generated companion server declares its runtime
dependency in `.archivatorium/server/package.json`.

## Relationship to upstream

This project started as a fork of
[Webpage HTML Export](https://github.com/KosmosisDire/obsidian-webpage-export)
by Nathan George. The current vault-first, server-rendered architecture is
maintained independently by [Jan Švec](https://honzas.cz) and is not affiliated
with or supported by the upstream maintainer.

## Data disclosure

Generation and indexing run locally. The project contains no client-side
telemetry and does not send vault contents to Archivatorium, the maintainer, or
an AI provider. Browser search requests and checkout selections are sent only
to the archive server configured by the operator.

Vault documents and attachments retain their own copyright and licensing. The
software license does not grant permission to publish vault content.

## License

Copyright (c) 2023 Nathan George

Copyright (c) 2026 Jan Švec

Licensed under the [MIT License](LICENSE). The original copyright notice and
license text must remain in copies or substantial portions of this software.
