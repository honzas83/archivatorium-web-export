# Tag Hierarchy Search Changes

This document records the follow-up changes made after the initial tag tree sidebar work.

## Goal

Make hierarchical tag searches behave strictly and improve the experience when opening a document from an active tag-filtered search.

## Problem 1: Incorrect hierarchical tag matching

### Observed behavior

Searching for a hierarchical tag such as:

- `#Org/SACLANT`

returned documents that only contained:

- `#SACLANT`

This was incorrect because the search result matched a shared leaf token instead of the full hierarchical path.

### Cause

The frontend tag search relied on MiniSearch tokenization alone. MiniSearch could return candidate results based on partial token overlap inside the indexed `tags` field, even when the document did not actually contain the requested hierarchical tag path.

### Fix

Updated `src/frontend/main/search.ts` to add a strict tag-result post-filter:

- `filterTagResults(results, query)`

This filter:

- normalizes the searched tag by removing leading `#`
- normalizes stored tags the same way
- only keeps results where a stored tag:
  - exactly equals the searched hierarchical path, or
  - starts with the searched path followed by `/`

### Result

The matching rules are now:

- `#Org/SACLANT` matches `#Org/SACLANT`
- `#Org/SACLANT` matches `#Org/SACLANT/Subtag`
- `#Org/SACLANT` does not match `#SACLANT`
- `#Org` matches `#Org/...`

## Problem 2: No in-document tag highlight after clicking search results

### Observed behavior

When a tag filter stayed active in the vault search bar and the user opened a document, the search result context was lost inside the document view. The corresponding tag inside the opened note was not highlighted or scrolled into view.

### Fix

Updated `src/frontend/main/search.ts` and `src/frontend/main/website.ts`:

- Added `Search.applyCurrentQueryToDocument()`
- Added `Search.parseQueryFilter(...)` reuse for document-side behavior
- Added `Search.highlightTagInCurrentDocument(query)`
- Called `this.search?.applyCurrentQueryToDocument()` after page load in `ObsidianWebsite.loadURL(...)`

For active tag queries:

- matching `a.tag` elements in the loaded document are highlighted
- the first matching tag is scrolled into view

For active content queries:

- the old text-mark behavior is preserved

Clearing the search removes both:

- inline text marks
- tag highlight classes

## Styling

Updated `src/assets/plugin-styles.txt.css` to add:

- `a.tag.search-tag-mark`

This gives matched tag links a visible highlight without changing their link behavior.

## Files Changed

- `src/frontend/main/search.ts`
  - added strict hierarchical tag filtering
  - added document-side query reapplication
  - added tag highlighting and cleanup behavior

- `src/frontend/main/website.ts`
  - reapplies active search state after page navigation completes

- `src/assets/plugin-styles.txt.css`
  - added visual highlight style for matched in-document tags

## User-visible Result

After these changes:

- hierarchical tag searches are exact with optional descendant matching
- false positives from shared leaf tag names are removed
- opening a document from a tag-filtered search highlights the relevant tag in the note and scrolls to it when found
