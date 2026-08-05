import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { exportMarkdownSpa } from "./export-markdown-spa.mjs";

test("server resumes an incomplete SQLite database and keeps server data private", async () => {
	const testRoot = await mkdtemp(path.join(tmpdir(), "obsidian-export-search-"));
	const vaultRoot = path.join(testRoot, "vault");
	const serverRoot = path.join(vaultRoot, ".archivatorium");
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
	await writeFile(configPath, JSON.stringify({
		exportOptions: {
			siteName: "Test archive",
			shoppingBasketOptions: { enabled: true, checkoutEndpoint: "/api/checkout", maxCheckoutItems: 1 },
		},
	}));
	await exportMarkdownSpa({ vaultRoot, configPath });
	const generatedMetadataPath = path.join(serverRoot, "site-lib", "metadata.json");
	const staleMetadata = JSON.parse(await readFile(generatedMetadataPath, "utf8"));
	staleMetadata.applicationVersion = "stale-application";
	await writeFile(generatedMetadataPath, JSON.stringify(staleMetadata));
	const incompleteDatabase = new DatabaseSync(path.join(serverRoot, "corpus.sqlite"));
	incompleteDatabase.exec("DELETE FROM export_state");
	incompleteDatabase.close();
	await writeFile(path.join(serverRoot, ".export-files.log"), "private progress");
	assert.equal((await stat(path.join(serverRoot, "corpus.sqlite"))).isFile(), true);
	await assert.rejects(stat(path.join(serverRoot, "site-lib", "corpus")));

	process.env.VAULT_ROOT = vaultRoot;
	process.env.PUBLIC_ARCHIVE_ROOT = "https://archive.example/";
	const { createArchivatoriumServer, internals } = await import(
		`./server.mjs?test=${Date.now()}`
	);
	assert.equal(internals.getMaxCheckoutItems({ featureOptions: { shoppingBasket: { maxCheckoutItems: 0 } } }), Infinity);
	assert.equal(internals.getMaxCheckoutItems({ featureOptions: { shoppingBasket: { maxCheckoutItems: 25 } } }), 25);
	const server = createArchivatoriumServer();

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
		assert.equal(searchResult.total, 1);
		assert.equal(searchResult.items[0].sourcePath, "Folder/Document.md");
		assert.equal("tags" in searchResult.items[0], false);
		assert.equal("headers" in searchResult.items[0], false);
		const emptySearchPageResponse = await fetch(`${baseURL}/api/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "searchable", type: 32, offset: 1, limit: 50 }),
		});
		const emptySearchPage = await emptySearchPageResponse.json();
		assert.equal(emptySearchPage.total, 1);
		assert.deepEqual(emptySearchPage.items, []);
		assert.equal((await stat(path.join(serverRoot, "corpus.sqlite"))).isFile(), true);

		const multiwordResponse = await fetch(`${baseURL}/api/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "complete searchable text", type: 32, limit: 50 }),
		});
		assert.equal(multiwordResponse.status, 200);
		assert.deepEqual((await multiwordResponse.json()).items.map((item) => item.sourcePath), ["Folder/Document.md"]);

		const reorderedResponse = await fetch(`${baseURL}/api/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "text complete", type: 32, limit: 50 }),
		});
		assert.deepEqual((await reorderedResponse.json()).items.map((item) => item.sourcePath), ["Folder/Document.md"]);

		const missingTermResponse = await fetch(`${baseURL}/api/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "complete nonexistent", type: 32, limit: 50 }),
		});
		assert.deepEqual((await missingTermResponse.json()).items, []);

		const lexicalResponse = await fetch(`${baseURL}/api/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "content", type: 32, limit: 50 }),
		});
		assert.deepEqual(
			(await lexicalResponse.json()).items.map((item) => item.sourcePath),
			["Archive/Loose.md", "Target.md"],
		);

		const statusResponse = await fetch(`${baseURL}/api/search/status`);
		assert.equal(statusResponse.status, 200);
		assert.deepEqual(await statusResponse.json(), {
			state: "ready",
			processed: 4,
			total: 4,
		});

		const bootstrapResponse = await fetch(`${baseURL}/api/app/bootstrap`);
		assert.equal(bootstrapResponse.status, 200);
		const bootstrap = await bootstrapResponse.json();
		assert.equal(bootstrap.navigationMode, "lazy");
		assert.equal(bootstrap.documentCount, 3);
		assert.notEqual(bootstrap.applicationVersion, "stale-application");
		assert.equal(bootstrap.tagTree.find((item) => item.path === "Topic")?.hasChildren, true);
		assert.deepEqual(bootstrap.tagTree.find((item) => item.path === "Topic")?.children, []);
		const tagChildrenResponse = await fetch(`${baseURL}/api/tags?parent=Topic`);
		assert.equal(tagChildrenResponse.status, 200);
		assert.deepEqual((await tagChildrenResponse.json()).items.map((item) => item.path), ["Topic/Child"]);

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
		assert.equal(tagResult.total, 1);
		assert.equal(tagResult.items[0].navigationTitle, "Document");

		const checkoutSummaryResponse = await fetch(`${baseURL}/api/checkout/summary`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				items: [],
				batches: [{ kind: "query", query: "Searchable", searchQuery: "searchable", type: 32, excludedSourcePaths: [] }],
			}),
		});
		assert.equal(checkoutSummaryResponse.status, 200);
		assert.deepEqual(await checkoutSummaryResponse.json(), { count: 1 });

		const streamedCheckoutResponse = await fetch(`${baseURL}/api/checkout`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ items: [{ sourcePath: "Folder/Document.md" }] }),
		});
		assert.equal(streamedCheckoutResponse.status, 200);
		assert.equal(streamedCheckoutResponse.headers.get("content-length"), null);
		const streamedZip = Buffer.from(await streamedCheckoutResponse.arrayBuffer());
		assert.equal(streamedZip.readUInt32LE(0), 0x04034b50);
		assert.equal(streamedZip.readUInt32LE(streamedZip.length - 22), 0x06054b50);

		const redirectResponse = await fetch(`${baseURL}/example2026`, {
			redirect: "manual",
		});
		assert.equal(redirectResponse.status, 302);
		assert.equal(redirectResponse.headers.get("location"), "/folder/document.html");

		const privateCorpusResponse = await fetch(`${baseURL}/corpus.sqlite`);
		assert.equal(privateCorpusResponse.status, 404);
		assert.equal((await fetch(`${baseURL}/.export-files.log`)).status, 404);
		const oversizedCheckoutResponse = await fetch(`${baseURL}/api/checkout`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				items: [
					{ sourcePath: "Folder/Document.md" },
					{ sourcePath: "Target.md" },
				],
			}),
		});
		assert.equal(oversizedCheckoutResponse.status, 413);
		assert.match(await oversizedCheckoutResponse.text(), /configured limit of 1 item/);

		await rm(path.join(serverRoot, "index.html"));
		const { createArchivatoriumServer: createRecoveryServer } = await import(
			`./server.mjs?app-recovery=${Date.now()}`
		);
		const recoveryServer = createRecoveryServer();
		try {
			recoveryServer.listen(0, "127.0.0.1");
			await once(recoveryServer, "listening");
			const recoveryAddress = recoveryServer.address();
			assert(recoveryAddress && typeof recoveryAddress === "object");
			const recoveryResponse = await fetch(`http://127.0.0.1:${recoveryAddress.port}/`);
			assert.equal(recoveryResponse.status, 200);
			assert.equal((await stat(path.join(serverRoot, "index.html"))).isFile(), true);
		} finally {
			recoveryServer.close();
			await once(recoveryServer, "close");
		}
	} finally {
		server.close();
		await once(server, "close");
		await rm(testRoot, { recursive: true, force: true });
	}
});
