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
  highlight matching content in the open document with
  `rgba(255, 208, 0, .4)` and scroll to its first match. Multiword full-text
  queries require every term but do not depend on term order. Tag links use
  the tag highlight treatment from the static export. Inline tags follow
  Obsidian syntax and ignore frontmatter, code, comments, HTML attributes,
  escaped hashes, numeric-only values, and Markdown link destinations. The
  clear-search control is hidden for an empty query and appears as an
  accessible × button when the input contains text.
- Direct document URLs, browser back/forward navigation, Markdown links, and
  tag links keep the SPA loaded and update the current document. The browser
  URL follows Markdown documents, attachments, heading anchors, and search
  queries; back/forward restores the corresponding state.
- Markdown documents retain the reference 640 px readable width, including
  documents with tables. The center document occupies the full viewport
  height and scrolls vertically without clipping long content.
- A PDF link replaces the Markdown document in the center pane while both
  sidebars remain available.
- Metadata, Abstract, and Citing this document callouts match the static
  export. Citation code blocks wrap, use the monospace font, and expose a
  working copy button. Compare their final computed background, border,
  padding, radius, font family, font size, line height, and title color in both
  light and dark themes rather than comparing stylesheet declarations alone.
- The right sidebar shows a hierarchical, collapsible Table of contents for
  the open document, including headings nested inside Abstract callouts. The
  document title and top-level leaf headings are emphasized while nested
  headings use normal weight. Its active item follows the reading position.
- The SPA does not render or initialize the interactive graph.
- The shell uses the same favicon as the plugin export. Backlinks resolve from
  the SPA metadata cache without missing-target console errors.
