#!/usr/bin/env node
import { createServer } from "node:http";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportMarkdownSpa, getMarkdownSpaApplicationVersion, RECORD_FORMAT_VERSION, SERVER_RUNTIME_FILENAMES, writeMarkdownSpaApplication } from "./export-markdown-spa.mjs";
import { MarkdownDocumentRenderer } from "./markdown-renderer.mjs";
import { resolveCorpusDatabasePath, resolveServerRoot, resolveVaultRoot } from "./vault-layout.mjs";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8000);
const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
const VAULT_ROOT = resolveVaultRoot(process.env.VAULT_ROOT || (IS_MAIN ? process.argv[2] : ""));
const SERVER_ROOT = resolveServerRoot(VAULT_ROOT);
const PUBLIC_ARCHIVE_ROOT = process.env.PUBLIC_ARCHIVE_ROOT ?? "";
const MAX_REQUEST_BYTES = Number(process.env.MAX_CHECKOUT_BYTES ?? 1_000_000);
const MAX_CHECKOUT_ITEMS_OVERRIDE = process.env.MAX_CHECKOUT_ITEMS;
const DEFAULT_MAX_CHECKOUT_ITEMS = 0;
const MINIMUM_SEARCH_API_LIMIT = 1001;
const CORPUS_DATABASE_PATH = resolveCorpusDatabasePath(VAULT_ROOT);
const PAGE_CACHE_ENTRIES = Math.max(1, Number(process.env.PAGE_CACHE_ENTRIES ?? 256));
let corpusDatabasePromise;
const markdownRenderer = new MarkdownDocumentRenderer({ maxEntries: PAGE_CACHE_ENTRIES });
const corpusStatus = {
	state: "idle",
	processed: 0,
	total: 0,
};
const searchStatus = corpusStatus;
const metadataStatus = corpusStatus;
const APPLICATION_FILES = [
	"index.html",
	"favicon.png",
	"site-lib/metadata.json",
	"site-lib/styles/app.css",
	"site-lib/scripts/webpage.js",
	...SERVER_RUNTIME_FILENAMES.map((filename) => `server/${filename}`),
	"server/package.json",
];

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

function escapeHTML(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function renderAttachmentDocument(data) {
	const title = path.posix.basename(data.sourcePath ?? data.exportPath ?? "Attachment");
	const source = `/${encodeURI(data.exportPath)}`;
	if (String(data.exportPath).toLowerCase().endsWith(".pdf")) {
		return `<div class="obsidian-document markdown-preview-view markdown-rendered" data-type="attachment"><iframe class="document-pdf-embed" src="${escapeHTML(source)}" title="${escapeHTML(title)}"></iframe></div>`;
	}
	return `<div class="obsidian-document markdown-preview-view markdown-rendered is-readable-line-width" data-type="attachment"><div class="markdown-preview-sizer markdown-preview-section"><div class="header"><h1 class="page-title heading inline-title">${escapeHTML(title)}</h1><div class="data-bar"></div></div><p><a href="${escapeHTML(source)}">${escapeHTML(title)}</a></p></div></div>`;
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

function getMaxCheckoutItems(metadata) {
	const configured = MAX_CHECKOUT_ITEMS_OVERRIDE ??
		metadata?.featureOptions?.shoppingBasket?.maxCheckoutItems ??
		DEFAULT_MAX_CHECKOUT_ITEMS;
	const value = Number(configured);
	if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
	const normalized = Math.trunc(value);
	return normalized <= 0 ? Number.POSITIVE_INFINITY : normalized;
}

async function loadBootstrapMetadata() {
	return JSON.parse(await readFile(path.join(SERVER_ROOT, "site-lib", "metadata.json"), "utf8"));
}

async function getGeneratedApplicationStatus() {
	try {
		const files = await Promise.all(APPLICATION_FILES.map((file) => stat(path.join(SERVER_ROOT, file))));
		if (!files.every((file) => file.isFile())) return { complete: false };
		const metadata = JSON.parse(await readFile(path.join(SERVER_ROOT, "site-lib", "metadata.json"), "utf8"));
		return { complete: true, version: metadata.applicationVersion };
	} catch (error) {
		if (error?.code === "ENOENT" || error instanceof SyntaxError) return { complete: false };
		throw error;
	}
}

async function initializeCorpusDatabase() {
	corpusStatus.state = "opening";
	let databaseExists = false;
	let databaseMode;
	let recordFormat;
	try {
		if (!(await stat(CORPUS_DATABASE_PATH)).isFile()) throw new Error(`Corpus path is not a file: ${CORPUS_DATABASE_PATH}`);
		databaseExists = true;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (databaseExists) {
		const existingDatabase = new DatabaseSync(CORPUS_DATABASE_PATH);
		try {
			databaseMode = existingDatabase.prepare("SELECT value FROM export_state WHERE key = 'mode'").get()?.value;
			recordFormat = existingDatabase.prepare("SELECT value FROM export_state WHERE key = 'record_format'").get()?.value;
		} catch {
			databaseMode = undefined;
		} finally {
			existingDatabase.close();
		}
	}
	const applicationStatus = await getGeneratedApplicationStatus();
	const currentApplicationVersion = await getMarkdownSpaApplicationVersion();
	if (databaseMode !== "direct-markdown-spa" || recordFormat !== RECORD_FORMAT_VERSION) {
		corpusStatus.state = "indexing";
		const message = !databaseExists
			? "database missing; indexing vault"
			: databaseMode === "direct-markdown-spa" && recordFormat !== RECORD_FORMAT_VERSION
				? `database format ${recordFormat ?? "unknown"} is outdated; rebuilding vault index`
				: "database is incomplete; rebuilding vault index";
		console.log(`[companion-sqlite] ${message} in ${CORPUS_DATABASE_PATH}`);
		await exportMarkdownSpa({ vaultRoot: VAULT_ROOT, writeApplication: false });
	}
	if (!applicationStatus.complete) {
		console.log(`[companion-app] generated application is incomplete; rebuilding ${SERVER_ROOT}`);
		await writeMarkdownSpaApplication({ vaultRoot: VAULT_ROOT });
	} else if (currentApplicationVersion && applicationStatus.version !== currentApplicationVersion) {
		console.log(`[companion-app] repository application is newer; updating ${SERVER_ROOT}`);
		await writeMarkdownSpaApplication({ vaultRoot: VAULT_ROOT });
	}
	const database = new DatabaseSync(CORPUS_DATABASE_PATH);
	try {
		const mode = database.prepare("SELECT value FROM export_state WHERE key = 'mode'").get()?.value;
		const format = database.prepare("SELECT value FROM export_state WHERE key = 'record_format'").get()?.value;
		if (mode !== "direct-markdown-spa" || format !== RECORD_FORMAT_VERSION) {
			throw new Error("SQLite database was not created by the current direct Markdown SPA exporter.");
		}
		corpusStatus.total = Number(database.prepare("SELECT COUNT(*) AS count FROM source_records").get().count);
		corpusStatus.processed = corpusStatus.total;
		corpusStatus.state = "ready";
		console.log(`[companion-sqlite] opened ${corpusStatus.total} direct records from ${CORPUS_DATABASE_PATH}`);
	} catch (error) {
		database.close();
		corpusStatus.state = "error";
		throw error;
	}
	return database;
}

function getCorpusDatabase() {
	corpusDatabasePromise ??= initializeCorpusDatabase();
	return corpusDatabasePromise;
}

function tagVisibilityClause(metadata, alias = "") {
	const prefix = alias ? `${alias}.` : "";
	const showInline = metadata.featureOptions?.tags?.showInlineTags !== false;
	const showFrontmatter = metadata.featureOptions?.tags?.showFrontmatterTags !== false;
	if (showInline && showFrontmatter) return "1 = 1";
	if (showInline) return `${prefix}inline_tag = 1`;
	if (showFrontmatter) return `${prefix}frontmatter_tag = 1`;
	return "0 = 1";
}

async function getTagChildren(parent = "") {
	const metadata = await loadBootstrapMetadata();
	const database = await getCorpusDatabase();
	const visibility = tagVisibilityClause(metadata, "tags");
	const childVisibility = tagVisibilityClause(metadata, "children");
	const rows = database.prepare(`
		SELECT tags.tag_key, MIN(tags.tag_name) AS name, MIN(tags.tag_path) AS path,
			COUNT(*) AS count,
			EXISTS(
				SELECT 1 FROM document_tags children
				WHERE children.parent_key = tags.tag_key AND ${childVisibility}
			) AS has_children
		FROM document_tags tags
		WHERE tags.parent_key = ? AND ${visibility}
		GROUP BY tags.tag_key
	`).all(String(parent).toLowerCase());
	return rows
		.map((row) => ({
			name: row.name, path: row.path, count: Number(row.count),
			hasChildren: Boolean(row.has_children), children: [],
		}))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
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
	const metadata = JSON.parse(await readFile(path.join(SERVER_ROOT, "site-lib", "metadata.json"), "utf8"));
	const database = await getCorpusDatabase();
	metadata.documentCount = Number(database.prepare(
		"SELECT COUNT(*) AS count FROM metadata_documents WHERE kind = 'webpage'"
	).get().count);
	metadata.tagTree = await getTagChildren("");
	metadata.webpages = {};
	metadata.fileInfo = {};
	metadata.sourceToTarget = {};
	metadata.metadataValueToTarget = {};
	metadata.navigationMode = "lazy";
	return metadata;
}

async function handleTags(request, response) {
	try {
		const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const parent = normalizeNavigationParent(requestURL.searchParams.get("parent") ?? "");
		sendJSON(response, 200, {
			parent,
			items: await getTagChildren(parent),
		});
	} catch (error) {
		sendJSON(response, 400, { error: error.message ?? "Tag request failed." });
	}
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

async function useDocumentTitlesInNavigation() {
	const metadata = await loadBootstrapMetadata();
	return metadata.featureOptions?.fileNavigation?.showDocumentTitles === true;
}

async function handleNavigation(request, response) {
	try {
		const showDocumentTitles = await useDocumentTitlesInNavigation();
		const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const parent = normalizeNavigationParent(requestURL.searchParams.get("parent") ?? "");
		const database = await getCorpusDatabase();
		const items = database.prepare(`
			SELECT entries.kind, entries.name, entries.entry_path AS path,
				entries.source_path, entries.export_path, entries.type, documents.title
			FROM navigation_entries entries
			LEFT JOIN metadata_documents documents ON documents.export_path = entries.export_path
			WHERE entries.parent_path = ?
		`).all(parent).map((row) => ({
			kind: row.kind,
			name: showDocumentTitles && row.kind === "document" ? (row.title || row.name) : row.name,
			path: row.path,
			sourcePath: row.source_path,
			exportPath: row.export_path,
			type: row.type,
			hasChildren: row.kind === "folder",
		})).sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
			return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
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
	const basenameStatement = database.prepare(`
		SELECT export_path, source_path FROM metadata_documents
		WHERE source_basename = ? COLLATE NOCASE ORDER BY tree_order, source_path LIMIT 1
	`);
	for (const candidate of candidates) {
		const row = statement.get(candidate);
		if (row) return { exportPath: row.export_path, sourcePath: row.source_path };
	}
	if (!normalizedTarget.includes("/")) {
		const basenames = [path.posix.basename(normalizedTarget)];
		if (!path.posix.extname(normalizedTarget)) basenames.push(`${basenames[0]}.md`);
		for (const basename of basenames) {
			const row = basenameStatement.get(basename);
			if (row) return { exportPath: row.export_path, sourcePath: row.source_path };
		}
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
		if (row.kind === "file" && data.type === "attachment") {
			sendJSON(response, 200, { data, html: renderAttachmentDocument(data) });
			return;
		}
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
			title: data.title,
			displayTitle: path.posix.basename(data.sourcePath, path.posix.extname(data.sourcePath)),
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

async function runCorpusSearch({ query, type = 127, offset = 0, limit = 50 }) {
	const normalizedQuery = String(query ?? "").trim();
	const normalizedType = Number(type);
	const normalizedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
	const normalizedLimit = Math.max(0, Math.trunc(Number(limit) || 0));
	const database = await getCorpusDatabase();
	let rows = [];
	let total = 0;

	if (normalizedType === 8) {
		const tag = normalizedQuery.replace(/^#+/, "").toLowerCase();
		if (!tag) return { query: normalizedQuery, type: normalizedType, offset: normalizedOffset, total, items: [] };
		total = Number(database.prepare(`
			SELECT COUNT(*) AS count
			FROM document_tags tags
			JOIN metadata_documents documents ON documents.document_id = tags.document_id
			WHERE tags.tag_key = ? AND documents.kind = 'webpage'
		`).get(tag).count);
		if (normalizedLimit > 0) {
			rows = database.prepare(`
				SELECT documents.export_path AS path, documents.source_path, documents.title, 0 AS rank
				FROM document_tags tags
				JOIN metadata_documents documents ON documents.document_id = tags.document_id
				WHERE tags.tag_key = ? AND documents.kind = 'webpage'
				ORDER BY tags.source_path COLLATE NOCASE, tags.source_path
				LIMIT ? OFFSET ?
			`).all(tag, normalizedLimit, normalizedOffset);
		}
	} else {
		const tokenQuery = tokenizeSearchQuery(normalizedQuery);
		const columns = searchColumnsForType(normalizedType);
		if (!tokenQuery || columns.length === 0) {
			return { query: normalizedQuery, type: normalizedType, offset: normalizedOffset, total, items: [] };
		}
		const matchQuery = `{${columns.join(" ")}} : (${tokenQuery})`;
		total = Number(database.prepare(
			"SELECT COUNT(*) AS count FROM search_documents WHERE search_documents MATCH ?"
		).get(matchQuery).count);
		if (normalizedLimit > 0) {
			rows = database.prepare(`
				SELECT path, source_path, title,
					bm25(search_documents, 0, 0, 2, 8, 1.8, 1.5, 1.3, 1) AS rank
				FROM search_documents
				WHERE search_documents MATCH ?
				ORDER BY rank
				LIMIT ? OFFSET ?
			`).all(matchQuery, normalizedLimit, normalizedOffset);
		}
	}

	const showDocumentTitles = await useDocumentTitlesInNavigation();
	return {
		query: normalizedQuery,
		type: normalizedType,
		offset: normalizedOffset,
		total,
		items: rows.map((row) => ({
			path: row.path,
			sourcePath: row.source_path,
			title: row.title,
			navigationTitle: showDocumentTitles
				? row.title
				: path.posix.basename(row.source_path, path.posix.extname(row.source_path)),
		})),
	};
}

async function getAllCorpusSearchItems(query, type = 127) {
	const normalizedQuery = String(query ?? "").trim();
	const normalizedType = Number(type);
	const database = await getCorpusDatabase();
	let rows;
	if (normalizedType === 8) {
		const tag = normalizedQuery.replace(/^#+/, "").toLowerCase();
		if (!tag) return [];
		rows = database.prepare(`
			SELECT documents.export_path AS path, documents.source_path, documents.title
			FROM document_tags tags
			JOIN metadata_documents documents ON documents.document_id = tags.document_id
			WHERE tags.tag_key = ? AND documents.kind = 'webpage'
			ORDER BY tags.source_path COLLATE NOCASE, tags.source_path
		`).all(tag);
	} else {
		const tokenQuery = tokenizeSearchQuery(normalizedQuery);
		const columns = searchColumnsForType(normalizedType);
		if (!tokenQuery || columns.length === 0) return [];
		const matchQuery = `{${columns.join(" ")}} : (${tokenQuery})`;
		rows = database.prepare(`
			SELECT path, source_path, title
			FROM search_documents WHERE search_documents MATCH ?
		`).all(matchQuery);
	}
	return rows.map((row) => ({
		path: row.path,
		sourcePath: row.source_path,
		title: row.title,
	}));
}

async function handleSearch(request, response) {
	try {
		const body = await readJSONBody(request);
		const requestedLimit = Number(body.limit ?? 50);
		const limit = Math.max(0, Math.min(
			Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 50,
			MINIMUM_SEARCH_API_LIMIT,
		));
		sendJSON(response, 200, await runCorpusSearch({
			query: body.query,
			type: body.type,
			offset: body.offset,
			limit,
		}));
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
	const metadataRoot = path.join(SERVER_ROOT, "site-lib");
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

async function loadCheckoutMetadata() {
	const metadata = await loadBootstrapMetadata();
	const database = await getCorpusDatabase();
	metadata.sourceToTarget = {};
	metadata.fileInfo = {};
	for (const row of database.prepare(
		"SELECT source_path, export_path, kind FROM metadata_documents"
	).all()) {
		metadata.sourceToTarget[row.source_path] = row.export_path;
		if (row.kind === "file") {
			metadata.fileInfo[row.export_path] = {
				sourcePath: row.source_path,
				exportPath: row.export_path,
			};
		}
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

async function resolveCheckoutSelection(bodyItems, queryBatches, metadata) {
	const selected = new Map();
	const resolvedBatches = [];
	const maxCheckoutItems = getMaxCheckoutItems(metadata);
	const addItem = (item) => {
		const normalized = normalizeVaultPath(item?.sourcePath);
		if (!selected.has(normalized.sourcePath)) {
			selected.set(normalized.sourcePath, {
				sourcePath: normalized.sourcePath,
				exportPath: String(item.exportPath ?? item.path ?? ""),
				title: String(item.title ?? path.posix.basename(normalized.sourcePath, ".md")),
			});
			if (Number.isFinite(maxCheckoutItems) && selected.size > maxCheckoutItems) {
				const unit = maxCheckoutItems === 1 ? "item" : "items";
				throw Object.assign(new Error(`Checkout request exceeds the configured limit of ${maxCheckoutItems} ${unit}.`), { statusCode: 413 });
			}
		}
	};

	const explicitItems = Array.isArray(bodyItems) ? bodyItems : [];
	if (explicitItems.length > 0) {
		const batch = { query: "Selected documents", items: [] };
		for (const item of explicitItems) {
			addItem(item);
			batch.items.push(item);
		}
		resolvedBatches.push(batch);
	}

	for (const [index, batch] of (Array.isArray(queryBatches) ? queryBatches : []).entries()) {
		if (batch?.kind !== "query") continue;
		const excluded = new Set(Array.isArray(batch.excludedSourcePaths) ? batch.excludedSourcePaths.map(String) : []);
		const resolvedBatch = { query: String(batch.query ?? `Search ${index + 1}`), items: [] };
		for (const item of await getAllCorpusSearchItems(batch.searchQuery, batch.type)) {
			if (excluded.has(item.sourcePath)) continue;
			addItem(item);
			resolvedBatch.items.push(item);
		}
		if (resolvedBatch.items.length > 0) resolvedBatches.push(resolvedBatch);
	}

	if (selected.size === 0) {
		throw Object.assign(new Error("Checkout request must include at least one item."), { statusCode: 400 });
	}
	return { items: Array.from(selected.values()), batches: resolvedBatches };
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

async function* iterateCheckoutFiles(items, metadata, batches = []) {
	const normalizedItems = [];
	const seen = new Set();
	const maxCheckoutItems = getMaxCheckoutItems(metadata);

	if (!Array.isArray(items) || items.length === 0) {
		throw Object.assign(new Error("Checkout request must include at least one item."), { statusCode: 400 });
	}

	for (const item of items) {
		const normalized = normalizeVaultPath(item?.sourcePath);
		if (seen.has(normalized.sourcePath)) continue;
		seen.add(normalized.sourcePath);
		normalizedItems.push(normalized);
	}
	if (Number.isFinite(maxCheckoutItems) && normalizedItems.length > maxCheckoutItems) {
		const unit = maxCheckoutItems === 1 ? "item" : "items";
		throw Object.assign(new Error(`Checkout request exceeds the configured limit of ${maxCheckoutItems} ${unit}.`), { statusCode: 413 });
	}

	const rootIndex = await getOptionalRootIndex();
	if (rootIndex && !seen.has(rootIndex.sourcePath)) {
		seen.add(rootIndex.sourcePath);
		normalizedItems.unshift(rootIndex);
	}

	const selectedSources = new Set(normalizedItems.map((item) => item.sourcePath));
	const indexes = buildSourceIndexes(metadata);
	const checkoutIndex = buildCheckoutIndex(items, batches, selectedSources, indexes);
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
		yield {
			path: item.sourcePath,
			data: Buffer.from(
				`${isRootIndex ? `${checkoutIndex}\n---\n\n` : ""}${addOnlineSourceReference(rewrittenMarkdown, item.sourcePath, indexes)}`,
				"utf8"
			),
		};
	}

	if (!hasRootIndex) {
		yield {
			path: "index.md",
			data: Buffer.from(checkoutIndex, "utf8"),
		};
	}

	for (const file of await collectObsidianConfigFilePaths()) {
		yield { path: file.path, data: await readFile(file.absolutePath) };
	}
}

async function buildCheckoutFiles(items, metadata, batches = []) {
	const files = [];
	for await (const file of iterateCheckoutFiles(items, metadata, batches)) files.push(file);
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

async function collectObsidianConfigFilePaths() {
	const obsidianRoot = path.resolve(VAULT_ROOT, ".obsidian");
	if (!isPathInside(VAULT_ROOT, obsidianRoot)) return [];

	try {
		const rootStat = await stat(obsidianRoot);
		if (!rootStat.isDirectory()) return [];
	} catch {
		return [];
	}

	const files = [];
	await collectDirectoryFilePaths(obsidianRoot, ".obsidian", files);
	return files;
}

async function collectDirectoryFilePaths(absoluteDirectory, zipDirectory, files) {
	const entries = await readdir(absoluteDirectory, { withFileTypes: true });

	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;

		const absolutePath = path.join(absoluteDirectory, entry.name);
		if (!isPathInside(VAULT_ROOT, absolutePath)) continue;

		const zipPath = path.posix.join(zipDirectory, entry.name);
		if (entry.isDirectory()) {
			await collectDirectoryFilePaths(absolutePath, zipPath, files);
			continue;
		}

		if (!entry.isFile()) continue;

		files.push({ path: zipPath, absolutePath });
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

async function writeChunk(response, chunk) {
	if (!response.write(chunk)) await once(response, "drain");
}

async function streamZip(response, files) {
	const central = [];
	let offset = 0;
	let fileCount = 0;
	const { dosTime, dosDate } = dosDateTime();

	for await (const file of files) {
		const name = Buffer.from(file.path.replaceAll("\\", "/"), "utf8");
		const data = file.data;
		const crc = crc32(data);
		const localOffset = offset;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0808, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt16LE(dosTime, 10);
		local.writeUInt16LE(dosDate, 12);
		local.writeUInt16LE(name.length, 26);
		const descriptor = Buffer.alloc(16);
		descriptor.writeUInt32LE(0x08074b50, 0);
		descriptor.writeUInt32LE(crc, 4);
		descriptor.writeUInt32LE(data.length, 8);
		descriptor.writeUInt32LE(data.length, 12);
		await writeChunk(response, local);
		await writeChunk(response, name);
		await writeChunk(response, data);
		await writeChunk(response, descriptor);
		offset += local.length + name.length + data.length + descriptor.length;

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0x0808, 8);
		centralHeader.writeUInt16LE(0, 10);
		centralHeader.writeUInt16LE(dosTime, 12);
		centralHeader.writeUInt16LE(dosDate, 14);
		centralHeader.writeUInt32LE(crc, 16);
		centralHeader.writeUInt32LE(data.length, 20);
		centralHeader.writeUInt32LE(data.length, 24);
		centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt32LE(localOffset, 42);
		central.push(centralHeader, name);
		fileCount++;
	}

	const centralOffset = offset;
	let centralSize = 0;
	for (const chunk of central) {
		await writeChunk(response, chunk);
		centralSize += chunk.length;
	}
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(fileCount, 8);
	end.writeUInt16LE(fileCount, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(centralOffset, 16);
	response.end(end);
}

async function handleCheckoutSummary(request, response) {
	try {
		requireConfig();
		const body = await readJSONBody(request);
		const metadata = await loadBootstrapMetadata();
		const selection = await resolveCheckoutSelection(body.items, body.batches, metadata);
		sendJSON(response, 200, { count: selection.items.length });
	} catch (error) {
		const statusCode = error.statusCode ?? 400;
		sendJSON(response, statusCode, { error: error.message ?? "Checkout summary failed." });
	}
}

async function handleCheckout(request, response) {
	try {
		requireConfig();
		const body = await readJSONBody(request);
		const metadata = await loadCheckoutMetadata();
		const selection = await resolveCheckoutSelection(body.items, body.batches, metadata);
		const filename = `vault-subset-${new Date().toISOString().slice(0, 10)}.zip`;
		response.writeHead(200, {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Cache-Control": "no-store",
		});
		await streamZip(response, iterateCheckoutFiles(selection.items, metadata, selection.batches));
	} catch (error) {
		const statusCode = error.statusCode ?? 400;
		console.error("Checkout failed:", error);
		if (response.headersSent) response.destroy(error);
		else sendJSON(response, statusCode, { error: error.message ?? "Checkout failed." });
	}
}

async function serveStatic(request, response) {
	const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
	let pathname = decodeURIComponent(requestURL.pathname);
	if (
		pathname === "/server" ||
		pathname.startsWith("/server/") ||
		pathname === "/corpus.sqlite" ||
		pathname.startsWith("/corpus.sqlite-") ||
		pathname.startsWith("/.export-") ||
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
			const shellPath = path.join(SERVER_ROOT, "index.html");
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

	const absolutePath = path.resolve(SERVER_ROOT, `.${pathname}`);
	if (!isPathInside(SERVER_ROOT, absolutePath)) {
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
			path.join(SERVER_ROOT, "site-lib", "metadata.json"),
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
	getMaxCheckoutItems,
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
	streamZip,
	resolveCheckoutSelection,
};

export function createArchivatoriumServer() {
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
		if (request.method === "GET" && requestURL.pathname === "/api/tags") {
			await handleTags(request, response);
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
		if (request.method === "POST" && requestURL.pathname === "/api/checkout/summary") {
			await handleCheckoutSummary(request, response);
			return;
		}

		if (request.method === "GET" || request.method === "HEAD") {
			await serveStatic(request, response);
			return;
		}

		send(response, 405, "Method not allowed", { "Content-Type": "text/plain; charset=utf-8" });
	});
}

if (IS_MAIN) {
	getCorpusDatabase().then(() => {
		const server = createArchivatoriumServer();
		server.listen(PORT, HOST, () => {
			console.log(`Archivatorium server listening on http://${HOST}:${PORT}`);
			console.log(`Serving vault ${VAULT_ROOT}`);
			console.log(`Using generated application from ${SERVER_ROOT}`);
		});
	}).catch((error) => {
		console.error("Direct SQLite initialization failed:", error);
		process.exitCode = 1;
	});
}
