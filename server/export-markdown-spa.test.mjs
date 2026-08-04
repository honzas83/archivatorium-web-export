import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { exportMarkdownSpa } from "./export-markdown-spa.mjs";

test("pure Node export creates a compact SPA corpus without Obsidian", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "markdown-spa-export-"));
	const vault = path.join(root, "vault");
	const output = path.join(root, "output");
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

Text with [[Target]] and ![[Report.pdf]]. #Topic/Child

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
		await exportMarkdownSpa({ vaultRoot: vault, exportRoot: output, configPath: config });
		const corpusRoot = path.join(output, "site-lib", "corpus");
		const records = await Promise.all((await readdir(corpusRoot)).map(async (filename) =>
			JSON.parse(await readFile(path.join(corpusRoot, filename), "utf8"))
		));
		const source = records.find((record) => record.data?.sourcePath === "Folder/Source.md");
		const attachment = records.find((record) => record.data?.sourcePath === "Folder/Report.pdf");
		assert.equal(source.data.exportPath, "folder/source.html");
		assert.deepEqual(source.data.aliases, ["Source alias"]);
		assert.deepEqual(source.data.attachments, ["folder/report.pdf"]);
		assert.deepEqual(source.data.links.sort(), ["folder/report.pdf", "folder/target.html"]);
		assert.match(source.search.content, /Text with Target and Report.pdf/);
		assert.match(source.search.content, /Trusted HTML/);
		assert.doesNotMatch(source.search.content, /Metadata should not be searchable|Citation should not be searchable|#Topic\/Child|<span>/);
		assert.equal(attachment.kind, "file");
		assert.equal(attachment.data.exportPath, "folder/report.pdf");
		assert.match(await readFile(path.join(output, "index.html"), "utf8"), /webpage.js/);
		assert.equal(JSON.parse(await readFile(path.join(output, "site-lib", "metadata.json"), "utf8")).serverMetadata, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
