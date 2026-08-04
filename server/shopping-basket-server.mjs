#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MarkdownDocumentRenderer } from "./markdown-renderer.mjs";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8000);
const VAULT_ROOT = process.env.VAULT_ROOT
	? path.resolve(process.env.VAULT_ROOT)
	: "";
const EXPORT_ROOT = process.env.EXPORT_ROOT
	? path.resolve(process.env.EXPORT_ROOT)
	: process.cwd();
const PUBLIC_ARCHIVE_ROOT = process.env.PUBLIC_ARCHIVE_ROOT ?? "";
const MAX_REQUEST_BYTES = Number(process.env.MAX_CHECKOUT_BYTES ?? 1_000_000);
const MAX_CHECKOUT_ITEMS = Number(process.env.MAX_CHECKOUT_ITEMS ?? 5000);
const CORPUS_ROOT = path.join(EXPORT_ROOT, "site-lib", "corpus");
const SEARCH_DATA_ROOT = path.join(EXPORT_ROOT, ".server-data");
const CORPUS_DATABASE_PATH = path.join(SEARCH_DATA_ROOT, "corpus.sqlite");
const SEARCH_VALUE_SEPARATOR = "\u001f";
const INDEX_COMMIT_INTERVAL = Math.max(1, Number(process.env.INDEX_COMMIT_INTERVAL ?? 500));
const PAGE_CACHE_ENTRIES = Math.max(1, Number(process.env.PAGE_CACHE_ENTRIES ?? 256));
let corpusDatabasePromise;
let navigationSnapshotPromise;
const markdownRenderer = new MarkdownDocumentRenderer({ maxEntries: PAGE_CACHE_ENTRIES });
const corpusStatus = {
	state: "idle",
	processed: 0,
	total: 0,
};
const searchStatus = corpusStatus;
const metadataStatus = corpusStatus;

const contentTypes = new Map([
	[".html", "text/html; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".wasm", "application/wasm"],
	[".pdf", "application/pdf"],
]);

function requireConfig() {
	if (!VAULT_ROOT) {
		throw new Error("VAULT_ROOT is required.");
	}

	if (!PUBLIC_ARCHIVE_ROOT) {
		throw new Error("PUBLIC_ARCHIVE_ROOT is required.");
	}
}

function send(response, statusCode, body, headers = {}) {
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
	response.writeHead(statusCode, {
		"Content-Length": payload.length,
		...headers,
	});
	response.end(payload);
}

function sendJSON(response, statusCode, value) {
	send(response, statusCode, JSON.stringify(value), {
		"Content-Type": "application/json; charset=utf-8",
	});
}

function tokenizeSearchQuery(query) {
	const terms = String(query).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
	return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

function searchColumnsForType(type) {
	const columns = [];
	if (type & 1) columns.push("title");
	if (type & 2) columns.push("aliases");
	if (type & 4) columns.push("headers");
	if (type & 8) columns.push("tags");
	if (type & 16) columns.push("path");
	if (type & 32) columns.push("content");
	if (type & 64) columns.push("metadata");
	return columns;
}

function joinSearchValues(values) {
	return Array.isArray(values) ? values.map(String).join(SEARCH_VALUE_SEPARATOR) : "";
}

function splitSearchValues(value) {
	return value ? String(value).split(SEARCH_VALUE_SEPARATOR) : [];
}

function logIndexProgress(name, status, filename) {
	console.log(`[companion-${name}] ${status.processed}/${status.total} ${filename}`);
}

function commitIndexBatch(database, name, status) {
	database.exec("COMMIT");
	console.log(`[companion-${name}] committed ${status.processed}/${status.total}`);
	database.exec("BEGIN IMMEDIATE");
}

async function initializeCorpusDatabase() {
	corpusStatus.state = "indexing";
	corpusStatus.processed = 0;
	await mkdir(SEARCH_DATA_ROOT, { recursive: true });
	const database = new DatabaseSync(CORPUS_DATABASE_PATH);
	database.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		CREATE VIRTUAL TABLE IF NOT EXISTS search_documents USING fts5(
			path, source_path UNINDEXED, title, metadata, aliases, headers, tags, content,
			tokenize = 'unicode61 remove_diacritics 2'
		);
		CREATE TABLE IF NOT EXISTS metadata_documents (
			export_path TEXT PRIMARY KEY, source_path TEXT NOT NULL, kind TEXT NOT NULL,
			title TEXT, inline_tags TEXT, frontmatter_tags TEXT, show_in_tree INTEGER NOT NULL,
			tree_order INTEGER NOT NULL, type TEXT, data TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS metadata_redirects (
			value TEXT PRIMARY KEY, export_path TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS corpus_state (
			filename TEXT PRIMARY KEY, export_path TEXT NOT NULL, modified_time REAL NOT NULL, size INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS metadata_documents_source_path ON metadata_documents(source_path);
		CREATE INDEX IF NOT EXISTS metadata_documents_tree ON metadata_documents(show_in_tree, tree_order);
	`);

	const knownRecords = new Map(database.prepare(
		"SELECT filename, export_path, modified_time, size FROM corpus_state"
	).all().map((record) => [record.filename, record]));
	const deleteMetadata = database.prepare("DELETE FROM metadata_documents WHERE export_path = ?");
	const deleteRedirects = database.prepare("DELETE FROM metadata_redirects WHERE export_path = ?");
	const deleteSearch = database.prepare("DELETE FROM search_documents WHERE path = ?");
	const deleteState = database.prepare("DELETE FROM corpus_state WHERE filename = ?");
	const insertMetadata = database.prepare(`
		INSERT OR REPLACE INTO metadata_documents(
			export_path, source_path, kind, title, inline_tags, frontmatter_tags,
			show_in_tree, tree_order, type, data
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const insertRedirect = database.prepare(
		"INSERT OR IGNORE INTO metadata_redirects(value, export_path) VALUES (?, ?)"
	);
	const insertSearch = database.prepare(`
		INSERT INTO search_documents(path, source_path, title, metadata, aliases, headers, tags, content)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const updateState = database.prepare(`
		INSERT OR REPLACE INTO corpus_state(filename, export_path, modified_time, size)
		VALUES (?, ?, ?, ?)
	`);

	let entries = [];
	try {
		entries = await readdir(CORPUS_ROOT, { withFileTypes: true });
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const corpusEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
	corpusStatus.total = corpusEntries.length;
	console.log(`[companion-corpus] indexing ${corpusStatus.total} files from ${CORPUS_ROOT}`);
	const seen = new Set();

	database.exec("BEGIN IMMEDIATE");
	try {
		for (const entry of corpusEntries) {
			seen.add(entry.name);
			corpusStatus.processed++;
			logIndexProgress("corpus", corpusStatus, entry.name);
			const recordPath = path.join(CORPUS_ROOT, entry.name);
			const recordStat = await stat(recordPath);
			const previous = knownRecords.get(entry.name);
			if (previous?.modified_time !== recordStat.mtimeMs || previous?.size !== recordStat.size) {
				const record = JSON.parse(await readFile(recordPath, "utf8"));
				const data = record?.data;
				if (data?.exportPath && data?.sourcePath) {
					if (previous?.export_path) {
						deleteMetadata.run(previous.export_path);
						deleteRedirects.run(previous.export_path);
						deleteSearch.run(previous.export_path);
					}
					deleteMetadata.run(data.exportPath);
					deleteRedirects.run(data.exportPath);
					deleteSearch.run(data.exportPath);
					insertMetadata.run(
						data.exportPath, data.sourcePath, record.kind ?? "file", data.title ?? data.exportPath,
						joinSearchValues(data.inlineTags), joinSearchValues(data.frontmatterTags),
						data.showInTree ? 1 : 0, Number(data.treeOrder ?? 0), String(data.type ?? ""), JSON.stringify(data)
					);
					for (const value of record.redirectValues ?? []) {
						if (typeof value === "string" && value) insertRedirect.run(value, data.exportPath);
					}
					if (record.kind === "webpage" && record.search) {
						const tags = [
							...new Set([...(data.frontmatterTags ?? []), ...(data.inlineTags ?? [])]),
						];
						insertSearch.run(
							data.exportPath, data.sourcePath, data.title ?? data.exportPath,
							record.search.metadata ?? "", joinSearchValues(data.aliases),
							joinSearchValues(record.search.headers), joinSearchValues(tags), record.search.content ?? ""
						);
					}
					updateState.run(entry.name, data.exportPath, recordStat.mtimeMs, recordStat.size);
				}
			}
			if (corpusStatus.processed % INDEX_COMMIT_INTERVAL === 0) {
				commitIndexBatch(database, "corpus", corpusStatus);
			}
		}
		for (const [filename, previous] of knownRecords) {
			if (seen.has(filename)) continue;
			deleteMetadata.run(previous.export_path);
			deleteRedirects.run(previous.export_path);
			deleteSearch.run(previous.export_path);
			deleteState.run(filename);
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		database.close();
		corpusStatus.state = "error";
		throw error;
	}

	corpusStatus.state = "ready";
	console.log(`[companion-corpus] ready: ${corpusStatus.processed}/${corpusStatus.total}`);
	return database;
}

function getCorpusDatabase() {
	corpusDatabasePromise ??= initializeCorpusDatabase();
	return corpusDatabasePromise;
}

function buildTagTree(rows, showInlineTags, showFrontmatterTags) {
	const root = new Map();
	for (const row of rows) {
		const tags = new Set([
			...(showInlineTags ? splitSearchValues(row.inline_tags) : []),
			...(showFrontmatterTags ? splitSearchValues(row.frontmatter_tags) : []),
		]);
		for (const tag of tags) {
			let nodes = root;
			let currentPath = "";
			for (const part of String(tag).replace(/^#+/, "").split("/").map((value) => value.trim()).filter(Boolean)) {
				currentPath = currentPath ? `${currentPath}/${part}` : part;
				let node = nodes.get(part);
				if (!node) {
					node = { name: part, path: currentPath, count: 0, children: new Map() };
					nodes.set(part, node);
				}
				node.count++;
				nodes = node.children;
			}
		}
	}
	const serialize = (nodes) => Array.from(nodes.values())
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
		.map((node) => ({ name: node.name, path: node.path, count: node.count, children: serialize(node.children) }));
	return serialize(root);
}

async function handleMetadataBootstrap(_request, response) {
	try {
		sendJSON(response, 200, await getAppBootstrap());
	} catch (error) {
		console.error("Metadata bootstrap failed:", error);
		sendJSON(response, 500, { error: error.message ?? "Metadata bootstrap failed." });
	}
}

async function getAppBootstrap() {
	const metadata = JSON.parse(await readFile(path.join(EXPORT_ROOT, "site-lib", "metadata.json"), "utf8"));
	const database = await getCorpusDatabase();
	const rows = database.prepare(
		"SELECT inline_tags, frontmatter_tags FROM metadata_documents WHERE kind = 'webpage'"
	).all();
	metadata.tagTree = buildTagTree(
		rows,
		metadata.featureOptions?.tags?.showInlineTags !== false,
		metadata.featureOptions?.tags?.showFrontmatterTags !== false,
	);
	metadata.webpages = {};
	metadata.fileInfo = {};
	metadata.sourceToTarget = {};
	metadata.metadataValueToTarget = {};
	metadata.navigationMode = "lazy";
	return metadata;
}

function normalizeNavigationParent(value) {
	if (!value) return "";
	if (typeof value !== "string" || value.includes("\0") || path.isAbsolute(value)) {
		throw new Error("Invalid navigation path.");
	}
	const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\/+|\/+$/g, "");
	if (normalized === ".") return "";
	if (normalized === ".." || normalized.startsWith("../")) throw new Error("Invalid navigation path.");
	return normalized;
}

async function getNavigationSnapshot() {
	navigationSnapshotPromise ??= (async () => {
		const database = await getCorpusDatabase();
		const childrenByParent = new Map();
		const rows = database.prepare(`
			SELECT source_path, export_path, kind, title, show_in_tree, tree_order, type
			FROM metadata_documents WHERE show_in_tree = 1
		`).all();
		const addChild = (parent, item) => {
			const children = childrenByParent.get(parent) ?? new Map();
			const existing = children.get(item.path);
			if (!existing || item.kind === "document") children.set(item.path, item);
			childrenByParent.set(parent, children);
		};
		for (const row of rows) {
			const parts = String(row.source_path).replaceAll("\\", "/").split("/").filter(Boolean);
			if (parts.length === 0) continue;
			let parent = "";
			for (let index = 0; index < parts.length - 1; index++) {
				const folderPath = parent ? `${parent}/${parts[index]}` : parts[index];
				addChild(parent, { kind: "folder", name: parts[index], path: folderPath, hasChildren: true });
				parent = folderPath;
			}
			addChild(parent, {
				kind: "document",
				name: row.title || parts.at(-1),
				path: row.source_path,
				exportPath: row.export_path,
				type: row.type,
				treeOrder: Number(row.tree_order ?? 0),
				hasChildren: false,
			});
		}
		return childrenByParent;
	})();
	return navigationSnapshotPromise;
}

async function handleNavigation(request, response) {
	try {
		const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const parent = normalizeNavigationParent(requestURL.searchParams.get("parent") ?? "");
		const snapshot = await getNavigationSnapshot();
		const items = Array.from(snapshot.get(parent)?.values() ?? []).sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
			return (a.treeOrder ?? Number.MAX_SAFE_INTEGER) - (b.treeOrder ?? Number.MAX_SAFE_INTEGER) ||
				a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
		});
		sendJSON(response, 200, { parent, items });
	} catch (error) {
		sendJSON(response, 400, { error: error.message ?? "Navigation request failed." });
	}
}

function resolveCorpusLink(database, sourcePath, target) {
	const normalizedTarget = String(target).replaceAll("\\", "/").replace(/^\/+/, "");
	if (!normalizedTarget || normalizedTarget.includes("\0")) return undefined;
	const baseDirectory = path.posix.dirname(sourcePath);
	const candidates = new Set([normalizedTarget]);
	if (!path.posix.extname(normalizedTarget)) candidates.add(`${normalizedTarget}.md`);
	if (!normalizedTarget.startsWith("../")) {
		const relative = path.posix.normalize(path.posix.join(baseDirectory === "." ? "" : baseDirectory, normalizedTarget));
		if (relative !== ".." && !relative.startsWith("../")) {
			candidates.add(relative);
			if (!path.posix.extname(relative)) candidates.add(`${relative}.md`);
		}
	}
	const statement = database.prepare("SELECT export_path, source_path FROM metadata_documents WHERE source_path = ? LIMIT 1");
	for (const candidate of candidates) {
		const row = statement.get(candidate);
		if (row) return { exportPath: row.export_path, sourcePath: row.source_path };
	}
	return undefined;
}

async function handlePage(request, response) {
	try {
		if (!VAULT_ROOT) throw Object.assign(new Error("VAULT_ROOT is required."), { statusCode: 500 });
		const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const exportPath = requestURL.searchParams.get("path")?.replace(/^\/+/, "");
		if (!exportPath) throw Object.assign(new Error("A document path is required."), { statusCode: 400 });
		const database = await getCorpusDatabase();
		const row = database.prepare("SELECT kind, data FROM metadata_documents WHERE export_path = ?").get(exportPath) ??
			(exportPath === "index.html"
				? database.prepare("SELECT kind, data FROM metadata_documents WHERE kind = 'webpage' AND type = 'markdown' ORDER BY tree_order, export_path LIMIT 1").get()
				: undefined);
		if (!row) throw Object.assign(new Error("Document not found."), { statusCode: 404 });
		const data = JSON.parse(row.data);
		if (row.kind !== "webpage" || data.type !== "markdown") {
			throw Object.assign(new Error("Only Markdown documents can be rendered dynamically."), { statusCode: 415 });
		}
		const sourcePath = normalizeVaultPath(data.sourcePath);
		const sourceStat = await stat(sourcePath.absolutePath);
		if (!sourceStat.isFile()) throw Object.assign(new Error("Source document not found."), { statusCode: 404 });
		const html = await markdownRenderer.render({
			sourcePath: sourcePath.sourcePath,
			modifiedTime: sourceStat.mtimeMs,
			sourceSize: sourceStat.size,
			loadMarkdown: () => readFile(sourcePath.absolutePath, "utf8"),
			resolveLink: (target) => resolveCorpusLink(database, sourcePath.sourcePath, target),
		});
		sendJSON(response, 200, { data, html });
	} catch (error) {
		const statusCode = error.statusCode ?? 500;
		if (statusCode >= 500) console.error("Page rendering failed:", error);
		sendJSON(response, statusCode, { error: error.message ?? "Page rendering failed." });
	}
}

async function handleMetadataDocument(request, response) {
	const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
	const exportPath = requestURL.searchParams.get("path")?.replace(/^\/+/, "");
	if (!exportPath) {
		sendJSON(response, 400, { error: "A metadata path is required." });
		return;
	}
	const database = await getCorpusDatabase();
	const row = database.prepare("SELECT data FROM metadata_documents WHERE export_path = ?").get(exportPath);
	if (!row) {
		sendJSON(response, 404, { error: "Metadata document not found." });
		return;
	}
	sendJSON(response, 200, JSON.parse(row.data));
}

async function handleSearch(request, response) {
	try {
		const body = await readJSONBody(request);
		const query = typeof body.query === "string" ? body.query.trim() : "";
		const type = Number(body.type ?? 127);
		const requestedLimit = Number(body.limit ?? 50);
		const limit = Number.isFinite(requestedLimit)
			? Math.max(1, Math.min(Math.trunc(requestedLimit), 5000))
			: 50;
		const tokenQuery = tokenizeSearchQuery(query);
		const columns = searchColumnsForType(type);
		if (!tokenQuery || columns.length === 0) {
			sendJSON(response, 200, { query, items: [] });
			return;
		}

		const matchQuery = `{${columns.join(" ")}} : (${tokenQuery})`;
		const database = await getCorpusDatabase();
		const candidateLimit = type === 8 ? Math.max(limit * 10, 1000) : limit;
		let rows = database.prepare(`
			SELECT path, source_path, title, aliases, headers, tags,
				bm25(search_documents, 0, 0, 2, 8, 1.8, 1.5, 1.3, 1) AS rank
			FROM search_documents
			WHERE search_documents MATCH ?
			ORDER BY rank
			LIMIT ?
		`).all(matchQuery, candidateLimit);

		if (type === 8) {
			const normalizedTag = query.trim().replace(/^#+/, "").toLowerCase();
			rows = rows.filter((row) => splitSearchValues(row.tags).some((tag) => {
				const normalized = tag.trim().replace(/^#+/, "").toLowerCase();
				return normalized === normalizedTag || normalized.startsWith(`${normalizedTag}/`);
			}));
		}

		const items = rows.slice(0, limit).map((row) => ({
			path: row.path,
			sourcePath: row.source_path,
			title: row.title,
			aliases: splitSearchValues(row.aliases),
			headers: splitSearchValues(row.headers),
			tags: splitSearchValues(row.tags),
			score: Math.max(Number.EPSILON, -Number(row.rank)),
		}));
		sendJSON(response, 200, { query, items });
	} catch (error) {
		console.error("Search failed:", error);
		sendJSON(response, 400, { error: error.message ?? "Search failed." });
	}
}

function isPathInside(parent, candidate) {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeVaultFilePath(sourcePath) {
	if (typeof sourcePath !== "string" || sourcePath.length === 0) {
		throw new Error("Each item must include a sourcePath.");
	}

	if (sourcePath.includes("\0") || path.isAbsolute(sourcePath)) {
		throw new Error(`Invalid source path: ${sourcePath}`);
	}

	const normalized = path.posix.normalize(sourcePath.replaceAll("\\", "/"));
	if (normalized.startsWith("../") || normalized === "..") {
		throw new Error(`Invalid source path: ${sourcePath}`);
	}

	const absolutePath = path.resolve(VAULT_ROOT, normalized);
	if (!isPathInside(VAULT_ROOT, absolutePath)) {
		throw new Error(`Invalid source path: ${sourcePath}`);
	}

	return {
		sourcePath: normalized,
		absolutePath,
	};
}

function normalizeVaultPath(sourcePath) {
	const normalized = normalizeVaultFilePath(sourcePath);
	if (!normalized.sourcePath.toLowerCase().endsWith(".md")) {
		throw new Error(`Only Markdown files can be checked out: ${sourcePath}`);
	}
	return normalized;
}

async function readJSONBody(request) {
	let size = 0;
	const chunks = [];

	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_REQUEST_BYTES) {
			throw Object.assign(new Error("Checkout request is too large."), { statusCode: 413 });
		}
		chunks.push(chunk);
	}

	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function loadMetadata() {
	const metadataRoot = path.join(EXPORT_ROOT, "site-lib");
	const metadataPath = path.join(metadataRoot, "metadata.json");
	const raw = await readFile(metadataPath, "utf8");
	const metadata = JSON.parse(raw);
	if (metadata.serverMetadata) {
		const database = await getCorpusDatabase();
		const rows = database.prepare("SELECT export_path, kind, data FROM metadata_documents").all();
		metadata.webpages = {};
		metadata.fileInfo = {};
		metadata.sourceToTarget = {};
		for (const row of rows) {
			const data = JSON.parse(row.data);
			metadata.sourceToTarget[data.sourcePath] = data.exportPath;
			if (row.kind === "webpage") metadata.webpages[row.export_path] = data;
			else metadata.fileInfo[row.export_path] = data;
		}
		metadata.metadataValueToTarget = {};
		for (const row of database.prepare("SELECT value, export_path FROM metadata_redirects").all()) {
			metadata.metadataValueToTarget[row.value] = row.export_path;
		}
		return metadata;
	}
	if (metadata.metadataShards) {
		const resolveShard = (filename) => {
			if (typeof filename !== "string" || !filename.endsWith(".json")) {
				throw new Error("Invalid metadata shard.");
			}
			const shardPath = path.resolve(metadataRoot, filename);
			if (!isPathInside(metadataRoot, shardPath)) {
				throw new Error("Invalid metadata shard path.");
			}
			return shardPath;
		};
		const webpageBuckets = metadata.metadataShards.webpageBuckets;
		const [webpages, fileInfo] = await Promise.all([
			webpageBuckets
				? Promise.all(webpageBuckets.map((bucket) => readFile(resolveShard(bucket), "utf8")))
				: readFile(resolveShard(metadata.metadataShards.webpages), "utf8"),
			readFile(resolveShard(metadata.metadataShards.fileInfo), "utf8"),
		]);
		metadata.webpages = Array.isArray(webpages)
			? Object.assign({}, ...webpages.map((bucket) => JSON.parse(bucket)))
			: JSON.parse(webpages);
		metadata.fileInfo = JSON.parse(fileInfo);
	}
	return metadata;
}

function buildSourceIndexes(metadata) {
	const sourceToTarget = metadata.sourceToTarget ?? {};
	const sourceToDirectTarget = {};
	const basenameToSources = new Map();
	const basenameWithExtensionToSources = new Map();

	for (const fileData of Object.values(metadata.fileInfo ?? {})) {
		if (!fileData?.sourcePath || !fileData?.exportPath) continue;
		sourceToDirectTarget[fileData.sourcePath] = fileData.exportPath;
	}

	for (const sourcePath of Object.keys(sourceToTarget)) {
		const basename = path.posix.basename(sourcePath, path.posix.extname(sourcePath)).toLowerCase();
		const existing = basenameToSources.get(basename) ?? [];
		existing.push(sourcePath);
		basenameToSources.set(basename, existing);

		const basenameWithExtension = path.posix.basename(sourcePath).toLowerCase();
		const existingWithExtension = basenameWithExtensionToSources.get(basenameWithExtension) ?? [];
		existingWithExtension.push(sourcePath);
		basenameWithExtensionToSources.set(basenameWithExtension, existingWithExtension);
	}

	return {
		sourceToTarget,
		sourceToDirectTarget,
		basenameToSources,
		basenameWithExtensionToSources,
	};
}

function normalizePublicRoot(root) {
	return root.endsWith("/") ? root : `${root}/`;
}

function toPublicURL(exportPath) {
	return new URL(exportPath.replace(/^\/+/, ""), normalizePublicRoot(PUBLIC_ARCHIVE_ROOT)).toString();
}

function getPreferredExportPath(sourcePath, indexes) {
	const extension = path.posix.extname(sourcePath).toLowerCase();
	if (extension && extension !== ".md") {
		return indexes.sourceToDirectTarget[sourcePath] ?? indexes.sourceToTarget[sourcePath];
	}

	return indexes.sourceToTarget[sourcePath];
}

function resolveLinkedSource(rawTarget, currentSourcePath, indexes) {
	const target = decodeURI(rawTarget).replaceAll("\\", "/").trim();
	if (!target || target.startsWith("#")) return undefined;
	if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;

	const withoutQuery = target.split(/[?#]/)[0];
	if (!withoutQuery) return undefined;

	const candidates = [];
	const currentDir = path.posix.dirname(currentSourcePath);
	const hasExtension = path.posix.extname(withoutQuery).length > 0;
	const pathCandidates = hasExtension
		? [withoutQuery]
		: [withoutQuery, `${withoutQuery}.md`];

	if (withoutQuery.startsWith("/")) {
		for (const pathCandidate of pathCandidates) {
			candidates.push(path.posix.normalize(pathCandidate.slice(1)));
		}
	} else if (withoutQuery.includes("/")) {
		for (const pathCandidate of pathCandidates) {
			candidates.push(path.posix.normalize(path.posix.join(currentDir, pathCandidate)));
			candidates.push(path.posix.normalize(pathCandidate));
		}
	} else {
		if (hasExtension) {
			const basenameWithExtensionMatches = indexes.basenameWithExtensionToSources.get(withoutQuery.toLowerCase()) ?? [];
			candidates.push(...basenameWithExtensionMatches);
		} else {
			const basenameMatches = indexes.basenameToSources.get(withoutQuery.toLowerCase()) ?? [];
			candidates.push(...basenameMatches);
		}

		for (const pathCandidate of pathCandidates) {
			candidates.push(path.posix.normalize(path.posix.join(currentDir, pathCandidate)));
		}
	}

	return candidates.find((candidate) => indexes.sourceToTarget[candidate]);
}

function splitMarkdownTarget(rawTarget) {
	const hashIndex = rawTarget.indexOf("#");
	const queryIndex = rawTarget.indexOf("?");
	const indexes = [hashIndex, queryIndex].filter((index) => index >= 0);
	const suffixIndex = indexes.length > 0 ? Math.min(...indexes) : -1;

	if (suffixIndex < 0) {
		return {
			target: rawTarget,
			suffix: "",
		};
	}

	return {
		target: rawTarget.slice(0, suffixIndex),
		suffix: rawTarget.slice(suffixIndex),
	};
}

function resolveMarkdownDestination(destination, currentSourcePath, indexes) {
	const trimmed = destination.trim();
	const unwrapped = trimmed.startsWith("<") && trimmed.endsWith(">")
		? trimmed.slice(1, -1)
		: trimmed;
	let splitTarget = splitMarkdownTarget(unwrapped);
	let linkedSource = resolveLinkedSource(splitTarget.target, currentSourcePath, indexes);

	if (linkedSource) {
		return {
			linkedSource,
			suffix: splitTarget.suffix,
		};
	}

	const tokenMatch = trimmed.match(/^(\S+)(\s+.*)$/);
	if (!tokenMatch) return undefined;

	splitTarget = splitMarkdownTarget(tokenMatch[1]);
	linkedSource = resolveLinkedSource(splitTarget.target, currentSourcePath, indexes);
	if (!linkedSource) return undefined;

	return {
		linkedSource,
		suffix: `${splitTarget.suffix}${tokenMatch[2]}`,
	};
}

function rewriteInlineMarkdownLinks(markdown, currentSourcePath, selectedSources, indexes) {
	let output = "";
	let cursor = 0;

	while (cursor < markdown.length) {
		const bang = markdown[cursor] === "!" && markdown[cursor + 1] === "[";
		const startsLink = markdown[cursor] === "[" || bang;
		const labelStart = bang ? cursor + 1 : cursor;

		if (!startsLink) {
			output += markdown[cursor];
			cursor++;
			continue;
		}

		const labelEnd = markdown.indexOf("]", labelStart + 1);
		if (labelEnd < 0 || markdown[labelEnd + 1] !== "(") {
			output += markdown[cursor];
			cursor++;
			continue;
		}

		let depth = 1;
		let destinationEnd = labelEnd + 2;
		while (destinationEnd < markdown.length && depth > 0) {
			const char = markdown[destinationEnd];
			if (char === "(") depth++;
			else if (char === ")") depth--;
			destinationEnd++;
		}

		if (depth !== 0) {
			output += markdown[cursor];
			cursor++;
			continue;
		}

		const label = markdown.slice(labelStart + 1, labelEnd);
		const destination = markdown.slice(labelEnd + 2, destinationEnd - 1);
		const resolved = resolveMarkdownDestination(destination, currentSourcePath, indexes);

		if (!resolved || selectedSources.has(resolved.linkedSource)) {
			output += markdown.slice(cursor, destinationEnd);
		} else {
			const exportPath = getPreferredExportPath(resolved.linkedSource, indexes);
			if (exportPath) {
				output += `${bang ? "!" : ""}[${label}](${toPublicURL(exportPath)}${resolved.suffix})`;
			} else {
				output += markdown.slice(cursor, destinationEnd);
			}
		}

		cursor = destinationEnd;
	}

	return output;
}

function rewriteMarkdownLinks(markdown, currentSourcePath, selectedSources, indexes) {
	let rewritten = rewriteInlineMarkdownLinks(markdown, currentSourcePath, selectedSources, indexes);

	rewritten = rewritten.replace(
		/(!?)\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/g,
		(match, bang, target, hash = "", alias = "") => {
			const linkedSource = resolveLinkedSource(target, currentSourcePath, indexes);
			if (!linkedSource || selectedSources.has(linkedSource)) return match;

			const exportPath = getPreferredExportPath(linkedSource, indexes);
			if (!exportPath) return match;

			const label = alias ? alias.slice(1) : `${target}${hash}`;
			return `${bang}[${label}](${toPublicURL(exportPath)}${hash ? `#${encodeURIComponent(hash.slice(1))}` : ""})`;
		}
	);

	return rewritten;
}

function getOnlineOriginalURL(currentSourcePath, indexes) {
	const exportPath = indexes.sourceToTarget[currentSourcePath];
	return exportPath ? toPublicURL(exportPath) : undefined;
}

function normalizeMetadataValue(value) {
	return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function addOnlineSourceReference(markdown, currentSourcePath, indexes) {
	const onlineOriginalURL = getOnlineOriginalURL(currentSourcePath, indexes);
	if (!onlineOriginalURL || markdown.includes("online_source:")) return markdown;

	let updated = markdown;
	const frontmatterMatch = updated.match(/^---\n([\s\S]*?)\n---/);
	if (frontmatterMatch) {
		const frontmatter = frontmatterMatch[1];
		const sourceLineMatch = frontmatter.match(/^source:\s.*$/m);
		if (sourceLineMatch) {
			const insertAt = frontmatterMatch.index + "---\n".length + sourceLineMatch.index + sourceLineMatch[0].length;
			updated = `${updated.slice(0, insertAt)}\nonline_source: '${onlineOriginalURL}'${updated.slice(insertAt)}`;
		}
	}

	const onlineSourceRow = `> | 🔗&nbsp;online_source: | [Online original](${onlineOriginalURL}) |`;
	updated = updated.replace(
		/(^> \| 🔗&nbsp;source: \| .*$)/m,
		(match) => `${match}\n${onlineSourceRow}`
	);

	return updated;
}

function escapeMarkdownText(value) {
	return String(value ?? "").replace(/[\\[\]]/g, "\\$&").replace(/\r?\n/g, " ");
}

function getBasketBatches(bodyItems, batches) {
	if (Array.isArray(batches) && batches.length > 0) {
		return batches
			.map((batch, index) => ({
				query: String(batch?.query ?? `Search ${index + 1}`),
				items: Array.isArray(batch?.items) ? batch.items : [],
			}))
			.filter((batch) => batch.items.length > 0);
	}

	return [{
		query: "Checkout selection",
		items: Array.isArray(bodyItems) ? bodyItems : [],
	}];
}

function buildCheckoutIndex(bodyItems, batches, selectedSources, indexes) {
	const lines = [
		"# Checkout index",
		"",
		"This vault subset was generated from the shopping basket.",
		"",
		`- Unique Markdown documents: ${selectedSources.size}`,
		`- Search batches: ${getBasketBatches(bodyItems, batches).length}`,
		`- Generated: ${new Date().toISOString()}`,
		"",
		"## Included searches",
		"",
	];

	for (const batch of getBasketBatches(bodyItems, batches)) {
		const uniqueItems = [];
		const seen = new Set();
		for (const item of batch.items) {
			if (!item?.sourcePath || seen.has(item.sourcePath) || !selectedSources.has(item.sourcePath)) continue;
			seen.add(item.sourcePath);
			uniqueItems.push(item);
		}

		lines.push(`### ${escapeMarkdownText(batch.query)} (${uniqueItems.length})`, "");
		for (const item of uniqueItems) {
			const title = escapeMarkdownText(item.title || path.posix.basename(item.sourcePath, ".md"));
			const localLink = encodeURI(item.sourcePath);
			const exportPath = indexes.sourceToTarget[item.sourcePath] ?? item.exportPath;
			const onlineURL = exportPath ? toPublicURL(exportPath) : "";
			const onlinePart = onlineURL ? ` - [online](${onlineURL})` : "";
			lines.push(`- [${title}](${localLink})${onlinePart}`);
		}
		lines.push("");
	}

	lines.push("## Unique documents", "");
	for (const sourcePath of Array.from(selectedSources).sort((a, b) => a.localeCompare(b))) {
		const title = escapeMarkdownText(path.posix.basename(sourcePath, ".md"));
		const exportPath = indexes.sourceToTarget[sourcePath];
		const onlineURL = exportPath ? toPublicURL(exportPath) : "";
		const onlinePart = onlineURL ? ` - [online](${onlineURL})` : "";
		lines.push(`- [${title}](${encodeURI(sourcePath)})${onlinePart}`);
	}
	lines.push("");

	return `${lines.join("\n")}\n`;
}

async function buildCheckoutFiles(items, metadata, batches = []) {
	const normalizedItems = [];
	const seen = new Set();

	if (!Array.isArray(items) || items.length === 0) {
		throw Object.assign(new Error("Checkout request must include at least one item."), { statusCode: 400 });
	}

	if (items.length > MAX_CHECKOUT_ITEMS) {
		throw Object.assign(new Error("Checkout request contains too many items."), { statusCode: 413 });
	}

	for (const item of items) {
		const normalized = normalizeVaultPath(item?.sourcePath);
		if (seen.has(normalized.sourcePath)) continue;
		seen.add(normalized.sourcePath);
		normalizedItems.push(normalized);
	}

	const rootIndex = await getOptionalRootIndex();
	if (rootIndex && !seen.has(rootIndex.sourcePath)) {
		seen.add(rootIndex.sourcePath);
		normalizedItems.unshift(rootIndex);
	}

	const selectedSources = new Set(normalizedItems.map((item) => item.sourcePath));
	const indexes = buildSourceIndexes(metadata);
	const checkoutIndex = buildCheckoutIndex(items, batches, selectedSources, indexes);
	const files = [];
	let hasRootIndex = false;

	for (const item of normalizedItems) {
		const fileStat = await stat(item.absolutePath);
		if (!fileStat.isFile()) {
			throw new Error(`Source path is not a file: ${item.sourcePath}`);
		}

		const markdown = await readFile(item.absolutePath, "utf8");
		const rewrittenMarkdown = rewriteMarkdownLinks(markdown, item.sourcePath, selectedSources, indexes);
		const isRootIndex = item.sourcePath.toLowerCase() === "index.md";
		if (isRootIndex) hasRootIndex = true;
		files.push({
			path: item.sourcePath,
			data: Buffer.from(
				`${isRootIndex ? `${checkoutIndex}\n---\n\n` : ""}${addOnlineSourceReference(rewrittenMarkdown, item.sourcePath, indexes)}`,
				"utf8"
			),
		});
	}

	if (!hasRootIndex) {
		files.unshift({
			path: "index.md",
			data: Buffer.from(checkoutIndex, "utf8"),
		});
	}

	files.push(...await collectObsidianConfigFiles());

	return files;
}

async function getOptionalRootIndex() {
	const sourcePath = "index.md";
	const absolutePath = path.resolve(VAULT_ROOT, sourcePath);
	if (!isPathInside(VAULT_ROOT, absolutePath)) return undefined;

	try {
		const fileStat = await stat(absolutePath);
		if (!fileStat.isFile()) return undefined;
		return { sourcePath, absolutePath };
	} catch {
		return undefined;
	}
}

async function collectObsidianConfigFiles() {
	const obsidianRoot = path.resolve(VAULT_ROOT, ".obsidian");
	if (!isPathInside(VAULT_ROOT, obsidianRoot)) return [];

	try {
		const rootStat = await stat(obsidianRoot);
		if (!rootStat.isDirectory()) return [];
	} catch {
		return [];
	}

	const files = [];
	await collectDirectoryFiles(obsidianRoot, ".obsidian", files);
	return files;
}

async function collectDirectoryFiles(absoluteDirectory, zipDirectory, files) {
	const entries = await readdir(absoluteDirectory, { withFileTypes: true });

	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;

		const absolutePath = path.join(absoluteDirectory, entry.name);
		if (!isPathInside(VAULT_ROOT, absolutePath)) continue;

		const zipPath = path.posix.join(zipDirectory, entry.name);
		if (entry.isDirectory()) {
			await collectDirectoryFiles(absolutePath, zipPath, files);
			continue;
		}

		if (!entry.isFile()) continue;

		files.push({
			path: zipPath,
			data: await readFile(absolutePath),
		});
	}
}

function makeCRCTable() {
	const table = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
}

const crcTable = makeCRCTable();

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
	const year = Math.max(date.getFullYear(), 1980);
	const dosTime =
		(date.getHours() << 11) |
		(date.getMinutes() << 5) |
		Math.floor(date.getSeconds() / 2);
	const dosDate =
		((year - 1980) << 9) |
		((date.getMonth() + 1) << 5) |
		date.getDate();
	return { dosTime, dosDate };
}

function createZip(files) {
	const chunks = [];
	const central = [];
	let offset = 0;
	const { dosTime, dosDate } = dosDateTime();

	for (const file of files) {
		const name = Buffer.from(file.path.replaceAll("\\", "/"), "utf8");
		const data = file.data;
		const crc = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt16LE(dosTime, 10);
		local.writeUInt16LE(dosDate, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);

		chunks.push(local, name, data);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0x0800, 8);
		centralHeader.writeUInt16LE(0, 10);
		centralHeader.writeUInt16LE(dosTime, 12);
		centralHeader.writeUInt16LE(dosDate, 14);
		centralHeader.writeUInt32LE(crc, 16);
		centralHeader.writeUInt32LE(data.length, 20);
		centralHeader.writeUInt32LE(data.length, 24);
		centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(0, 38);
		centralHeader.writeUInt32LE(offset, 42);
		central.push(centralHeader, name);

		offset += local.length + name.length + data.length;
	}

	const centralOffset = offset;
	const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(centralOffset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([...chunks, ...central, end]);
}

async function handleCheckout(request, response) {
	try {
		requireConfig();
		const body = await readJSONBody(request);
		const metadata = await loadMetadata();
		const files = await buildCheckoutFiles(body.items, metadata, body.batches);
		const zip = createZip(files);
		const filename = `vault-subset-${new Date().toISOString().slice(0, 10)}.zip`;

		send(response, 200, zip, {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Cache-Control": "no-store",
		});
	} catch (error) {
		const statusCode = error.statusCode ?? 400;
		console.error("Checkout failed:", error);
		sendJSON(response, statusCode, { error: error.message ?? "Checkout failed." });
	}
}

async function serveStatic(request, response) {
	const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
	let pathname = decodeURIComponent(requestURL.pathname);
	if (pathname === "/server" || pathname.startsWith("/server/") || pathname === "/.export-timings.jsonl") {
		send(response, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
		return;
	}
	if (
		pathname === "/.server-data" ||
		pathname.startsWith("/.server-data/") ||
		pathname === "/.export-progress.json" ||
		pathname === "/site-lib/corpus" ||
		pathname.startsWith("/site-lib/corpus/")
	) {
		send(response, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
		return;
	}

	if (pathname.endsWith("/")) pathname += "index.html";
	if (pathname === "/") pathname = "/index.html";
	const requestedExportPath = pathname.replace(/^\/+/, "");
	try {
		const database = await getCorpusDatabase();
		const document = database.prepare(
			"SELECT kind, type, data FROM metadata_documents WHERE export_path = ?"
		).get(requestedExportPath);
		if (document?.kind === "webpage" && document.type === "markdown" && requestedExportPath !== "index.html") {
			const shellPath = path.join(EXPORT_ROOT, "index.html");
			const shellStat = await stat(shellPath);
			response.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Length": shellStat.size,
				"Cache-Control": "no-cache",
			});
			if (request.method === "HEAD") {
				response.end();
				return;
			}
			createReadStream(shellPath).on("error", () => response.destroy()).pipe(response);
			return;
		}
		if (document?.kind === "file" && document.type === "attachment" && VAULT_ROOT) {
			const data = JSON.parse(document.data);
			const source = normalizeVaultFilePath(data.sourcePath);
			const sourceStat = await stat(source.absolutePath);
			if (!sourceStat.isFile()) throw new Error("Not an attachment");
			response.writeHead(200, {
				"Content-Type": contentTypes.get(path.extname(source.absolutePath).toLowerCase()) ?? "application/octet-stream",
				"Content-Length": sourceStat.size,
			});
			if (request.method === "HEAD") {
				response.end();
				return;
			}
			createReadStream(source.absolutePath).on("error", () => response.destroy()).pipe(response);
			return;
		}
	} catch (error) {
		console.error("SPA shell lookup failed:", error);
	}

	const absolutePath = path.resolve(EXPORT_ROOT, `.${pathname}`);
	if (!isPathInside(EXPORT_ROOT, absolutePath)) {
		send(response, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
		return;
	}

	try {
		const fileStat = await stat(absolutePath);
		if (!fileStat.isFile()) throw new Error("Not a file");
		response.writeHead(200, {
			"Content-Type": contentTypes.get(path.extname(absolutePath).toLowerCase()) ?? "application/octet-stream",
			"Content-Length": fileStat.size,
		});
		if (request.method === "HEAD") {
			response.end();
			return;
		}
		createReadStream(absolutePath)
			.on("error", () => response.destroy())
			.pipe(response);
	} catch {
		const redirectPath = await resolveMetadataRedirect(pathname);
		if (redirectPath) {
			send(response, 302, "Found", {
				"Content-Type": "text/plain; charset=utf-8",
				"Location": `/${redirectPath}`,
			});
			return;
		}

		send(response, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
	}
}

async function resolveMetadataRedirect(pathname) {
	try {
		const bootstrap = JSON.parse(await readFile(
			path.join(EXPORT_ROOT, "site-lib", "metadata.json"),
			"utf8"
		));
		const metadataValue = normalizeMetadataValue(pathname.replace(/^\/+/, "").replace(/\.html$/i, ""));
		if (bootstrap.serverMetadata) {
			const database = await getCorpusDatabase();
			return database.prepare("SELECT export_path FROM metadata_redirects WHERE value = ?").get(metadataValue)?.export_path;
		}
		const metadata = await loadMetadata();
		return metadata.metadataValueToTarget?.[metadataValue];
	} catch {
		return undefined;
	}
}

export const internals = {
	buildSourceIndexes,
	normalizeVaultPath,
	normalizeVaultFilePath,
	normalizeNavigationParent,
	resolveLinkedSource,
	resolveCorpusLink,
	rewriteMarkdownLinks,
	rewriteInlineMarkdownLinks,
	resolveMarkdownDestination,
	addOnlineSourceReference,
	buildCheckoutIndex,
	buildCheckoutFiles,
	createZip,
};

export function createShoppingBasketServer() {
	return createServer(async (request, response) => {
		const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		if (request.method === "GET" && requestURL.pathname === "/api/search/status") {
			sendJSON(response, 200, searchStatus);
			return;
		}
		if (request.method === "GET" && requestURL.pathname === "/api/metadata/status") {
			sendJSON(response, 200, metadataStatus);
			return;
		}
		if (request.method === "GET" && requestURL.pathname === "/api/metadata/bootstrap") {
			await handleMetadataBootstrap(request, response);
			return;
		}
		if (request.method === "GET" && requestURL.pathname === "/api/app/bootstrap") {
			await handleMetadataBootstrap(request, response);
			return;
		}
		if (request.method === "GET" && requestURL.pathname === "/api/metadata/document") {
			await handleMetadataDocument(request, response);
			return;
		}
		if (request.method === "GET" && requestURL.pathname === "/api/navigation") {
			await handleNavigation(request, response);
			return;
		}
		if (request.method === "GET" && requestURL.pathname === "/api/page") {
			await handlePage(request, response);
			return;
		}
		if (request.method === "POST" && requestURL.pathname === "/api/search") {
			await handleSearch(request, response);
			return;
		}
		if (request.method === "POST" && requestURL.pathname === "/api/checkout") {
			await handleCheckout(request, response);
			return;
		}

		if (request.method === "GET" || request.method === "HEAD") {
			await serveStatic(request, response);
			return;
		}

		send(response, 405, "Method not allowed", { "Content-Type": "text/plain; charset=utf-8" });
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	getCorpusDatabase().catch((error) => {
		console.error("Corpus index initialization failed:", error);
	});
	const server = createShoppingBasketServer();
	server.listen(PORT, HOST, () => {
		console.log(`Shopping basket server listening on http://${HOST}:${PORT}`);
		console.log(`Serving export from ${EXPORT_ROOT}`);
		console.log(`Vault configured for checkout from ${VAULT_ROOT}`);
	});
}
