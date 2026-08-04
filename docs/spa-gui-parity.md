# SPA GUI Parity Checklist

Use Chrome to compare the server-rendered SPA with the archive's static export.
Run this checklist after changes to the SPA renderer, navigation, search, or
theme assets.

- Light and dark mode toggle changes the complete interface without a reload.
- The left tree uses source filenames without `.md` by default; setting
  `exportOptions.fileNavigationOptions.showDocumentTitles` to `true` uses
  document titles instead.
- Expanding and collapsing a folder updates its chevron immediately.
- A `tag:` search expands the complete matching hierarchy and loads every
  matching leaf without requiring manual collapse and re-expansion.
- A tag search and a full-text search show the first 1,000 matching documents,
  including lower-ranked exact matches. When more matches exist, a dismissible
  notification card states that the visible-result limit was reached. Results
  highlight matching content in the open document with `#fcedb5` and scroll to
  its first match. Tag links use the tag highlight treatment from the static
  export. The clear-search control is hidden for an empty query and appears as
  an accessible × button when the input contains text.
- Direct document URLs, browser back/forward navigation, Markdown links, and
  tag links keep the SPA loaded and update the current document. The browser
  URL follows Markdown documents, attachments, heading anchors, and search
  queries; back/forward restores the corresponding state.
- Markdown documents with top-level tables expand to the complete available
  center workspace; prose-only documents retain the readable line width.
- A PDF link replaces the Markdown document in the center pane while both
  sidebars remain available.
- Metadata, Abstract, and Citing this document callouts match the static
  export. Citation code blocks wrap, use the monospace font, and expose a
  working copy button.
- The right sidebar shows a hierarchical, collapsible Table of contents for
  the open document, including headings nested inside Abstract callouts. The
  document title and top-level leaf headings are emphasized while nested
  headings use normal weight. Its active item follows the reading position.
- The SPA does not render or initialize the interactive graph.
