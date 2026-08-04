import assert from "node:assert/strict";
import test from "node:test";
import { findObsidianTags, isObsidianTag, normalizeFrontmatterTags } from "./obsidian-tags.mjs";

test("tag parser follows Obsidian tag syntax and Markdown exclusions", () => {
	const markdown = `---
tags: Frontmatter/Only
---
# Heading

#Valid #Nested/Child #123a #123 #123/456 #bad/ #/bad foo#joined \\#escaped
\`#inline-code\`
\`\`\`
#fenced-code
\`\`\`
<!-- #comment -->
<span data-tag="#attribute">#Visible/InHtml</span>
[fragment](#not-a-tag)
`;
	assert.deepEqual(findObsidianTags(markdown).map((match) => match.tag), [
		"#Valid",
		"#Nested/Child",
		"#123a",
		"#Visible/InHtml",
	]);
	assert.equal(isObsidianTag("123"), false);
	assert.equal(isObsidianTag("Topic//Child"), false);
	assert.equal(isObsidianTag("Česko/Plzeň-3"), true);
	assert.deepEqual(normalizeFrontmatterTags(["#Topic/Child", "123", "Česko"]), ["#Topic/Child", "#Česko"]);
});
