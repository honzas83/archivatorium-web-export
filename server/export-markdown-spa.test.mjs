import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { exportMarkdownSpa } from "./export-markdown-spa.mjs";

test("pure Node export creates a compact SPA corpus without Obsidian", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "markdown-spa-export-"));
	const vault = path.join(root, "vault");
	const output = path.join(vault, ".archivatorium");
	const config = path.join(root, "config.json");
	await mkdir(path.join(vault, "Folder"), { recursive: true });
	await writeFile(path.join(vault, "Folder", "Source.md"), `---
title: Source title
aliases:
  - Source alias
tags: Topic/Child
citekey: Source-2026
---
# Source heading

Text with [[Target]] and [Report source](Report.pdf). #Topic/Child #3 #1984a

Inline code \`#CodeTag\` and escaped \\#EscapedTag are not tags.

\`\`\`
#FenceTag
\`\`\`

> [!abstract]
> # Abstract heading
> ## Categories/Topics
> Abstract content.

> [!info] Metadata
> Metadata should not be searchable.

> [!citing this document]
> Citation should not be searchable.

<span>Trusted HTML</span>
`);
	await writeFile(path.join(vault, "Folder", "Target.md"), "# Target\n\nTarget text.");
	await writeFile(path.join(vault, "Folder", "Report.pdf"), "pdf fixture");
	await writeFile(config, JSON.stringify({ exportOptions: { siteName: "Fixture archive" } }));

	try {
		await exportMarkdownSpa({ vaultRoot: vault });
		const defaultMetadata = JSON.parse(await readFile(path.join(output, "site-lib", "metadata.json"), "utf8"));
		assert.equal(defaultMetadata.siteName, "vault");
		assert.equal(defaultMetadata.featureOptions.fileNavigation.showDocumentTitles, false);
		await rm(output, { recursive: true, force: true });
		await mkdir(output, { recursive: true });
		await writeFile(path.join(output, "Must-not-be-indexed.md"), "# Internal output");

		const firstExport = await exportMarkdownSpa({ vaultRoot: vault, configPath: config });
		assert.equal(firstExport.writtenRecords, 3);
		const database = new DatabaseSync(path.join(output, ".server-data", "corpus.sqlite"));
		const records = database.prepare("SELECT payload FROM source_records").all().map((row) => JSON.parse(row.payload));
		database.close();
		const source = records.find((record) => record.data?.sourcePath === "Folder/Source.md");
		const attachment = records.find((record) => record.data?.sourcePath === "Folder/Report.pdf");
		assert.equal(source.data.exportPath, "folder/source.html");
		assert.deepEqual(source.data.aliases, ["Source alias"]);
		assert.deepEqual(source.data.headers, [
			{ heading: "Source heading", level: 1, id: "source-heading" },
			{ heading: "Abstract heading", level: 1, id: "abstract-heading" },
			{ heading: "Categories/Topics", level: 2, id: "categoriestopics" },
		]);
		assert.deepEqual(source.data.attachments, ["folder/report.pdf"]);
		assert.deepEqual(source.data.inlineTags, ["#Topic/Child", "#1984a"]);
		assert.deepEqual(source.data.frontmatterTags, ["#Topic/Child"]);
		assert.deepEqual(source.data.links.sort(), ["folder/report.pdf", "folder/target.html"]);
		assert.match(source.search.content, /Text with Target and \[Report source\]/);
		assert.match(source.search.content, /Trusted HTML/);
		assert.doesNotMatch(source.search.content, /Metadata should not be searchable|Citation should not be searchable|#Topic\/Child|<span>/);
		assert.equal(attachment.kind, "file");
		assert.equal(attachment.data.exportPath, "folder/report.pdf");
		await assert.rejects(stat(path.join(output, "site-lib", "corpus")));
		const shell = await readFile(path.join(output, "index.html"), "utf8");
		assert.match(shell, /webpage.js/);
		assert.match(shell, /site-lib\/styles\/app\.css/);
		assert.doesNotMatch(shell, /obsidian\.css|main-styles\.css|server-spa\.css/);
		assert.match(await readFile(path.join(output, "site-lib", "styles", "app.css"), "utf8"), /#search-wrapper \.search-icon/);
		assert.match(shell, /<base href="\/">/);
		assert.match(shell, /<link rel="icon" href="\/favicon\.png">/);
		assert.equal((await stat(path.join(output, "favicon.png"))).size > 0, true);
		assert.equal((shell.match(/sidebar-collapse-icon/g) ?? []).length, 2);
		assert.equal((shell.match(/sidebar-handle/g) ?? []).length, 2);
		assert.equal(JSON.parse(await readFile(path.join(output, "site-lib", "metadata.json"), "utf8")).serverMetadata, true);
		assert.equal(JSON.parse(await readFile(path.join(output, "site-lib", "metadata.json"), "utf8")).hasFavicon, true);

		await writeFile(config, JSON.stringify({ exportOptions: {
			siteName: "Fixture archive",
			fileNavigationOptions: { showDocumentTitles: true },
		} }));
		await exportMarkdownSpa({ vaultRoot: vault, configPath: config });
		const titledMetadata = JSON.parse(await readFile(path.join(output, "site-lib", "metadata.json"), "utf8"));
		assert.equal(titledMetadata.featureOptions.fileNavigation.showDocumentTitles, true);

		const unchangedExport = await exportMarkdownSpa({ vaultRoot: vault, configPath: config });
		assert.equal(unchangedExport.writtenRecords, 0);
		assert.equal(unchangedExport.reusedRecords, 3);

		await writeFile(path.join(vault, "Folder", "Target.md"), "# Target\n\nChanged target text.");
		const changedExport = await exportMarkdownSpa({ vaultRoot: vault, configPath: config });
		assert.equal(changedExport.writtenRecords, 1);
		assert.equal(changedExport.reusedRecords, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
