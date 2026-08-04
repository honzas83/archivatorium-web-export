# GUI Parity Checklist

Reference implementation: `https://nato-obsidian.kky.zcu.cz/`.

Run the same scenarios against the reference and the server-rendered SPA at
desktop and mobile widths, in both light and dark themes. Capture a screenshot
for every failed scenario and record the URL, viewport, theme, and document.

## Navigation

- The left sidebar contains only the file tree and shopping basket; search must
  never create a separate result-list panel.
- Expanding and collapsing a folder changes both its children visibility and
  chevron direction. The control exposes the matching `aria-expanded` value.
- `Collapse all` and reopening a folder preserve the same hierarchy and order.
- Direct document navigation, internal links, browser back/forward, and a
  refreshed document URL keep the sidebars in place and reveal the active file.
- A PDF link replaces the center document with the PDF viewer while retaining
  the left tree, right sidebar, theme toggle, basket, and browser history.

## Search

- Typing a full-text query filters the existing file tree; only result files
  and their ancestor folders are visible.
- Clicking a tag uses the same filtered-tree behavior. A hierarchical tag also
  includes documents tagged with its descendants.
- Clearing the query restores the lazy tree, its normal root children, and its
  collapse behavior.
- Search input, tag links, document highlighting, and the current-query basket
  action retain their behavior after internal navigation.

## Callouts

- For `info`, `note`, `warning`, `tip`, `example`, and custom callouts, compare
  the callout background, border or left accent, radius, title font, title
  color, icon, title/content spacing, and paragraph margins to the reference.
- Compare collapsed (`-`) and expanded (`+`) callouts, including the toggle
  affordance and content visibility.
- Repeat each callout comparison in light and dark themes; no hard-coded light
  colors may remain in the SPA stylesheet.
- Metadata and citation callouts must render like the reference document view
  while remaining excluded from the full-text index.

## Visual Regression Targets

- Sidebar width, search field, file-tree indentation, chevrons, selected file,
  buttons, and checkout controls.
- Markdown body typography, headings, tables, tags, embeds, raw HTML, and PDF
  viewport height.
- Theme toggle state and every component whose colors depend on it.

## Automation Contract

- Implement these cases as browser GUI tests once the reference fixtures are
  available locally: use deterministic Markdown fixtures for each callout type,
  one PDF attachment, a nested tag hierarchy, and at least two matching files.
- Each test must assert DOM state and take a screenshot at desktop and mobile
  widths. The static reference export is the visual baseline; the SPA result is
  compared against it after normalizing document-specific text.
