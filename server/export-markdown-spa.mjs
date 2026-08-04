#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "..");
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK_PATTERN = /(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
const TAG_PATTERN = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gmu;

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

async function readExistingCorpus(corpusRoot) {
	const records = new Map();
	try {
		const entries = await readdir(corpusRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const serialized = await readFile(path.join(corpusRoot, entry.name), "utf8");
			try {
				records.set(entry.name, { serialized, record: JSON.parse(serialized) });
			} catch {
				// A damaged record is replaced by the next export.
			}
		}
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	return records;
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

function corpusFilename(exportPath) {
	return `${createHash("sha256").update(exportPath).digest("hex")}.json`;
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
	return `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${siteName}</title><link rel="stylesheet" href="/site-lib/styles/main.css"><link rel="stylesheet" href="/site-lib/styles/deferred.css"><script defer src="/site-lib/scripts/deferred.js"></script><script defer src="/site-lib/scripts/webpage.js"></script></head>
<body><div id="main"><div id="navbar"></div><div id="main-horizontal"><div id="left-content" class="leaf"><div id="left-sidebar" class="sidebar"><div class="sidebar-handle"></div><div class="sidebar-topbar"><div class="topbar-content"><div id="search-container"><div id="search-wrapper"><input type="search" enterkeyhint="search" spellcheck="false" placeholder="Search..."><div id="search-clear-button" aria-label="Clear search"></div></div></div></div><div class="clickable-icon sidebar-collapse-icon">${collapseSidebarIcon}</div></div><div class="sidebar-content-wrapper"><div id="left-sidebar-content" class="leaf-content"><div id="file-explorer" class="nav-files-container"></div></div></div></div></div><div id="center-content" class="leaf"></div><div id="right-content" class="leaf"><div id="right-sidebar" class="sidebar"><div class="sidebar-handle"></div><div class="sidebar-topbar"><div class="topbar-content"></div><div class="clickable-icon sidebar-collapse-icon">${collapseSidebarIcon}</div></div><div class="sidebar-content-wrapper"><div id="right-sidebar-content" class="leaf-content"></div></div></div></div></div></div></body></html>`;
}

async function writeAssets(exportRoot) {
	const styles = path.join(exportRoot, "site-lib", "styles");
	const scripts = path.join(exportRoot, "site-lib", "scripts");
	await mkdir(styles, { recursive: true });
	await mkdir(scripts, { recursive: true });
	const [obsidianStyles, pluginStyles] = await Promise.all([
		readFile(path.join(REPOSITORY_ROOT, "src/assets/obsidian-styles.txt.css"), "utf8"),
		readFile(path.join(REPOSITORY_ROOT, "src/assets/plugin-styles.txt.css"), "utf8"),
	]);
	await Promise.all([
		writeFile(path.join(styles, "main.css"), `${obsidianStyles}\n${pluginStyles}`),
		cp(path.join(REPOSITORY_ROOT, "src/assets/deferred.txt.css"), path.join(styles, "deferred.css")),
		cp(path.join(REPOSITORY_ROOT, "src/assets/deferred.txt.js"), path.join(scripts, "deferred.js")),
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
	const corpusRoot = path.join(exportRoot, "site-lib", "corpus");
	await mkdir(exportRoot, { recursive: true });
	await mkdir(corpusRoot, { recursive: true });
	const existingCorpus = await readExistingCorpus(corpusRoot);

	const allSourcePaths = await walkFiles(vaultRoot);
	const sourcePaths = allSourcePaths.filter((sourcePath) => sourcePath.toLowerCase().endsWith(".md"))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
	const documents = new Map();
	const basenames = new Map();
	for (const sourcePath of allSourcePaths) {
		const absolutePath = path.join(vaultRoot, sourcePath);
		const sourceStat = await stat(absolutePath);
		const document = { sourcePath, absolutePath, sourceStat, exportPath: exportPath(sourcePath) };
		if (sourcePath.toLowerCase().endsWith(".md")) {
			const existing = existingCorpus.get(corpusFilename(document.exportPath));
			if (isCurrentSourceRecord(existing?.record, sourcePath, sourceStat)) document.cachedRecord = existing.record;
			else document.markdown = await readFile(absolutePath, "utf8");
		}
		documents.set(sourcePath, document);
		const basename = path.posix.basename(sourcePath, path.posix.extname(sourcePath));
		if (!basenames.has(basename)) basenames.set(basename, document);
	}

	const documentsByExportPath = new Map(Array.from(documents.values()).map((document) => [document.exportPath, document]));
	const backlinks = new Map(sourcePaths.map((sourcePath) => [sourcePath, new Set()]));
	const attachmentRecords = new Map();
	const pageRecords = [];
	for (let index = 0; index < sourcePaths.length; index++) {
		const document = documents.get(sourcePaths[index]);
		if (document.cachedRecord) {
			const data = document.cachedRecord.data;
			pageRecords.push({
				document,
				cachedRecord: document.cachedRecord,
				links: new Set(data.links ?? []),
				attachments: new Set(data.attachments ?? []),
				treeOrder: index + 1,
			});
			continue;
		}
		const frontmatter = parseFrontmatter(document.markdown);
		const headers = getHeaders(document.markdown);
		const inlineTags = Array.from(document.markdown.matchAll(TAG_PATTERN), (match) => `#${match[2]}`);
		const frontmatterTags = stringArray(frontmatter.values.tags).map((tag) => tag.startsWith("#") ? tag : `#${tag}`);
		const tags = Array.from(new Set([...frontmatterTags, ...inlineTags]));
		const links = new Set();
		const attachments = new Set();
		for (const match of document.markdown.matchAll(WIKILINK_PATTERN)) {
			const target = resolveWikiTarget(match[2], document.sourcePath, documents, basenames);
			if (!target) continue;
			links.add(target.exportPath);
			if (match[1]) attachments.add(target.exportPath);
		}
		const aliases = stringArray(frontmatter.values.aliases);
		const title = String(frontmatter.values.title ?? headers[0]?.heading ?? path.posix.basename(document.sourcePath, ".md"));
		const content = getSearchText(document.markdown, tags);
		pageRecords.push({ document, frontmatter, headers, inlineTags, frontmatterTags, aliases, title, links, attachments, content, treeOrder: index + 1 });
		if ((index + 1) % 250 === 0 || index + 1 === sourcePaths.length) {
			console.log(`[node-export] indexed ${index + 1}/${sourcePaths.length} Markdown files`);
		}
	}

	for (const entry of pageRecords) {
		for (const linkedExportPath of entry.links) {
			const target = documentsByExportPath.get(linkedExportPath);
			if (!target) continue;
			if (target.sourcePath.toLowerCase().endsWith(".md")) backlinks.get(target.sourcePath).add(entry.document.exportPath);
			else attachmentRecords.set(target.sourcePath, target);
		}
	}

	const generatedFilenames = new Set();
	let writtenRecords = 0;
	let reusedRecords = 0;
	let removedRecords = 0;
	async function writeRecord(exportedPath, record) {
		const filename = corpusFilename(exportedPath);
		generatedFilenames.add(filename);
		const serialized = JSON.stringify(record);
		if (existingCorpus.get(filename)?.serialized === serialized) {
			reusedRecords++;
			return;
		}
		await writeFile(path.join(corpusRoot, filename), serialized);
		writtenRecords++;
	}

	for (const entry of pageRecords) {
		const { document, links, attachments, treeOrder } = entry;
		let record;
		if (entry.cachedRecord) {
			record = { ...entry.cachedRecord, data: { ...entry.cachedRecord.data } };
			record.data.treeOrder = treeOrder;
			record.data.backlinks = Array.from(backlinks.get(document.sourcePath));
		} else {
			const { frontmatter, headers, inlineTags, frontmatterTags, aliases, title, content } = entry;
			const data = {
				createdTime: document.sourceStat.ctimeMs,
				modifiedTime: document.sourceStat.mtimeMs,
				sourceSize: document.sourceStat.size,
				sourcePath: document.sourcePath,
				exportPath: document.exportPath,
				showInTree: true,
				treeOrder,
				backlinks: Array.from(backlinks.get(document.sourcePath)),
				type: "markdown",
				data: null,
				title,
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
		await writeRecord(document.exportPath, record);
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
		await writeRecord(data.exportPath, { kind: "file", data });
	}
	for (const filename of existingCorpus.keys()) {
		if (generatedFilenames.has(filename)) continue;
		await rm(path.join(corpusRoot, filename), { force: true });
		removedRecords++;
	}

	const siteName = options.siteName || path.basename(vaultRoot);
	await writeAssets(exportRoot);
	await writeFile(path.join(exportRoot, "index.html"), createShell(siteName));
	await writeFile(path.join(exportRoot, "site-lib", "metadata.json"), JSON.stringify({
		createdTime: Date.now(), modifiedTime: Date.now(), siteName, vaultName: path.basename(vaultRoot),
		exportRoot: "", baseURL: options.rssOptions?.siteUrl ?? "", pluginVersion: "server-markdown-spa",
		themeName: "", bodyClasses: "", hasFavicon: false, serverMetadata: true,
		featureOptions: featureOptions(options),
	}));
	console.log(`[node-export] wrote ${writtenRecords}, reused ${reusedRecords}, and removed ${removedRecords} corpus records (${pageRecords.length} documents, ${attachmentRecords.size} referenced attachments)`);
	return { writtenRecords, reusedRecords, removedRecords, documents: pageRecords.length, attachments: attachmentRecords.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [vaultRoot, exportRoot, configPath] = process.argv.slice(2);
	exportMarkdownSpa({ vaultRoot, exportRoot, configPath }).catch((error) => {
		console.error("Node export failed:", error);
		process.exitCode = 1;
	});
}
