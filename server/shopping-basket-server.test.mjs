import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { exportMarkdownSpa } from "./export-markdown-spa.mjs";

test("server opens the direct SQLite export and keeps legacy corpus paths private", async () => {
	const testRoot = await mkdtemp(path.join(tmpdir(), "obsidian-export-search-"));
	const exportRoot = path.join(testRoot, "export");
	const vaultRoot = path.join(testRoot, "vault");
	await mkdir(vaultRoot, { recursive: true });
	await mkdir(path.join(vaultRoot, ".obsidian", "plugins", "archivatorium-web-export"), { recursive: true });
	await mkdir(path.join(vaultRoot, "Folder"), { recursive: true });
	await mkdir(path.join(vaultRoot, "Archive"), { recursive: true });
	await mkdir(path.join(vaultRoot, "Attachments"), { recursive: true });
	await writeFile(path.join(vaultRoot, "Folder", "Document.md"), `---
tags: Topic/Child
citekey: example2026
---
# Document title

Version one with complete searchable text, [[Target]], [Loose](Loose.md), ![[Attachments/Report.pdf]] and #Topic/Child.

> [!info] Metadata
> <span class="trusted">trusted HTML</span>
`);
	await writeFile(path.join(vaultRoot, "Target.md"), "# Target\n\nTarget content.");
	await writeFile(path.join(vaultRoot, "Archive", "Loose.md"), "# Loose\n\nLoose content.");
	await writeFile(path.join(vaultRoot, "Attachments", "Report.pdf"), "PDF fixture");
	const configPath = path.join(vaultRoot, ".obsidian", "plugins", "archivatorium-web-export", "data.json");
	await writeFile(configPath, JSON.stringify({ exportOptions: { siteName: "Test archive" } }));
	await exportMarkdownSpa({ vaultRoot, exportRoot, configPath });
	await writeFile(path.join(exportRoot, ".export-files.log"), "private progress");
	await assert.rejects(stat(path.join(exportRoot, "site-lib", "corpus")));

	process.env.EXPORT_ROOT = exportRoot;
	process.env.VAULT_ROOT = vaultRoot;
	process.env.PUBLIC_ARCHIVE_ROOT = "https://archive.example/";
	const { createShoppingBasketServer } = await import(
		`./shopping-basket-server.mjs?test=${Date.now()}`
	);
	const server = createShoppingBasketServer();

	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert(address && typeof address === "object");
		const baseURL = `http://127.0.0.1:${address.port}`;

		const searchResponse = await fetch(`${baseURL}/api/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "searchable", type: 32, limit: 50 }),
		});
		assert.equal(searchResponse.status, 200);
		const searchResult = await searchResponse.json();
		assert.equal(searchResult.items.length, 1);
		assert.equal(searchResult.items[0].sourcePath, "Folder/Document.md");

		const statusResponse = await fetch(`${baseURL}/api/search/status`);
		assert.equal(statusResponse.status, 200);
		assert.deepEqual(await statusResponse.json(), {
			state: "ready",
			processed: 4,
			total: 4,
		});

		const bootstrapResponse = await fetch(`${baseURL}/api/app/bootstrap`);
		assert.equal(bootstrapResponse.status, 200);
		assert.equal((await bootstrapResponse.json()).navigationMode, "lazy");

		const rootNavigation = await fetch(`${baseURL}/api/navigation`);
		const rootNavigationItems = (await rootNavigation.json()).items;
		assert.deepEqual(rootNavigationItems.map((item) => item.path), ["Archive", "Folder", "Target.md"]);
		assert.equal(rootNavigationItems.find((item) => item.path === "Target.md")?.name, "Target");
		const folderNavigation = await fetch(`${baseURL}/api/navigation?parent=Folder`);
		const folderNavigationItems = (await folderNavigation.json()).items;
		assert.deepEqual(folderNavigationItems.map((item) => item.exportPath), ["folder/document.html"]);
		assert.equal(folderNavigationItems[0].name, "Document");

		const pageResponse = await fetch(`${baseURL}/api/page?path=folder/document.html`);
		assert.equal(pageResponse.status, 200);
		const page = await pageResponse.json();
		assert.equal(page.data.sourcePath, "Folder/Document.md");
		assert.match(page.html, /Version one/);
		assert.match(page.html, /class="trusted"/);
		assert.match(page.html, /href="target.html"/);
		assert.match(page.html, /href="archive\/loose.html"/);
		assert.match(page.html, /src="\/attachments\/report.pdf"/);
		assert.match(page.html, /data-callout="info"/);

		const rootPageResponse = await fetch(`${baseURL}/api/page?path=index.html`);
		assert.equal((await rootPageResponse.json()).data.sourcePath, "Archive/Loose.md");

		const attachmentResponse = await fetch(`${baseURL}/attachments/report.pdf`);
		assert.equal(attachmentResponse.status, 200);
		assert.equal(await attachmentResponse.text(), "PDF fixture");

		const attachmentPageResponse = await fetch(`${baseURL}/api/page?path=attachments/report.pdf`);
		assert.equal(attachmentPageResponse.status, 200);
		const attachmentPage = await attachmentPageResponse.json();
		assert.match(attachmentPage.html, /class="document-pdf-embed"/);
		assert.doesNotMatch(attachmentPage.html, /markdown-preview-sizer/);

		const shellResponse = await fetch(`${baseURL}/folder/document.html`);
		assert.equal(shellResponse.status, 200);
		assert.match(await shellResponse.text(), /webpage.js/);

		await writeFile(path.join(vaultRoot, "Folder", "Document.md"), "# Document title\n\nVersion two.");
		const updatedPageResponse = await fetch(`${baseURL}/api/page?path=folder/document.html`);
		assert.match((await updatedPageResponse.json()).html, /Version two/);

		const tagResponse = await fetch(`${baseURL}/api/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "#Topic", type: 8, limit: 50 }),
		});
		assert.equal(tagResponse.status, 200);
		const tagResult = await tagResponse.json();
		assert.equal(tagResult.items.length, 1);
		assert.equal(tagResult.items[0].navigationTitle, "Document");

		const redirectResponse = await fetch(`${baseURL}/example2026`, {
			redirect: "manual",
		});
		assert.equal(redirectResponse.status, 302);
		assert.equal(redirectResponse.headers.get("location"), "/folder/document.html");

		const privateCorpusResponse = await fetch(
			`${baseURL}/site-lib/corpus/document.json`
		);
		assert.equal(privateCorpusResponse.status, 404);
		assert.equal((await fetch(`${baseURL}/.export-files.log`)).status, 404);
	} finally {
		server.close();
		await once(server, "close");
		await rm(testRoot, { recursive: true, force: true });
	}
});
