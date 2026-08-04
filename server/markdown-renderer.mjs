import MarkdownIt from "markdown-it";

const WIKILINK_PATTERN = /(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
const TAG_PATTERN = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gu;
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function escapeAttribute(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function slugify(value) {
	return String(value)
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_ -]+/gu, "")
		.trim()
		.replace(/[\s_]+/g, "-") || "section";
}

function calloutIcon(type) {
	const paths = {
		warning: "M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0ZM12 9v4m0 4h.01",
		danger: "M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0ZM12 9v4m0 4h.01",
		error: "M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0ZM12 9v4m0 4h.01",
		question: "M9.1 9a3 3 0 1 1 5.8 1c-.9 1.1-2.9 1.5-2.9 3.5m.01 3.5h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
		quote: "M10 8H6a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2l2-4V8Zm10 0h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2l2-4V8Z",
	};
	const path = paths[type] ?? "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-11v5m0-9h.01";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="${path}"/></svg>`;
}

function splitCallouts(markdown, renderContent) {
	const lines = markdown.split(/\r?\n/);
	const output = [];
	for (let index = 0; index < lines.length;) {
		const match = lines[index].match(/^>\s*\[!(.+?)\]([+-])?\s*(.*)$/i);
		if (!match) {
			output.push(lines[index]);
			index++;
			continue;
		}

		const [, rawType, fold, rawTitle] = match;
		const body = [];
		index++;
		while (index < lines.length) {
			const line = lines[index];
			if (line === ">") {
				body.push("");
				index++;
				continue;
			}
			if (!line.startsWith(">")) break;
			body.push(line.replace(/^>\s?/, ""));
			index++;
		}

		const type = rawType.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "note";
		const title = rawTitle.trim() || rawType.trim();
		const foldMarkup = fold
			? `<div class="callout-fold${fold === "-" ? " is-collapsed" : ""}"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="m9 18 6-6-6-6"/></svg></div>`
			: "";
		output.push(
			`<div class="callout${fold === "-" ? " is-collapsed" : ""}" data-callout="${escapeAttribute(type)}"${fold ? ` data-callout-fold="${fold}"` : ""}>`,
			`<div class="callout-title"><div class="callout-icon">${calloutIcon(type)}</div><div class="callout-title-inner">${escapeAttribute(title)}</div>${foldMarkup}</div>`,
			`<div class="callout-content">${renderContent(body.join("\n"))}</div>`,
			"</div>",
		);
	}
	return output.join("\n");
}

/**
 * Renders the Markdown dialect used by the archive without requiring Electron
 * or Obsidian's DOM renderer. Link targets are supplied by the SQLite index.
 */
export class MarkdownDocumentRenderer {
	constructor({ maxEntries = 256 } = {}) {
		this.maxEntries = Math.max(1, Number(maxEntries) || 256);
		this.cache = new Map();
		this.resolveLink = () => undefined;
		this.markdown = new MarkdownIt({
			html: true,
			linkify: true,
			typographer: false,
			breaks: false,
		});
		this.markdown.core.ruler.push("archive-heading-ids", (state) => {
			const usedIds = new Map();
			for (let index = 0; index < state.tokens.length; index++) {
				const token = state.tokens[index];
				if (token.type !== "heading_open") continue;
				const inline = state.tokens[index + 1];
				const base = slugify(inline?.content ?? "section");
				const count = usedIds.get(base) ?? 0;
				usedIds.set(base, count + 1);
				token.attrSet("id", count ? `${base}-${count}` : base);
			}
		});
	}

	async render({ sourcePath, modifiedTime, sourceSize, title, displayTitle, markdown, loadMarkdown, resolveLink }) {
		const cached = this.cache.get(sourcePath);
		if (cached && cached.modifiedTime === modifiedTime && cached.sourceSize === sourceSize && cached.title === title && cached.displayTitle === displayTitle) {
			this.cache.delete(sourcePath);
			this.cache.set(sourcePath, cached);
			return cached.value;
		}

		this.resolveLink = resolveLink;
		const value = this.renderMarkdown(markdown ?? await loadMarkdown(), displayTitle || title);
		this.cache.set(sourcePath, { modifiedTime, sourceSize, title, displayTitle, value });
		while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
		return value;
	}

	renderMarkdown(markdown, title = "") {
		const source = this.replaceObsidianSyntax(String(markdown).replace(FRONTMATTER_PATTERN, ""));
		const content = splitCallouts(source, (calloutMarkdown) => this.markdown.render(calloutMarkdown));
		const html = this.markdown.render(content);
		const pageTitle = String(title).trim();
		const titleHeader = pageTitle
			? `<div class="header"><h1 class="page-title heading inline-title" id="${escapeAttribute(slugify(pageTitle))}_0">${escapeAttribute(pageTitle)}</h1><div class="data-bar"></div></div>`
			: "";
		return `<div class="obsidian-document markdown-preview-view markdown-rendered is-readable-line-width allow-fold-headings allow-fold-lists" data-type="markdown"><div class="markdown-preview-sizer markdown-preview-section">${titleHeader}${html}</div></div>`;
	}

	replaceObsidianSyntax(markdown) {
		const withMarkdownLinks = markdown.replace(/(!?)\[([^\]]*)\]\(((?:[^()\s]|\([^)]*\))+)(?:\s+['"][^)]*['"])?\)/g, (match, embed, rawLabel, rawTarget) => {
			const tagQuery = rawTarget.match(/(?:[?&]query=tag:)([^&#\s)]+)/i)?.[1];
			if (tagQuery) {
				const tag = decodeURIComponent(tagQuery).replace(/^#+/, "");
				const label = rawLabel.trim() || `#${tag}`;
				return `<a class="tag" href="/?query=tag:${encodeURIComponent(tag)}">${label}</a>`;
			}
			const [target, rawHeading] = rawTarget.split("#", 2);
			const resolved = this.resolveLink(target.trim());
			if (!resolved) return match;
			const label = rawLabel.trim() || target.split("/").pop()?.replace(/\.md$/i, "") || target;
			const href = `${resolved.exportPath}${rawHeading ? `#${slugify(rawHeading)}` : ""}`;
			if (embed) {
				const extension = resolved.sourcePath.split(".").at(-1)?.toLowerCase();
				if (["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)) {
					return `<img class="internal-embed" src="/${escapeAttribute(href)}" alt="${escapeAttribute(label)}">`;
				}
				if (extension === "pdf") {
					return `<iframe class="internal-embed" src="/${escapeAttribute(href)}" title="${escapeAttribute(label)}"></iframe>`;
				}
				return `<a class="internal-link internal-embed" href="${escapeAttribute(href)}">${escapeAttribute(label)}</a>`;
			}
			if (!resolved.sourcePath.toLowerCase().endsWith(".md")) {
				if (resolved.sourcePath.toLowerCase().endsWith(".pdf")) {
					return `<a class="internal-link attachment-link" href="${escapeAttribute(href)}">${escapeAttribute(label)}</a>`;
				}
				return `<a href="/${escapeAttribute(href)}">${escapeAttribute(label)}</a>`;
			}
			return `<a class="internal-link" href="${escapeAttribute(href)}">${escapeAttribute(label)}</a>`;
		});

		const withLinks = withMarkdownLinks.replace(WIKILINK_PATTERN, (_match, embed, rawTarget, rawHeading, rawLabel) => {
			const target = rawTarget.trim();
			const resolved = this.resolveLink(target);
			const label = rawLabel?.trim() || rawHeading?.trim() || target.split("/").pop()?.replace(/\.md$/i, "") || target;
			if (!resolved) return embed ? `![${label}](${target})` : label;
			const href = `${resolved.exportPath}${rawHeading ? `#${slugify(rawHeading)}` : ""}`;
			if (embed) {
				const extension = resolved.sourcePath.split(".").at(-1)?.toLowerCase();
				if (["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)) {
					return `<img class="internal-embed" src="/${escapeAttribute(href)}" alt="${escapeAttribute(label)}">`;
				}
				if (extension === "pdf") {
					return `<iframe class="internal-embed" src="/${escapeAttribute(href)}" title="${escapeAttribute(label)}"></iframe>`;
				}
				return `<a class="internal-link internal-embed" href="${escapeAttribute(href)}">${escapeAttribute(label)}</a>`;
			}
			if (!resolved.sourcePath.toLowerCase().endsWith(".md")) {
				if (resolved.sourcePath.toLowerCase().endsWith(".pdf")) {
					return `<a class="internal-link attachment-link" href="${escapeAttribute(href)}">${escapeAttribute(label)}</a>`;
				}
				return `<a href="/${escapeAttribute(href)}">${escapeAttribute(label)}</a>`;
			}
			return `<a class="internal-link" href="${escapeAttribute(href)}">${escapeAttribute(label)}</a>`;
		});

		return withLinks.replace(TAG_PATTERN, (_match, prefix, tag) => {
			return `${prefix}<a class="tag" href="/?query=tag:${encodeURIComponent(tag)}">#${tag}</a>`;
		});
	}
}
