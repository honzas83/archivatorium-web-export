#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function isPathInside(parent, candidate) {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeVaultPath(sourcePath) {
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

	if (!normalized.toLowerCase().endsWith(".md")) {
		throw new Error(`Only Markdown files can be checked out: ${sourcePath}`);
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
	const metadataPath = path.join(EXPORT_ROOT, "site-lib", "metadata.json");
	const raw = await readFile(metadataPath, "utf8");
	return JSON.parse(raw);
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
	if (pathname === "/server" || pathname.startsWith("/server/")) {
		send(response, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
		return;
	}

	if (pathname.endsWith("/")) pathname += "index.html";
	if (pathname === "/") pathname = "/index.html";

	const absolutePath = path.resolve(EXPORT_ROOT, `.${pathname}`);
	if (!isPathInside(EXPORT_ROOT, absolutePath)) {
		send(response, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
		return;
	}

	try {
		const fileStat = await stat(absolutePath);
		if (!fileStat.isFile()) throw new Error("Not a file");
		const data = await readFile(absolutePath);
		send(response, 200, data, {
			"Content-Type": contentTypes.get(path.extname(absolutePath).toLowerCase()) ?? "application/octet-stream",
		});
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
		const metadata = await loadMetadata();
		const metadataValue = normalizeMetadataValue(pathname.replace(/^\/+/, "").replace(/\.html$/i, ""));
		return metadata.metadataValueToTarget?.[metadataValue];
	} catch {
		return undefined;
	}
}

export const internals = {
	buildSourceIndexes,
	normalizeVaultPath,
	resolveLinkedSource,
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
	const server = createShoppingBasketServer();
	server.listen(PORT, HOST, () => {
		console.log(`Shopping basket server listening on http://${HOST}:${PORT}`);
		console.log(`Serving export from ${EXPORT_ROOT}`);
		console.log(`Reading vault from ${VAULT_ROOT}`);
	});
}
