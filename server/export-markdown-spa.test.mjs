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

Text with [[Target]] and [Report source](Report.pdf). #Topic/Child

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
		const defaultOutput = path.join(root, "default-output");
		await exportMarkdownSpa({ vaultRoot: vault, exportRoot: defaultOutput });
		const defaultMetadata = JSON.parse(await readFile(path.join(defaultOutput, "site-lib", "metadata.json"), "utf8"));
		assert.equal(defaultMetadata.siteName, "vault");

		const firstExport = await exportMarkdownSpa({ vaultRoot: vault, exportRoot: output, configPath: config });
		assert.equal(firstExport.writtenRecords, 3);
		const database = new DatabaseSync(path.join(output, ".server-data", "corpus.sqlite"));
		const records = database.prepare("SELECT payload FROM source_records").all().map((row) => JSON.parse(row.payload));
		database.close();
		const source = records.find((record) => record.data?.sourcePath === "Folder/Source.md");
		const attachment = records.find((record) => record.data?.sourcePath === "Folder/Report.pdf");
		assert.equal(source.data.exportPath, "folder/source.html");
		assert.deepEqual(source.data.aliases, ["Source alias"]);
		assert.deepEqual(source.data.attachments, ["folder/report.pdf"]);
		assert.deepEqual(source.data.links.sort(), ["folder/report.pdf", "folder/target.html"]);
		assert.match(source.search.content, /Text with Target and \[Report source\]/);
		assert.match(source.search.content, /Trusted HTML/);
		assert.doesNotMatch(source.search.content, /Metadata should not be searchable|Citation should not be searchable|#Topic\/Child|<span>/);
		assert.equal(attachment.kind, "file");
		assert.equal(attachment.data.exportPath, "folder/report.pdf");
		await assert.rejects(stat(path.join(output, "site-lib", "corpus")));
		const shell = await readFile(path.join(output, "index.html"), "utf8");
		assert.match(shell, /webpage.js/);
		assert.match(shell, /<base href="\/">/);
		assert.equal((shell.match(/sidebar-collapse-icon/g) ?? []).length, 2);
		assert.equal((shell.match(/sidebar-handle/g) ?? []).length, 2);
		assert.equal(JSON.parse(await readFile(path.join(output, "site-lib", "metadata.json"), "utf8")).serverMetadata, true);

		const unchangedExport = await exportMarkdownSpa({ vaultRoot: vault, exportRoot: output, configPath: config });
		assert.equal(unchangedExport.writtenRecords, 0);
		assert.equal(unchangedExport.reusedRecords, 3);

		await writeFile(path.join(vault, "Folder", "Target.md"), "# Target\n\nChanged target text.");
		const changedExport = await exportMarkdownSpa({ vaultRoot: vault, exportRoot: output, configPath: config });
		assert.equal(changedExport.writtenRecords, 1);
		assert.equal(changedExport.reusedRecords, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
