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

| Column | Value |
| --- | --- |
| A | B |

> [!info] Metadata
> <span class="trusted">Trusted HTML</span>

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
			"Map.png": { exportPath: "assets/map.png", sourcePath: "Map.png" },
			"Report.pdf": { exportPath: "assets/report.pdf", sourcePath: "Report.pdf" },
		}[target]),
	};

	const first = await renderer.render(request);
	assert.match(first, /<a class="internal-link" href="target.html">Linked target<\/a>/);
	assert.match(first, /<img class="internal-embed" src="\/assets\/map.png" alt="Map.png">/);
	assert.match(first, /<iframe class="internal-embed" src="\/assets\/report.pdf" title="Report.pdf"><\/iframe>/);
	assert.match(first, /<table>/);
	assert.match(first, /data-callout="info"/);
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
