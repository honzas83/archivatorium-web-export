import { TFile } from "obsidian";
import { DocumentType } from "src/shared/website-data";
import type { WebpageData } from "src/shared/website-data";
import type { ServerCorpusRecord } from "./server-corpus";
import type { Website } from "./website";

export interface MarkdownCorpusBuild
{
	record: ServerCorpusRecord;
	attachmentFiles: TFile[];
}

const WIKILINK_PATTERN = /(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function slugify(value: string): string {
	return value.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_ -]+/gu, "")
		.trim()
		.replace(/[\s_]+/g, "-") || "section";
}

function asArray(value: unknown): string[] {
	if (value == null) return [];
	return (Array.isArray(value) ? value : [value]).map((item) => String(item).trim()).filter(Boolean);
}

function normalizeCallout(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function withoutExcludedCallouts(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	const kept: string[] = [];
	for (let index = 0; index < lines.length;) {
		const match = lines[index].match(/^>\s*\[!([^\]]+)\]\s*(.*)$/i);
		if (!match) {
			kept.push(lines[index++]);
			continue;
		}
		const type = normalizeCallout(match[1]);
		const title = normalizeCallout(match[2]);
		const excluded = type === "citingthisdocument" || title === "citingthisdocument" || title === "metadata";
		while (index < lines.length && (lines[index].startsWith(">") || lines[index].trim() === "")) {
			if (!excluded) kept.push(lines[index]);
			index++;
		}
	}
	return kept.join("\n");
}

function collectMetadataText(value: unknown, values: string[], key = ""): void {
	if (key === "position") return;
	if (key) values.push(key);
	if (value == null) return;
	if (Array.isArray(value)) {
		value.forEach((item) => collectMetadataText(item, values));
		return;
	}
	if (typeof value === "object") {
		Object.entries(value).forEach(([childKey, childValue]) => collectMetadataText(childValue, values, childKey));
		return;
	}
	const text = String(value).trim();
	if (!text) return;
	values.push(text);
	const compact = text.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!/\s/.test(text) && compact && compact !== text.toLowerCase()) values.push(compact);
}

function collectRedirectValues(value: unknown, values: string[]): void {
	if (value == null) return;
	if (Array.isArray(value)) {
		value.forEach((item) => collectRedirectValues(item, values));
		return;
	}
	if (typeof value === "object") {
		Object.entries(value)
			.filter(([key]) => key !== "position")
			.forEach(([, childValue]) => collectRedirectValues(childValue, values));
		return;
	}
	const normalized = String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
	if (normalized) values.push(normalized);
}

function getTargetPath(website: Website, file: TFile): string {
	const target = website.getTargetPathForFile(file, file.name);
	if (file.extension.toLowerCase() === "md") target.setExtension("html");
	return target.path;
}

function getSearchText(markdown: string, tags: string[]): string {
	let text = withoutExcludedCallouts(markdown.replace(FRONTMATTER_PATTERN, ""));
	text = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<[^>]+>/g, " ");
	text = text.replace(WIKILINK_PATTERN, (_match, _embed, target, label) => label?.trim() || target);
	text = text.replace(/!?(\[[^\]]*\])\([^)]*\)/g, "$1");
	text = text.replace(/[`*_~>#|]/g, " ");
	for (const tag of [...tags].sort((a, b) => b.length - a.length)) text = text.replaceAll(tag, " ");
	return text.replace(/\s+/g, " ").trim();
}

function getHeaders(markdown: string): { heading: string, level: number, id: string }[] {
	const used = new Map<string, number>();
	const headers = [];
	for (const line of markdown.replace(FRONTMATTER_PATTERN, "").split(/\r?\n/)) {
		const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (!match) continue;
		const heading = match[2].replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_value, target, label) => label || target).trim();
		const base = slugify(heading);
		const count = used.get(base) ?? 0;
		used.set(base, count + 1);
		headers.push({ heading, level: match[1].length, id: count ? `${base}-${count}` : base });
	}
	return headers;
}

export async function createMarkdownCorpusRecord(file: TFile, website: Website, treeOrder: number): Promise<MarkdownCorpusBuild> {
	const markdown = await app.vault.cachedRead(file);
	const cache = app.metadataCache.getFileCache(file);
	const frontmatter = cache?.frontmatter ?? {};
	const frontmatterTags = asArray(frontmatter.tags).map((tag) => tag.startsWith("#") ? tag : `#${tag}`);
	const inlineTags = Array.from(cache?.tags?.values() ?? []).map((tag) => tag.tag);
	const allTags = Array.from(new Set([...frontmatterTags, ...inlineTags]));
	const firstHeading = getHeaders(markdown)[0]?.heading;
	const title = String(frontmatter.title ?? firstHeading ?? file.basename);
	const aliases = asArray(frontmatter.aliases);
	const metadataValues: string[] = [];
	collectMetadataText(frontmatter, metadataValues);
	const redirects: string[] = [];
	collectRedirectValues(frontmatter.citekey, redirects);
	const links = new Set<string>();
	const attachments = new Set<string>();
	const attachmentFiles = new Map<string, TFile>();
	for (const match of markdown.matchAll(WIKILINK_PATTERN)) {
		const destination = app.metadataCache.getFirstLinkpathDest(match[2].trim(), file.path);
		if (!(destination instanceof TFile)) continue;
		const targetPath = getTargetPath(website, destination);
		if (destination.extension.toLowerCase() !== "md") attachmentFiles.set(destination.path, destination);
		if (match[1]) attachments.add(targetPath);
		else links.add(targetPath);
	}
	// Obsidian exposes this at runtime, but the public type declarations omit it.
	// @ts-ignore
	const backlinks = Array.from(app.metadataCache.getBacklinksForFile(file)?.data?.keys?.() ?? [])
		.map((sourcePath: string) => app.vault.getAbstractFileByPath(sourcePath))
		.filter((source): source is TFile => source instanceof TFile)
		.map((source) => getTargetPath(website, source));
	const content = getSearchText(markdown, allTags);
	const headers = getHeaders(markdown);
	const description = String(frontmatter.description ?? frontmatter.summary ?? content.slice(0, 500));
	const data: WebpageData = {
		createdTime: file.stat.ctime,
		modifiedTime: file.stat.mtime,
		sourceSize: file.stat.size,
		sourcePath: file.path,
		exportPath: getTargetPath(website, file),
		showInTree: true,
		treeOrder,
		backlinks,
		type: DocumentType.Markdown,
		data: null,
		title,
		aliases,
		inlineTags,
		frontmatterTags,
		headers,
		links: Array.from(links),
		attachments: Array.from(attachments),
		pathToRoot: ".",
		icon: String(frontmatter.icon ?? ""),
		description,
		author: String(frontmatter.author ?? ""),
		rssDate: String(frontmatter.date ?? new Date(file.stat.mtime).toISOString()),
		coverImageURL: "",
		fullURL: "",
	};
	return {
		record: {
			kind: "webpage",
			data,
			redirectValues: Array.from(new Set(redirects)),
			search: {
				metadata: metadataValues.join(" "),
				headers: headers.map((header) => header.heading),
				content,
			},
		},
		attachmentFiles: Array.from(attachmentFiles.values()),
	};
}
