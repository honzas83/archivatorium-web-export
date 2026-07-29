import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("server indexes search corpus and keeps it private", async () => {
	const testRoot = await mkdtemp(path.join(tmpdir(), "obsidian-export-search-"));
	const exportRoot = path.join(testRoot, "export");
	const vaultRoot = path.join(testRoot, "vault");
	const corpusRoot = path.join(exportRoot, "site-lib", "search-corpus");
	await mkdir(corpusRoot, { recursive: true });
	await mkdir(vaultRoot, { recursive: true });
	await writeFile(path.join(exportRoot, "index.html"), "<!doctype html><title>Test</title>");
	await writeFile(path.join(exportRoot, "site-lib", "metadata.json"), JSON.stringify({
		metadataValueToTarget: { example2026: "folder/document.html" },
		metadataShards: {
			webpages: "metadata-pages.json",
			fileInfo: "metadata-files.json",
		},
	}));
	await writeFile(path.join(exportRoot, "site-lib", "metadata-pages.json"), JSON.stringify({
		"folder/document.html": {
			sourcePath: "Folder/Document.md",
			exportPath: "folder/document.html",
			title: "Document title",
		},
	}));
	await writeFile(path.join(exportRoot, "site-lib", "metadata-files.json"), "{}");
	await writeFile(path.join(corpusRoot, "document.json"), JSON.stringify({
		path: "folder/document.html",
		sourcePath: "Folder/Document.md",
		title: "Document title",
		metadata: "citekey example2026",
		aliases: ["Example alias"],
		headers: ["Relevant heading"],
		tags: ["Topic/Child"],
		content: "Complete searchable text remains available.",
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
			processed: 1,
			total: 1,
		});

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
			`${baseURL}/site-lib/search-corpus/document.json`
		);
		assert.equal(privateCorpusResponse.status, 404);
	} finally {
		server.close();
		await once(server, "close");
		await rm(testRoot, { recursive: true, force: true });
	}
});
