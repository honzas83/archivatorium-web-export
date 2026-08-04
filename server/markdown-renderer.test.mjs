import assert from "node:assert/strict";
import test from "node:test";
import { MarkdownDocumentRenderer } from "./markdown-renderer.mjs";

test("renderer supports archive Markdown and validates its cache", async () => {
	const renderer = new MarkdownDocumentRenderer({ maxEntries: 1 });
	const markdown = `---
title: Hidden frontmatter
---
# Report

[[Target|Linked target]] ![[Map.png]] ![[Report.pdf]]
[Markdown target](Target.md)
[Punctuated target](Target(1).md)
[PDF link](Report.pdf)
[Legacy tag](http://127.0.0.1:8000/?query=tag:Entities%2FOrg%2FNATO)

| Column | Value |
| --- | --- |
| A | B |

> [!info] Metadata
> <span class="trusted">Trusted HTML</span>

> [!citing this document]
> Citation content

> [!warning]- Folded warning
> Hidden until expanded.

\`\`\`bibtex
@misc{report}
\`\`\`
`;
	let reads = 0;
	const request = {
		sourcePath: "Folder/Report.md",
		modifiedTime: 1,
		sourceSize: markdown.length,
		loadMarkdown: async () => {
			reads++;
			return markdown;
		},
		resolveLink: (target) => ({
			Target: { exportPath: "target.html", sourcePath: "Target.md" },
			"Target.md": { exportPath: "target.html", sourcePath: "Target.md" },
			"Target(1).md": { exportPath: "target.html", sourcePath: "Target.md" },
			"Map.png": { exportPath: "assets/map.png", sourcePath: "Map.png" },
			"Report.pdf": { exportPath: "assets/report.pdf", sourcePath: "Report.pdf" },
		}[target]),
	};

	const first = await renderer.render(request);
	assert.match(first, /<a class="internal-link" href="target.html">Linked target<\/a>/);
	assert.match(first, /<a class="internal-link" href="target.html">Markdown target<\/a>/);
	assert.match(first, /<a class="internal-link" href="target.html">Punctuated target<\/a>/);
	assert.match(first, /<a class="internal-link attachment-link" href="assets\/report.pdf">PDF link<\/a>/);
	assert.match(first, /<a class="tag" href="\/\?query=tag:Entities%2FOrg%2FNATO">Legacy tag<\/a>/);
	assert.match(first, /<img class="internal-embed" src="\/assets\/map.png" alt="Map.png">/);
	assert.match(first, /<iframe class="internal-embed" src="\/assets\/report.pdf" title="Report.pdf"><\/iframe>/);
	assert.match(first, /<table>/);
	assert.match(first, /data-callout="info"/);
	assert.match(first, /data-callout="citingthisdocument"/);
	assert.match(first, /data-callout="warning" data-callout-fold="-"/);
	assert.match(first, /class="callout-icon"/);
	assert.match(first, /class="trusted"/);
	assert.match(first, /@misc\{report\}/);
	assert.doesNotMatch(first, /Hidden frontmatter/);
	assert.equal(reads, 1);

	const cached = await renderer.render(request);
	assert.equal(cached, first);
	assert.equal(reads, 1);

	const changed = await renderer.render({
		...request,
		modifiedTime: 2,
		sourceSize: markdown.length + 1,
		loadMarkdown: async () => {
			reads++;
			return "# Changed";
		},
	});
	assert.match(changed, /Changed/);
	assert.equal(reads, 2);
});
