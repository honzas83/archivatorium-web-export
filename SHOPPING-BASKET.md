# Shopping Basket Checkout

Hosted exports can optionally show a search basket near the search bar. The basket stores search-result metadata in the browser, then posts selected source paths to a companion server that has read-only access to the original vault.

## Server

Run the companion server behind your existing authenticated proxy:

```bash
VAULT=/path/to/original/vault
PUBLIC_ARCHIVE_ROOT=https://archive.example.org/ \
HOST=127.0.0.1 \
PORT=8000 \
node server/shopping-basket-server.mjs "$VAULT"
```

The checkout endpoint is `POST /api/checkout`. It expects:

```json
{
  "items": [
    {
      "exportPath": "folder/page.html",
      "sourcePath": "Folder/Page.md",
      "title": "Page"
    }
  ]
}
```

The server validates that every `sourcePath` stays inside the configured vault,
only reads Markdown files, rewrites links to files outside the selected subset
to `PUBLIC_ARCHIVE_ROOT`, and returns `vault-subset-YYYY-MM-DD.zip`.

## Export Settings

Enable `Shopping Basket` in the plugin settings for hosted exports and set the checkout endpoint if it is not `/api/checkout`.

The generated `.archivatorium` application does not duplicate the original
Markdown. The browser only sends source-path identifiers; the companion server
reads documents directly from the vault.
