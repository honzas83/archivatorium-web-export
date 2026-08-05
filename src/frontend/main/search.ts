import { Shared } from "src/shared/shared";
import { LinkHandler } from "./links";
import { getTextNodes } from "./utils";
import MiniSearch, { SearchResult } from "minisearch";
import { WebpageData } from "src/shared/website-data";
import { Tags } from "./tags";

export enum SearchType
{
	Title = 1,
	Aliases = 2,
	Headers = 4,
	Tags = 8,
	Path = 16,
	Content = 32,
	Metadata = 64,
}

const allSearch = SearchType.Title | SearchType.Aliases | SearchType.Headers | SearchType.Tags | SearchType.Path | SearchType.Content | SearchType.Metadata;

export interface BasketSearchItem
{
	exportPath: string;
	sourcePath: string;
	title: string;
}

export interface BasketSearchSnapshot
{
	query: string;
	searchQuery: string;
	type: SearchType;
	total: number;
}

export interface SearchPage
{
	items: BasketSearchItem[];
	total: number;
}

export class Search
{
	private index: MiniSearch | undefined;
	private input: HTMLInputElement;
	private container: HTMLElement;
	private serverSide: boolean = false;
	private searchEndpoint: string = "/api/search";
	private searchRequestId: number = 0;
	private status: HTMLElement;
	private statusCount: HTMLElement;
	private statusLimit: HTMLElement;
	private documentCount: number = 0;
	private static readonly inlineMarkClass = "search-mark";
	private static readonly tagMarkClass = "search-tag-mark";
	private static readonly outlineMatchClass = "outline-search-match";
	private static readonly visibleResultLimit = 1000;

	public async search(query: string, type: SearchType = allSearch)
	{
		if (query.length == 0)
		{
			this.clear();
			return;
		}

		this.input.value = query;
		this.container?.classList.add("has-content");

		if (type != allSearch)
		{
			this.input.style.color = "var(--text-accent)";
		}
		else
		{
			this.input.style.color = "";
		}

		const requestId = ++this.searchRequestId;
		this.setSearchStatus("searching");
		let page: { items: Array<SearchResult>, total: number };
		try
		{
			page = await this.runSearchQuery(query, type, Search.visibleResultLimit);
		}
		catch (error)
		{
			if (requestId === this.searchRequestId) this.setSearchStatus("error");
			throw error;
		}
		let results = page.items as Array<SearchResult>;
		if (requestId !== this.searchRequestId) return;
		this.setSearchStatus("complete", page.total);
		
		// filter results for the best matches and generate extra metadata
		const showPaths: string[] = [];
		const headerLinks: Map<string, string[]> = new Map();
		const navigationItems: Array<{ sourcePath: string, exportPath: string, title: string }> = [];
		for (const result of results)
		{
			const resultPath = this.getResultPath(result);
			if (!resultPath) continue;

			showPaths.push(resultPath);
			navigationItems.push({
				sourcePath: String((result as any).sourcePath ?? ""),
				exportPath: resultPath,
				title: this.getResultNavigationTitle(result),
			});

			// generate matching header links to display under the search result
			if(query.length > 2)
			{
				const headers: string[] = [];
				let breakEarly = false;
				for (const match in (result.match ?? {}))
				{
					if (result.match[match].includes("headers"))
					{
						for (const header of this.getResultHeaders(result))
						{
							if (header.toLowerCase().includes(match.toLowerCase()))
							{
								if (!headers.includes(header)) headers.push(header);
								if (query.toLowerCase() != match.toLowerCase()) 
								{
									breakEarly = true;
									break;
								}
							}
						}
					}

					if (breakEarly) break;
				}

				headerLinks.set(resultPath, headers);
			}
		}

		if (ObsidianSite.lazyNavigation)
		{
			await ObsidianSite.lazyNavigation.filter(navigationItems);
		}
		else
		{
			ObsidianSite.fileTree?.filter(showPaths);
			ObsidianSite.fileTree?.setSubHeadings(headerLinks);
		}

		this.applyCurrentQueryToDocument();

	}

	private filterTagResults(results: Array<SearchResult>, query: string): Array<SearchResult>
	{
		const normalizedQuery = query.trim().replace(/^#+/, "").toLowerCase();
		if (normalizedQuery.length == 0) return results;

		return results.filter((result: any) =>
		{
			const tags = this.getResultTags(result);
			return tags.some((tag) =>
			{
				const normalizedTag = String(tag).trim().replace(/^#+/, "").toLowerCase();
				return normalizedTag === normalizedQuery || normalizedTag.startsWith(`${normalizedQuery}/`);
			});
		});
	}

	public getContainer(): HTMLElement | undefined
	{
		return this.container;
	}

	public getCurrentQuery(): string
	{
		return this.input?.value?.trim() ?? "";
	}

	public async getMatchesForQuery(queryString: string): Promise<BasketSearchSnapshot>
	{
		const parsed = this.parseQueryFilter(queryString);
		const type = parsed.type ?? allSearch;
		const page = await this.runSearchQuery(parsed.value, type, 0);

		return {
			query: queryString,
			searchQuery: parsed.value,
			type,
			total: page.total,
		};
	}

	public async getSearchPage(snapshot: BasketSearchSnapshot, offset: number, limit: number): Promise<SearchPage>
	{
		const page = await this.runSearchQuery(snapshot.searchQuery, snapshot.type, limit, offset);
		return {
			total: page.total,
			items: page.items.map((result: any) => ({
				exportPath: this.getResultPath(result),
				sourcePath: String(result.sourcePath ?? ""),
				title: this.getResultTitle(result),
			})).filter((item) => item.exportPath && item.sourcePath),
		};
	}

	private async runSearchQuery(query: string, type: SearchType, limit: number, offset: number = 0): Promise<{ items: Array<SearchResult>, total: number }>
	{
		const searchFields: string[] = [];
		if (type & SearchType.Title) searchFields.push('title');
		if (type & SearchType.Aliases) searchFields.push('aliases');
		if (type & SearchType.Headers) searchFields.push('headers');
		if (type & SearchType.Tags) searchFields.push('tags');
		if (type & SearchType.Path) searchFields.push('path');
		if (type & SearchType.Content) searchFields.push('content');
		if (type & SearchType.Metadata) searchFields.push('metadata');

		const searchQuery = type === SearchType.Tags ? query : this.expandMetadataQuery(query);
		if (this.serverSide)
		{
			const response = await fetch(this.searchEndpoint, {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: searchQuery, type, limit, offset }),
			});
			if (!response.ok) throw new Error(`Search server returned ${response.status}.`);
			const data = await response.json();
			return {
				items: Array.isArray(data.items) ? data.items : [],
				total: Number(data.total ?? 0),
			};
		}

		let results: Array<SearchResult> = this.index?.search(searchQuery,
		{
			prefix: true,
			fuzzy: false,
			boost: { metadata: 8, title: 2, aliases: 1.8, headers: 1.5, tags: 1.3, path: 1.1 },
			fields: searchFields
		}) ?? [];

		if (type === SearchType.Tags)
		{
			results = this.filterTagResults(results, query);
		}

		const total = results.length;
		return {
			items: limit > 0 ? results.slice(offset, offset + limit) : [],
			total,
		};
	}

	private getResultPath(result: any): string
	{
		return String(result.path ?? result.id ?? "");
	}

	private getResultWebpage(result: any): WebpageData | undefined
	{
		const path = this.getResultPath(result);
		return path ? ObsidianSite.getWebpageData(path) : undefined;
	}

	private getResultTitle(result: any): string
	{
		return String(result.title ?? this.getResultWebpage(result)?.title ?? this.getResultPath(result));
	}

	private getResultNavigationTitle(result: any): string
	{
		return String(result.navigationTitle ?? this.getResultTitle(result));
	}

	private getResultHeaders(result: any): string[]
	{
		const storedHeaders = result.headers as string[] | undefined;
		if (storedHeaders) return storedHeaders;
		return this.getResultWebpage(result)?.headers?.map((header) => header.heading) ?? [];
	}

	private getResultTags(result: any): string[]
	{
		const storedTags = result.tags as string[] | undefined;
		if (storedTags) return storedTags;
		const webpage = this.getResultWebpage(result);
		return [
			...(webpage?.inlineTags ?? []),
			...(webpage?.frontmatterTags ?? []),
		];
	}

	private expandMetadataQuery(query: string): string
	{
		const normalized = query.toLowerCase().replace(/[^a-z0-9]/g, "");
		if (!/[a-z]/i.test(query) || !/\d/.test(query) || normalized === query.toLowerCase()) return query;
		return normalized;
	}

	public async searchParseFilters(queryString: string)
	{
		const parsed = this.parseQueryFilter(queryString);
		const filterValue = parsed.value;
		await this.search(filterValue, parsed.type ?? allSearch);
	}

	public clear()
	{
		this.searchRequestId++;
		this.container?.classList.remove("has-content");
		this.setSearchStatus("idle", this.documentCount);
		this.input.value = "";
		this.updateBrowserQuery("");
		this.clearCurrentDocumentSearch();
		if (ObsidianSite.lazyNavigation) void ObsidianSite.lazyNavigation.clearFilter();
		else {
			ObsidianSite.fileTree?.unfilter();
			ObsidianSite.fileTree?.removeSubHeadings();
			ObsidianSite.fileTree?.unsort();
		}
	}

	public async init(): Promise<Search | undefined>
	{
		this.input = document.querySelector('input[type="search"]') as HTMLInputElement;
		this.container = this.input?.closest("#search-container") as HTMLElement;
		if (!this.input || !this.container) return;

		ObsidianSite.metadata.featureOptions.search.insertFeature(document.body, this.container);
		this.createSearchStatus();

		this.serverSide = ObsidianSite.metadata.featureOptions.search.serverSide === true;
		this.searchEndpoint = ObsidianSite.metadata.featureOptions.search.searchEndpoint ?? "/api/search";
		this.documentCount = Number(ObsidianSite.metadata.documentCount ?? 0);
		this.setSearchStatus("idle", this.documentCount);

		if (!this.serverSide)
		{
			const indexResp = await ObsidianSite.fetch(Shared.libFolderName + '/search-index.json');
			if (!indexResp?.ok)
			{
				console.error("Failed to fetch search index");
				return;
			}
			const indexJSON = await indexResp.json();
			try
			{
				// @ts-ignore
				this.index = MiniSearch.loadJS(indexJSON, { fields: ['title', 'metadata', 'aliases', 'headers', 'tags', 'path', 'content'] });
			}
			catch (e)
			{
				console.error("Failed to load search index: ", e);
				return;
			}
		}

		const inputClear = document.querySelector('#search-clear-button');
		inputClear?.setAttribute("role", "button");
		inputClear?.setAttribute("tabindex", "0");
		inputClear?.addEventListener('click', (event) => 
		{
			this.clear();
		});
		inputClear?.addEventListener('keydown', (event) =>
		{
			if ((event as KeyboardEvent).key === "Enter" || (event as KeyboardEvent).key === " ")
			{
				event.preventDefault();
				this.clear();
				this.input.focus();
			}
		});

		this.input.addEventListener('input', async (event) =>
		{
			const query = (event.target as HTMLInputElement)?.value ?? "";
			if (query.length == 0)
			{
				this.clear();
				return;
			}
			this.updateBrowserQuery(query);
			
			try
			{
				await this.searchParseFilters(query);
			}
			catch (error)
			{
				console.error("Search failed:", error);
			}
		});

		return this;
	}

	private updateBrowserQuery(query: string)
	{
		if (!ObsidianSite.isHttp) return;

		const url = new URL(window.location.href);
		if (query) url.searchParams.set("query", query);
		else url.searchParams.delete("query");

		const search = url.searchParams.toString()
			.replace(/\+/g, "%20")
			.replace(/%3A/gi, ":");
		const browserURL = `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
		history.replaceState(
			{ pathname: LinkHandler.getPathnameFromURL(browserURL), url: browserURL },
			document.title,
			browserURL,
		);
	}

	private createSearchStatus()
	{
		this.status = document.createElement("div");
		this.status.id = "search-status";
		this.status.className = "search-status is-idle";
		this.status.setAttribute("role", "status");
		this.status.setAttribute("aria-live", "polite");
		this.status.setAttribute("aria-atomic", "true");

		this.statusCount = document.createElement("span");
		this.statusCount.className = "search-status-count";
		this.statusLimit = document.createElement("span");
		this.statusLimit.className = "search-status-limit";
		this.status.append(this.statusCount, this.statusLimit);
		(document.querySelector("#left-sidebar-content") as HTMLElement).prepend(this.status);
	}

	private setSearchStatus(state: "idle" | "searching" | "complete" | "error", total: number = 0)
	{
		if (!this.status) return;
		this.status.className = `search-status is-${state}`;
		this.statusLimit.textContent = "";

		if (state === "idle") this.statusCount.textContent = `${total.toLocaleString()} ${total === 1 ? "document" : "documents"}`;
		else if (state === "searching") this.statusCount.textContent = "Searching…";
		else if (state === "error") this.statusCount.textContent = "Search unavailable";
		else if (total === 0) this.statusCount.textContent = "No matching documents";
		else this.statusCount.textContent = `${total.toLocaleString()} ${total === 1 ? "document" : "documents"}`;

		if (state === "complete" && total > Search.visibleResultLimit)
		{
			this.statusLimit.textContent = `Showing first ${Search.visibleResultLimit.toLocaleString()}`;
		}
	}

	public applyCurrentQueryToDocument(afterNavigation = false)
	{
		const query = this.input?.value?.trim() ?? "";
		if (query.length == 0)
		{
			this.clearCurrentDocumentSearch();
			return;
		}

		const parsed = this.parseQueryFilter(query);
		if (parsed.type === SearchType.Tags)
		{
			this.highlightTagInCurrentDocument(parsed.value);
		}
		else if (parsed.type === SearchType.Content || parsed.type === null)
		{
			if (afterNavigation) Tags.showTableOfContents();
			this.searchCurrentDocument(parsed.value);
		}
		else
		{
			this.clearCurrentDocumentSearch();
		}
	}

	private parseQueryFilter(queryString: string): { type: SearchType | null, value: string }
	{
		if (queryString.startsWith("?")) queryString = queryString.substring(1);
		let filterName = queryString.split(":")[0];
		if (!queryString.includes(":")) filterName = "";
		const filterValue = filterName
			? queryString.substring(filterName.length + 1).trim()
			: queryString;

		if (filterName == "content" || filterName == "text" || filterName == "body")
		{
			return { type: SearchType.Content, value: filterValue };
		}
		if (filterName == "title" || filterName == "name")
		{
			return { type: SearchType.Title, value: filterValue };
		}
		if (filterName == "path")
		{
			return { type: SearchType.Path, value: filterValue };
		}
		if (filterName == "header" || filterName == "headers")
		{
			return { type: SearchType.Headers, value: filterValue };
		}
		if (filterName == "tag" || filterName == "tags" || queryString.startsWith("#"))
		{
			const tagQuery = queryString.startsWith("#")
				? queryString
				: `#${filterValue.replace(/^#+/, "")}`;
			return { type: SearchType.Tags, value: tagQuery };
		}
		if (filterName == "alias" || filterName == "aliases")
		{
			return { type: SearchType.Aliases, value: filterValue };
		}

		return { type: null, value: queryString };
	}

	private async searchCurrentDocument(query: string)
	{
		this.clearCurrentDocumentSearch();
		const normalizedQuery = query.trim();
		if (normalizedQuery.length == 0) return;

		const escapedQuery = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const queryPattern = new RegExp(escapedQuery, 'gi');
		const textNodes = getTextNodes(ObsidianSite.document.sizerEl ?? ObsidianSite.document.documentEl);

		for (const node of textNodes)
		{
			const parent = node.parentElement;
			if (!parent || parent.closest(
				'.callout[data-callout="metadata"], .callout[data-callout="citingthisdocument"], script, style, button, textarea'
			)) continue;
			const content = node.nodeValue ?? "";
			queryPattern.lastIndex = 0;
			const matches = Array.from(content.matchAll(queryPattern));
			if (matches.length === 0) continue;

			const fragment = document.createDocumentFragment();
			let cursor = 0;
			for (const match of matches)
			{
				const index = match.index ?? 0;
				if (index > cursor) fragment.appendChild(document.createTextNode(content.slice(cursor, index)));
				const mark = document.createElement("mark");
				mark.classList.add(Search.inlineMarkClass);
				mark.textContent = match[0];
				fragment.appendChild(mark);
				cursor = index + match[0].length;
			}
			if (cursor < content.length) fragment.appendChild(document.createTextNode(content.slice(cursor)));
			node.parentNode?.replaceChild(fragment, node);
		}

		this.updateOutlineSearchMatches();

		const firstMark = document.querySelector(".search-mark");

		// wait for page to fade in
		setTimeout(() => 
		{
			if(firstMark) ObsidianSite.scrollTo(firstMark);
		}, 500);
	}

	private updateOutlineSearchMatches()
	{
		const outline = document.querySelector("#outline");
		const documentRoot = ObsidianSite.document.sizerEl ?? ObsidianSite.document.documentEl;
		if (!outline || !documentRoot) return;

		let pageId = "";
		let matchNumber = 0;
		const pageChildren = new Map<string, HTMLElement>();
		const content = Array.from(documentRoot.querySelectorAll(
			"h1, h2, h3, h4, h5, h6, mark.search-mark"
		)) as HTMLElement[];

		for (const element of content)
		{
			if (/^H[1-6]$/.test(element.tagName))
			{
				if (/^Page\s+\d+\b/i.test((element.textContent ?? "").trim())) pageId = element.id;
				continue;
			}
			if (!pageId) continue;

			let children = pageChildren.get(pageId);
			if (!children)
			{
				const pageLink = Array.from(outline.querySelectorAll<HTMLAnchorElement>("a[data-path]"))
					.find((link) => link.dataset.path === `#${pageId}`);
				const pageItem = pageLink?.parentElement;
				children = Array.from(pageItem?.children ?? [])
					.find((child) => child.classList.contains("tree-item-children")) as HTMLElement | undefined;
				if (!children) continue;
				pageChildren.set(pageId, children);
			}

			matchNumber++;
			const anchorId = `search-match-${matchNumber}`;
			element.id = anchorId;
			const context = this.getMatchContext(element);
			const item = document.createElement("div");
			item.classList.add("tree-item", Search.outlineMatchClass);
			item.dataset.depth = String(Number(children.parentElement?.dataset.depth ?? 1) + 1);
			const link = document.createElement("a");
			link.classList.add("tree-item-self", "is-clickable");
			link.href = `#${anchorId}`;
			link.dataset.path = `#${anchorId}`;
			link.setAttribute("aria-label", `Go to occurrence: ${context.before} ${element.textContent ?? ""} ${context.after}`.trim());
			const label = document.createElement("div");
			label.classList.add("tree-item-inner");
			label.appendChild(document.createTextNode(`${context.hasBefore ? "… " : ""}${context.before}`));
			const mark = document.createElement("mark");
			mark.classList.add(Search.inlineMarkClass);
			mark.textContent = element.textContent;
			label.appendChild(mark);
			label.appendChild(document.createTextNode(`${context.after}${context.hasAfter ? " …" : ""}`));
			link.appendChild(label);
			link.addEventListener("click", (event) =>
			{
				event.preventDefault();
				ObsidianSite.scrollTo(element);
			});
			item.appendChild(link);
			children.appendChild(item);
		}
	}

	private getMatchContext(mark: HTMLElement): { before: string, after: string, hasBefore: boolean, hasAfter: boolean }
	{
		const block = mark.closest("p, li, td, th, blockquote, pre") ?? mark.parentElement;
		const text = block?.textContent ?? mark.textContent ?? "";
		const marks = Array.from(block?.querySelectorAll(`.${Search.inlineMarkClass}`) ?? []);
		let cursor = 0;
		let start = text.toLowerCase().indexOf((mark.textContent ?? "").toLowerCase());
		for (const candidate of marks)
		{
			const value = candidate.textContent ?? "";
			const index = text.toLowerCase().indexOf(value.toLowerCase(), cursor);
			if (candidate === mark) {
				start = index;
				break;
			}
			if (index >= 0) cursor = index + value.length;
		}
		start = Math.max(0, start);
		const end = start + (mark.textContent?.length ?? 0);
		const contextLength = 32;
		const hasBefore = start > contextLength;
		const hasAfter = text.length - end > contextLength;
		let before = text.slice(Math.max(0, start - contextLength), start).replace(/\s+/g, " ");
		let after = text.slice(end, end + contextLength).replace(/\s+/g, " ");
		if (hasBefore) before = before.replace(/^\S*\s*/, "");
		if (hasAfter) after = after.replace(/\s*\S*$/, "");
		return { before: before.trimStart(), after: after.trimEnd(), hasBefore, hasAfter };
	}

	private highlightTagInCurrentDocument(query: string)
	{
		this.clearCurrentDocumentSearch();
		const normalizedQuery = query.trim().replace(/^#+/, "").toLowerCase();
		if (normalizedQuery.length == 0) return;

		const tagLinks = Array.from(
			(ObsidianSite.document.sizerEl ?? ObsidianSite.document.documentEl)?.querySelectorAll("a.tag") ?? []
		) as HTMLAnchorElement[];

		const matches = tagLinks.filter((tagLink) =>
		{
			const tagText = (tagLink.textContent ?? "").trim().replace(/^#+/, "").toLowerCase();
			return tagText === normalizedQuery || tagText.startsWith(`${normalizedQuery}/`);
		});

		matches.forEach((match) => match.classList.add(Search.tagMarkClass));

		const firstMatch = matches[0];
		setTimeout(() =>
		{
			if (firstMatch) ObsidianSite.scrollTo(firstMatch);
		}, 300);
	}

	private clearCurrentDocumentSearch()
	{
		document.querySelectorAll(`#outline .${Search.outlineMatchClass}`).forEach((node) => node.remove());
		document.querySelectorAll(`.${Search.inlineMarkClass}`).forEach(node =>
		{
			node.replaceWith(document.createTextNode(node.textContent ?? ""));
		});
		document.querySelectorAll(`.${Search.tagMarkClass}`).forEach((node) =>
		{
			node.classList.remove(Search.tagMarkClass);
		});
	}
}
