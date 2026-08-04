#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "..");
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK_PATTERN = /(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
const MARKDOWN_LINK_PATTERN = /(!?)\[[^\]]*\]\(((?:[^()\s]|\([^)]*\))+)(?:\s+['\"][^)]*['\"])?\)/g;
const TAG_PATTERN = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gmu;
const SEARCH_VALUE_SEPARATOR = "\u001f";
const EXPORT_COMMIT_INTERVAL = Math.max(1, Number(process.env.EXPORT_COMMIT_INTERVAL ?? 500));
const RECORD_FORMAT_VERSION = "2";

function slugifyPath(value) {
	return value.replaceAll(" ", "-").replaceAll(/-{2,}/g, "-").toLowerCase();
}

function exportPath(sourcePath) {
	const output = slugifyPath(sourcePath.replaceAll("\\", "/"));
	return output.replace(/\.md$/i, ".html");
}

function slugifyHeading(value) {
	return String(value).normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_ -]+/gu, "")
		.trim()
		.replace(/[\s_]+/g, "-") || "section";
}

function stringArray(value) {
	if (value == null) return [];
	if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
	const text = String(value).trim().replace(/^\[|\]$/g, "");
	return text ? text.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) : [];
}

function parseFrontmatter(markdown) {
	const match = markdown.match(FRONTMATTER_PATTERN);
	if (!match) return { values: {}, text: "" };
	const values = {};
	const lines = match[1].split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const property = lines[index].match(/^([\w-]+):\s*(.*)$/);
		if (!property) continue;
		const [, key, inline] = property;
		if (inline.trim()) {
			values[key] = inline.trim().replace(/^['"]|['"]$/g, "");
			continue;
		}
		const items = [];
		while (index + 1 < lines.length && /^\s*-\s+/.test(lines[index + 1])) {
			index++;
			items.push(lines[index].replace(/^\s*-\s+/, "").trim().replace(/^['"]|['"]$/g, ""));
		}
		values[key] = items;
	}
	return { values, text: match[1] };
}

function normalizeCallout(value) {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function withoutExcludedCallouts(markdown) {
	const lines = markdown.split(/\r?\n/);
	const kept = [];
	for (let index = 0; index < lines.length;) {
		const match = lines[index].match(/^>\s*\[!([^\]]+)\]\s*(.*)$/i);
		if (!match) {
			kept.push(lines[index++]);
			continue;
		}
		const excluded = normalizeCallout(match[1]) === "citingthisdocument" ||
			normalizeCallout(match[2]) === "citingthisdocument" ||
			normalizeCallout(match[2]) === "metadata";
		while (index < lines.length && (lines[index].startsWith(">") || lines[index].trim() === "")) {
			if (!excluded) kept.push(lines[index]);
			index++;
		}
	}
	return kept.join("\n");
}

function getHeaders(markdown) {
	const used = new Map();
	const headers = [];
	for (const line of markdown.replace(FRONTMATTER_PATTERN, "").split(/\r?\n/)) {
		const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (!match) continue;
		const heading = match[2].replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_value, target, label) => label || target).trim();
		const base = slugifyHeading(heading);
		const count = used.get(base) ?? 0;
		used.set(base, count + 1);
		headers.push({ heading, level: match[1].length, id: count ? `${base}-${count}` : base });
	}
	return headers;
}

function getSearchText(markdown, tags) {
	let text = withoutExcludedCallouts(markdown.replace(FRONTMATTER_PATTERN, ""));
	text = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<[^>]+>/g, " ");
	text = text.replace(TAG_PATTERN, "$1");
	text = text.replace(WIKILINK_PATTERN, (_match, _embed, target, label) => label?.trim() || target);
	text = text.replace(/!?(\[[^\]]*\])\([^)]*\)/g, "$1");
	text = text.replace(/[`*_~>#|]/g, " ");
	for (const tag of [...tags].sort((a, b) => b.length - a.length)) text = text.replaceAll(tag, " ");
	return text.replace(/\s+/g, " ").trim();
}

async function walkFiles(vaultRoot, relative = "") {
	const entries = await readdir(path.join(vaultRoot, relative), { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		if (entry.name === ".obsidian" || entry.name === ".trash") continue;
		const sourcePath = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...await walkFiles(vaultRoot, sourcePath));
		else if (entry.isFile()) files.push(sourcePath);
	}
	return files;
}

function joinSearchValues(values) {
	return Array.isArray(values) ? values.map(String).join(SEARCH_VALUE_SEPARATOR) : "";
}

function createDirectDatabase(databasePath) {
	const database = new DatabaseSync(databasePath);
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
		CREATE TABLE IF NOT EXISTS source_records (
			filename TEXT PRIMARY KEY, export_path TEXT NOT NULL, source_modified_time REAL NOT NULL,
			source_size INTEGER NOT NULL, payload TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS export_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS metadata_documents_source_path ON metadata_documents(source_path);
		CREATE INDEX IF NOT EXISTS metadata_documents_tree ON metadata_documents(show_in_tree, tree_order);
	`);
	const mode = database.prepare("SELECT value FROM export_state WHERE key = 'mode'").get()?.value;
	const recordFormat = database.prepare("SELECT value FROM export_state WHERE key = 'record_format'").get()?.value;
	if (mode !== "direct-markdown-spa" || recordFormat !== RECORD_FORMAT_VERSION) {
		database.exec(`
			DELETE FROM search_documents;
			DELETE FROM metadata_documents;
			DELETE FROM metadata_redirects;
			DELETE FROM source_records;
		`);
	}
	return database;
}

function createRecordStore(database) {
	const knownRecords = new Map(database.prepare(
		"SELECT filename, export_path FROM source_records"
	).all().map((row) => [row.filename, row.export_path]));
	const readRecord = database.prepare("SELECT payload FROM source_records WHERE filename = ?");
	return {
		knownRecords,
		get(filename) {
			const row = readRecord.get(filename);
			if (!row) return undefined;
			try {
				return { serialized: row.payload, record: JSON.parse(row.payload) };
			} catch {
				return undefined;
			}
		},
	};
}

function createDirectIndexWriter(database, recordStore) {
	const deleteMetadata = database.prepare("DELETE FROM metadata_documents WHERE export_path = ?");
	const deleteRedirects = database.prepare("DELETE FROM metadata_redirects WHERE export_path = ?");
	const deleteSearch = database.prepare("DELETE FROM search_documents WHERE path = ?");
	const deleteSourceRecord = database.prepare("DELETE FROM source_records WHERE filename = ?");
	const insertMetadata = database.prepare(`
		INSERT OR REPLACE INTO metadata_documents(
			export_path, source_path, kind, title, inline_tags, frontmatter_tags,
			show_in_tree, tree_order, type, data
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const insertRedirect = database.prepare("INSERT OR IGNORE INTO metadata_redirects(value, export_path) VALUES (?, ?)");
	const insertSearch = database.prepare(`
		INSERT INTO search_documents(path, source_path, title, metadata, aliases, headers, tags, content)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const insertSourceRecord = database.prepare(`
		INSERT OR REPLACE INTO source_records(filename, export_path, source_modified_time, source_size, payload)
		VALUES (?, ?, ?, ?, ?)
	`);
	const generated = new Set();
	let writtenRecords = 0;
	let reusedRecords = 0;
	let removedRecords = 0;

	function removeExportPath(exportedPath) {
		deleteMetadata.run(exportedPath);
		deleteRedirects.run(exportedPath);
		deleteSearch.run(exportedPath);
	}

	database.exec("BEGIN IMMEDIATE");
	function writeRecord(filename, record) {
		generated.add(filename);
		const serialized = JSON.stringify(record);
		const existing = recordStore.get(filename);
		if (existing?.serialized === serialized) {
			reusedRecords++;
			return;
		}
		const previous = existing?.record?.data;
		const data = record.data;
		if (previous?.exportPath) removeExportPath(previous.exportPath);
		removeExportPath(data.exportPath);
		insertMetadata.run(
			data.exportPath, data.sourcePath, record.kind ?? "file", data.title ?? data.exportPath,
			joinSearchValues(data.inlineTags), joinSearchValues(data.frontmatterTags),
			data.showInTree ? 1 : 0, Number(data.treeOrder ?? 0), String(data.type ?? ""), JSON.stringify(data)
		);
		for (const value of record.redirectValues ?? []) {
			if (typeof value === "string" && value) insertRedirect.run(value, data.exportPath);
		}
		if (record.kind === "webpage" && record.search) {
			const tags = [...new Set([...(data.frontmatterTags ?? []), ...(data.inlineTags ?? [])])];
			insertSearch.run(
				data.exportPath, data.sourcePath, data.title ?? data.exportPath,
				record.search.metadata ?? "", joinSearchValues(data.aliases),
				joinSearchValues(record.search.headers), joinSearchValues(tags), record.search.content ?? ""
			);
		}
		insertSourceRecord.run(filename, data.exportPath, data.modifiedTime, data.sourceSize, serialized);
		writtenRecords++;
		if (writtenRecords % EXPORT_COMMIT_INTERVAL === 0) {
			database.exec("COMMIT");
			console.log(`[node-export] committed ${writtenRecords} changed records`);
			database.exec("BEGIN IMMEDIATE");
		}
	}

	function finish() {
		for (const [filename, exportPath] of recordStore.knownRecords) {
			if (generated.has(filename)) continue;
			removeExportPath(exportPath);
			deleteSourceRecord.run(filename);
			removedRecords++;
		}
		database.prepare("INSERT OR REPLACE INTO export_state(key, value) VALUES ('mode', 'direct-markdown-spa')").run();
		database.prepare("INSERT OR REPLACE INTO export_state(key, value) VALUES ('record_format', ?)").run(RECORD_FORMAT_VERSION);
		database.exec("COMMIT");
		return { writtenRecords, reusedRecords, removedRecords };
	}

	return { writeRecord, finish };
}

function isCurrentSourceRecord(record, sourcePath, sourceStat) {
	const data = record?.data;
	return data?.sourcePath === sourcePath &&
		data.modifiedTime === sourceStat.mtimeMs &&
		data.sourceSize === sourceStat.size;
}

function resolveWikiTarget(rawTarget, sourcePath, documents, basenames) {
	const target = rawTarget.trim().replaceAll("\\", "/");
	if (!target) return undefined;
	const candidates = new Set([target]);
	if (!path.posix.extname(target)) candidates.add(`${target}.md`);
	const relative = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), target));
	if (relative !== ".." && !relative.startsWith("../")) {
		candidates.add(relative);
		if (!path.posix.extname(relative)) candidates.add(`${relative}.md`);
	}
	for (const candidate of candidates) if (documents.has(candidate)) return documents.get(candidate);
	if (!target.includes("/")) return basenames.get(path.posix.basename(target).replace(/\.md$/i, ""));
	return undefined;
}

function collectDocumentLinks(markdown, document, documents, basenames) {
	const links = new Set();
	const attachments = new Set();
	function addTarget(rawTarget, embedded) {
		const target = resolveWikiTarget(rawTarget, document.sourcePath, documents, basenames);
		if (!target) return;
		links.add(target.exportPath);
		if (embedded || !target.sourcePath.toLowerCase().endsWith(".md")) attachments.add(target.exportPath);
	}
	for (const match of markdown.matchAll(WIKILINK_PATTERN)) {
		addTarget(match[2], Boolean(match[1]));
	}
	for (const match of markdown.matchAll(MARKDOWN_LINK_PATTERN)) {
		const rawTarget = match[2].split("#", 1)[0].trim();
		if (!rawTarget || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(rawTarget)) continue;
		addTarget(rawTarget, Boolean(match[1]));
	}
	return { links, attachments };
}

function recordKey(exportPath) {
	return exportPath;
}

function featureOptions(exportOptions) {
	return {
		backlinks: exportOptions.backlinkOptions ?? { enabled: true },
		tags: exportOptions.tagOptions ?? { enabled: true },
		alias: exportOptions.aliasOptions ?? { enabled: true },
		properties: exportOptions.propertiesOptions ?? { enabled: true },
		fileNavigation: exportOptions.fileNavigationOptions ?? { enabled: true },
		search: { ...(exportOptions.searchOptions ?? {}), enabled: true, serverSide: true, searchEndpoint: "/api/search" },
		shoppingBasket: exportOptions.shoppingBasketOptions ?? { enabled: true },
		outline: exportOptions.outlineOptions ?? { enabled: true, minCollapseDepth: 1 },
		themeToggle: exportOptions.themeToggleOptions ?? { enabled: true },
		graphView: { ...(exportOptions.graphViewOptions ?? {}), enabled: false },
		sidebar: exportOptions.sidebarOptions ?? { enabled: true },
		customHead: exportOptions.customHeadOptions ?? { enabled: false },
		document: exportOptions.documentOptions ?? {},
		rss: { ...(exportOptions.rssOptions ?? {}), enabled: false },
		linkPreview: exportOptions.linkPreviewOptions ?? { enabled: true },
	};
}

function createShell(siteName) {
	const collapseSidebarIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon sidebar-toggle-button-icon"><rect x="1" y="2" width="22" height="20" rx="4"></rect><rect x="4" y="5" width="2" height="14" rx="2" fill="currentColor" class="sidebar-toggle-icon-inner"></rect></svg>`;
	const searchIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>`;
	const themeToggle = `<label for="theme-toggle-input" id="theme-toggle" class="theme-toggle-container" aria-label="Toggle light and dark theme"><input type="checkbox" id="theme-toggle-input" class="theme-toggle-input"><div class="toggle-background"></div></label>`;
	return `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><base href="/"><title>${siteName}</title><link rel="stylesheet" href="/site-lib/styles/obsidian.css"><link rel="stylesheet" href="/site-lib/styles/global-variable-styles.css"><link rel="stylesheet" href="/site-lib/styles/main-styles.css"><link rel="stylesheet" href="/site-lib/styles/deferred.css"><link rel="stylesheet" href="/site-lib/styles/server-spa.css"><script defer src="/site-lib/scripts/deferred.js"></script><script defer src="/site-lib/scripts/webpage.js"></script></head>
<body class="publish css-settings-manager show-inline-title show-ribbon is-focused"><script src="/site-lib/scripts/theme-load.js"></script><div id="main"><div id="navbar"></div><div id="main-horizontal"><div id="left-content" class="leaf"><div id="left-sidebar" class="sidebar"><div class="sidebar-handle"></div><div class="sidebar-topbar"><div class="topbar-content"><div id="search-container"><div id="search-wrapper"><div class="search-icon" aria-hidden="true">${searchIcon}</div><input type="search" enterkeyhint="search" spellcheck="false" placeholder="Search..."><div id="search-clear-button" aria-label="Clear search"></div></div></div></div><div class="clickable-icon sidebar-collapse-icon">${collapseSidebarIcon}</div></div><div class="sidebar-content-wrapper"><div id="left-sidebar-content" class="leaf-content"><div id="file-explorer" class="nav-files-container"></div></div></div></div></div><div id="center-content" class="leaf"></div><div id="right-content" class="leaf"><div id="right-sidebar" class="sidebar"><div class="sidebar-handle"></div><div class="sidebar-topbar"><div class="topbar-content">${themeToggle}</div><div class="clickable-icon sidebar-collapse-icon">${collapseSidebarIcon}</div></div><div class="sidebar-content-wrapper"><div id="right-sidebar-content" class="leaf-content"></div></div></div></div></div></div></body></html>`;
}

async function writeAssets(exportRoot) {
	const styles = path.join(exportRoot, "site-lib", "styles");
	const scripts = path.join(exportRoot, "site-lib", "scripts");
	await mkdir(styles, { recursive: true });
	await mkdir(scripts, { recursive: true });
	const [baselineStyles, obsidianStyles, pluginStyles] = await Promise.all([
		readFile(path.join(REPOSITORY_ROOT, "src/assets/server-default-theme.txt.css"), "utf8"),
		readFile(path.join(REPOSITORY_ROOT, "src/assets/obsidian-styles.txt.css"), "utf8"),
		readFile(path.join(REPOSITORY_ROOT, "src/assets/plugin-styles.txt.css"), "utf8"),
	]);
	await Promise.all([
		writeFile(path.join(styles, "obsidian.css"), `${baselineStyles}\n${obsidianStyles}`),
		writeFile(path.join(styles, "global-variable-styles.css"), ""),
		writeFile(path.join(styles, "main-styles.css"), pluginStyles),
		cp(path.join(REPOSITORY_ROOT, "src/assets/deferred.txt.css"), path.join(styles, "deferred.css")),
		cp(path.join(REPOSITORY_ROOT, "src/assets/server-spa-overrides.txt.css"), path.join(styles, "server-spa.css")),
		cp(path.join(REPOSITORY_ROOT, "src/assets/deferred.txt.js"), path.join(scripts, "deferred.js")),
		cp(path.join(REPOSITORY_ROOT, "src/assets/theme-load.txt.js"), path.join(scripts, "theme-load.js")),
		cp(path.join(REPOSITORY_ROOT, "src/frontend/dist/index.txt.js"), path.join(scripts, "webpage.js")),
	]);
}

export async function exportMarkdownSpa({ vaultRoot, exportRoot, configPath } = {}) {
	if (!vaultRoot || !exportRoot) throw new Error("Usage: export-markdown-spa.mjs <vault-path> <output-path> [config-path]");
	vaultRoot = path.resolve(vaultRoot);
	exportRoot = path.resolve(exportRoot);
	const settingsPath = configPath ?? path.join(vaultRoot, ".obsidian/plugins/archivatorium-web-export/data.json");
	const config = JSON.parse(await readFile(settingsPath, "utf8"));
	const options = config.exportOptions ?? {};
	await mkdir(exportRoot, { recursive: true });
	const databaseRoot = path.join(exportRoot, ".server-data");
	await mkdir(databaseRoot, { recursive: true });
	const database = createDirectDatabase(path.join(databaseRoot, "corpus.sqlite"));
	const recordStore = createRecordStore(database);

	const allSourcePaths = await walkFiles(vaultRoot);
	const sourcePaths = allSourcePaths.filter((sourcePath) => sourcePath.toLowerCase().endsWith(".md"))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
	const documents = new Map();
	const basenames = new Map();
	for (const sourcePath of allSourcePaths) {
		const absolutePath = path.join(vaultRoot, sourcePath);
		const sourceStat = await stat(absolutePath);
		const document = { sourcePath, absolutePath, sourceStat, exportPath: exportPath(sourcePath) };
		documents.set(sourcePath, document);
		const basename = path.posix.basename(sourcePath, path.posix.extname(sourcePath));
		if (!basenames.has(basename)) basenames.set(basename, document);
	}

	const documentsByExportPath = new Map(Array.from(documents.values()).map((document) => [document.exportPath, document]));
	const backlinks = new Map();
	const attachmentRecords = new Map();
	function registerLinks(sourceDocument, linkedExportPaths) {
		for (const linkedExportPath of linkedExportPaths) {
			const target = documentsByExportPath.get(linkedExportPath);
			if (!target) continue;
			if (target.sourcePath.toLowerCase().endsWith(".md")) {
				const targetBacklinks = backlinks.get(target.sourcePath) ?? new Set();
				targetBacklinks.add(sourceDocument.exportPath);
				backlinks.set(target.sourcePath, targetBacklinks);
			}
			else attachmentRecords.set(target.sourcePath, target);
		}
	}

	for (let index = 0; index < sourcePaths.length; index++) {
		const document = documents.get(sourcePaths[index]);
		const existing = recordStore.get(recordKey(document.exportPath));
		if (isCurrentSourceRecord(existing?.record, document.sourcePath, document.sourceStat)) {
			registerLinks(document, existing.record.data.links ?? []);
		} else {
			const markdown = await readFile(document.absolutePath, "utf8");
			registerLinks(document, collectDocumentLinks(markdown, document, documents, basenames).links);
		}
		if ((index + 1) % 250 === 0 || index + 1 === sourcePaths.length) {
			console.log(`[node-export] resolved links ${index + 1}/${sourcePaths.length} Markdown files`);
		}
	}

	const indexWriter = createDirectIndexWriter(database, recordStore);

	for (let index = 0; index < sourcePaths.length; index++) {
		const document = documents.get(sourcePaths[index]);
		const treeOrder = index + 1;
		const existing = recordStore.get(recordKey(document.exportPath));
		let record;
		if (isCurrentSourceRecord(existing?.record, document.sourcePath, document.sourceStat)) {
			record = { ...existing.record, data: { ...existing.record.data } };
			record.data.treeOrder = treeOrder;
			record.data.backlinks = Array.from(backlinks.get(document.sourcePath) ?? []);
			record.data.browserTitle ??= path.posix.basename(document.sourcePath, ".md");
		} else {
			const markdown = await readFile(document.absolutePath, "utf8");
			const frontmatter = parseFrontmatter(markdown);
			const headers = getHeaders(markdown);
			const inlineTags = Array.from(markdown.matchAll(TAG_PATTERN), (match) => `#${match[2]}`);
			const frontmatterTags = stringArray(frontmatter.values.tags).map((tag) => tag.startsWith("#") ? tag : `#${tag}`);
			const tags = Array.from(new Set([...frontmatterTags, ...inlineTags]));
			const { links, attachments } = collectDocumentLinks(markdown, document, documents, basenames);
			const aliases = stringArray(frontmatter.values.aliases);
			const title = String(frontmatter.values.title ?? headers[0]?.heading ?? path.posix.basename(document.sourcePath, ".md"));
			const content = getSearchText(markdown, tags);
			const data = {
				createdTime: document.sourceStat.ctimeMs,
				modifiedTime: document.sourceStat.mtimeMs,
				sourceSize: document.sourceStat.size,
				sourcePath: document.sourcePath,
				exportPath: document.exportPath,
				showInTree: true,
				treeOrder,
				backlinks: Array.from(backlinks.get(document.sourcePath) ?? []),
				type: "markdown",
				data: null,
				title,
				browserTitle: path.posix.basename(document.sourcePath, ".md"),
				aliases,
				inlineTags,
				frontmatterTags,
				headers,
				links: Array.from(links),
				attachments: Array.from(attachments),
				pathToRoot: ".",
				icon: String(frontmatter.values.icon ?? ""),
				description: String(frontmatter.values.description ?? frontmatter.values.summary ?? content.slice(0, 500)),
				author: String(frontmatter.values.author ?? ""),
				rssDate: String(frontmatter.values.date ?? new Date(document.sourceStat.mtimeMs).toISOString()),
				coverImageURL: "",
				fullURL: "",
			};
			record = {
				kind: "webpage",
				data,
				redirectValues: stringArray(frontmatter.values.citekey).map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean),
				search: { metadata: frontmatter.text, headers: headers.map((header) => header.heading), content },
			};
		}
		indexWriter.writeRecord(recordKey(document.exportPath), record);
		if ((index + 1) % 250 === 0 || index + 1 === sourcePaths.length) {
			console.log(`[node-export] indexed ${index + 1}/${sourcePaths.length} Markdown files`);
		}
	}

	for (const attachment of attachmentRecords.values()) {
		const data = {
			createdTime: attachment.sourceStat.ctimeMs,
			modifiedTime: attachment.sourceStat.mtimeMs,
			sourceSize: attachment.sourceStat.size,
			sourcePath: attachment.sourcePath,
			exportPath: attachment.exportPath,
			showInTree: false,
			treeOrder: 0,
			backlinks: [],
			type: "attachment",
			data: null,
		};
		indexWriter.writeRecord(recordKey(data.exportPath), { kind: "file", data });
	}
	const result = indexWriter.finish();
	database.close();
	await rm(path.join(exportRoot, "site-lib", "corpus"), { recursive: true, force: true });

	const siteName = options.siteName || path.basename(vaultRoot);
	await writeAssets(exportRoot);
	await writeFile(path.join(exportRoot, "index.html"), createShell(siteName));
	await writeFile(path.join(exportRoot, "site-lib", "metadata.json"), JSON.stringify({
		createdTime: Date.now(), modifiedTime: Date.now(), siteName, vaultName: path.basename(vaultRoot),
		exportRoot: "", baseURL: options.rssOptions?.siteUrl ?? "", pluginVersion: "server-markdown-spa",
		themeName: "", bodyClasses: "publish css-settings-manager show-inline-title show-ribbon is-focused", hasFavicon: false, serverMetadata: true,
		featureOptions: featureOptions(options),
	}));
	console.log(`[node-export] indexed ${result.writtenRecords}, reused ${result.reusedRecords}, and removed ${result.removedRecords} SQLite records (${sourcePaths.length} documents, ${attachmentRecords.size} referenced attachments)`);
	return { ...result, documents: sourcePaths.length, attachments: attachmentRecords.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [vaultRoot, exportRoot, configPath] = process.argv.slice(2);
	exportMarkdownSpa({ vaultRoot, exportRoot, configPath }).catch((error) => {
		console.error("Node export failed:", error);
		process.exitCode = 1;
	});
}
