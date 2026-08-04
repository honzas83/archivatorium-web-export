import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("server indexes the unified corpus and keeps it private", async () => {
	const testRoot = await mkdtemp(path.join(tmpdir(), "obsidian-export-search-"));
	const exportRoot = path.join(testRoot, "export");
	const vaultRoot = path.join(testRoot, "vault");
	const corpusRoot = path.join(exportRoot, "site-lib", "corpus");
	await mkdir(corpusRoot, { recursive: true });
	await mkdir(vaultRoot, { recursive: true });
	await writeFile(path.join(exportRoot, "index.html"), "<!doctype html><main id='shell'>Test SPA shell</main>");
	await mkdir(path.join(vaultRoot, "Folder"), { recursive: true });
	await writeFile(path.join(vaultRoot, "Folder", "Document.md"), `---
tags: Topic/Child
---
# Document title

Version one with [[Target]] and #Topic/Child.

> [!info] Metadata
> <span class="trusted">trusted HTML</span>
`);
	await writeFile(path.join(vaultRoot, "Target.md"), "# Target\n\nTarget content.");
	await writeFile(path.join(exportRoot, "site-lib", "metadata.json"), JSON.stringify({
		serverMetadata: true,
	}));
	await writeFile(path.join(corpusRoot, "document.json"), JSON.stringify({
		kind: "webpage",
		data: {
			createdTime: 0,
			modifiedTime: 0,
			sourceSize: 0,
			sourcePath: "Folder/Document.md",
			exportPath: "folder/document.html",
			showInTree: true,
			treeOrder: 0,
			backlinks: [],
			type: "markdown",
			data: null,
			title: "Document title",
			aliases: ["Example alias"],
			inlineTags: ["Topic/Child"],
			frontmatterTags: [],
			headers: [],
			links: [],
			attachments: [],
			pathToRoot: ".",
			icon: "",
			description: "",
			author: "",
			coverImageURL: "",
			fullURL: "",
		},
		redirectValues: ["example2026"],
		search: {
			metadata: "citekey example2026",
			headers: ["Relevant heading"],
			content: "Complete searchable text remains available.",
		},
	}));
	await writeFile(path.join(corpusRoot, "target.json"), JSON.stringify({
		kind: "webpage",
		data: {
			createdTime: 0,
			modifiedTime: 0,
			sourceSize: 0,
			sourcePath: "Target.md",
			exportPath: "target.html",
			showInTree: true,
			treeOrder: 1,
			backlinks: ["folder/document.html"],
			type: "markdown",
			data: null,
			title: "Target",
			aliases: [],
			inlineTags: [],
			frontmatterTags: [],
			headers: [],
			links: [],
			attachments: [],
			pathToRoot: ".",
			icon: "",
			description: "",
			author: "",
			coverImageURL: "",
			fullURL: "",
		},
		search: { metadata: "", headers: ["Target"], content: "Target content." },
	}));

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
			processed: 2,
			total: 2,
		});

		const bootstrapResponse = await fetch(`${baseURL}/api/app/bootstrap`);
		assert.equal(bootstrapResponse.status, 200);
		assert.equal((await bootstrapResponse.json()).navigationMode, "lazy");

		const rootNavigation = await fetch(`${baseURL}/api/navigation`);
		assert.deepEqual((await rootNavigation.json()).items.map((item) => item.path), ["Folder", "Target.md"]);
		const folderNavigation = await fetch(`${baseURL}/api/navigation?parent=Folder`);
		assert.deepEqual((await folderNavigation.json()).items.map((item) => item.exportPath), ["folder/document.html"]);

		const pageResponse = await fetch(`${baseURL}/api/page?path=folder/document.html`);
		assert.equal(pageResponse.status, 200);
		const page = await pageResponse.json();
		assert.equal(page.data.sourcePath, "Folder/Document.md");
		assert.match(page.html, /Version one/);
		assert.match(page.html, /class="trusted"/);
		assert.match(page.html, /href="target.html"/);
		assert.match(page.html, /data-callout="info"/);

		const shellResponse = await fetch(`${baseURL}/folder/document.html`);
		assert.equal(shellResponse.status, 200);
		assert.match(await shellResponse.text(), /Test SPA shell/);

		await writeFile(path.join(vaultRoot, "Folder", "Document.md"), "# Document title\n\nVersion two.");
		const updatedPageResponse = await fetch(`${baseURL}/api/page?path=folder/document.html`);
		assert.match((await updatedPageResponse.json()).html, /Version two/);

		const tagResponse = await fetch(`${baseURL}/api/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "#Topic", type: 8, limit: 50 }),
		});
		assert.equal(tagResponse.status, 200);
		assert.equal((await tagResponse.json()).items.length, 1);

		const redirectResponse = await fetch(`${baseURL}/example2026`, {
			redirect: "manual",
		});
		assert.equal(redirectResponse.status, 302);
		assert.equal(redirectResponse.headers.get("location"), "/folder/document.html");

		const privateCorpusResponse = await fetch(
			`${baseURL}/site-lib/corpus/document.json`
		);
		assert.equal(privateCorpusResponse.status, 404);
	} finally {
		server.close();
		await once(server, "close");
		await rm(testRoot, { recursive: true, force: true });
	}
});
