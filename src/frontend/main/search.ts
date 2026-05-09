import { Shared } from "src/shared/shared";
import { LinkHandler } from "./links";
import { getTextNodes } from "./utils";
import MiniSearch, { SearchResult } from "minisearch";

export enum SearchType
{
	Title = 1,
	Aliases = 2,
	Headers = 4,
	Tags = 8,
	Path = 16,
	Content = 32,
}

const allSearch = SearchType.Title | SearchType.Aliases | SearchType.Headers | SearchType.Tags | SearchType.Path | SearchType.Content;

export class Search
{
	private index: MiniSearch; // MiniSearch
	private input: HTMLInputElement;
	private container: HTMLElement;
	private static readonly inlineMarkClass = "search-mark";
	private static readonly tagMarkClass = "search-tag-mark";

	// only used when the file tree is not present
	private dedicatedSearchResultsList: HTMLElement;
	

	public search(query: string, type: SearchType = allSearch)
	{
		if (query.length == 0)
		{
			this.clear();
			return;
		}

		this.input.value = query;

		if (type != allSearch)
		{
			this.input.style.color = "var(--text-accent)";
		}
		else
		{
			this.input.style.color = "";
		}

		const searchFields: string[] = [];
		if (type & SearchType.Title) searchFields.push('title');
		if (type & SearchType.Aliases) searchFields.push('aliases');
		if (type & SearchType.Headers) searchFields.push('headers');
		if (type & SearchType.Tags) searchFields.push('tags');
		if (type & SearchType.Path) searchFields.push('path');
		if (type & SearchType.Content) searchFields.push('content');

		console.log(type & SearchType.Title, type & SearchType.Aliases, type & SearchType.Headers, type & SearchType.Tags, type & SearchType.Path, type & SearchType.Content);
	
		
		let results: Array<SearchResult> = this.index.search(query,
		{ 
			prefix: true, 
			fuzzy: 0.2, 
			boost: { title: 2, aliases: 1.8, headers: 1.5, tags: 1.3, path: 1.1 }, 
			fields: searchFields 
		});

		if (type === SearchType.Tags)
		{
			results = this.filterTagResults(results, query);
		}

		console.log("Search results", results);

		// clamp results to at most the top 50
		if (results.length > 50) results.splice(50);
		
		// filter results for the best matches and generate extra metadata
		const showPaths: string[] = [];
		const headerLinks: Map<string, string[]> = new Map();
		for (const result of results)
		{
			// only show the most relevant results
			if ((result.score < results[0].score * 0.30 && showPaths.length > 4) || result.score < results[0].score * 0.1) 
				break;

			showPaths.push(result.path);

			// generate matching header links to display under the search result
			if(query.length > 2)
			{
				const headers: string[] = [];
				let breakEarly = false;
				for (const match in result.match)
				{
					if (result.match[match].includes("headers"))
					{
						for (const header of result.headers)
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

				headerLinks.set(result.path, headers);
			}
		}

		ObsidianSite.fileTree?.filter(showPaths);
		ObsidianSite.fileTree?.setSubHeadings(headerLinks);
		ObsidianSite.fileTree?.sort((a, b) =>
		{
			if (!a || !b) return 0;
			return showPaths.findIndex((path) => a.path == path) - showPaths.findIndex((path) => b.path == path);
		});

		if (!ObsidianSite.fileTree)
		{
			const list = document.createElement('div');
			results.filter((result: any) => result.path.endsWith(".html"))
					.slice(0, 20).forEach((result: any) => 
					{
						const item = document.createElement('div');
						item.classList.add('search-result');

						const link = document.createElement('a');
						link.classList.add('tree-item-self');

						const searchURL = result.path + '?mark=' + encodeURIComponent(query);
						link.setAttribute('href', searchURL);
						link.appendChild(document.createTextNode(result.title));
						item.appendChild(link);
						list.append(item);
					});

			this.dedicatedSearchResultsList.replaceChildren(list);
			this.container.after(this.dedicatedSearchResultsList);
			LinkHandler.initializeLinks(this.dedicatedSearchResultsList);
		}
	
	}

	private filterTagResults(results: Array<SearchResult>, query: string): Array<SearchResult>
	{
		const normalizedQuery = query.trim().replace(/^#+/, "").toLowerCase();
		if (normalizedQuery.length == 0) return results;

		return results.filter((result: any) =>
		{
			const tags = (result.tags ?? []) as string[];
			return tags.some((tag) =>
			{
				const normalizedTag = String(tag).trim().replace(/^#+/, "").toLowerCase();
				return normalizedTag === normalizedQuery || normalizedTag.startsWith(`${normalizedQuery}/`);
			});
		});
	}

	public searchParseFilters(queryString: string)
	{
		const parsed = this.parseQueryFilter(queryString);
		const filterValue = parsed.value;

		if (parsed.type === SearchType.Content)
		{
			this.search(filterValue, SearchType.Content);
		}
		else if (parsed.type === SearchType.Title)
		{
			this.search(filterValue, SearchType.Title);
		}
		else if (parsed.type === SearchType.Path)
		{
			this.search(filterValue, SearchType.Path);
		}
		else if (parsed.type === SearchType.Headers)
		{
			this.search(filterValue, SearchType.Headers);
		}
		else if (parsed.type === SearchType.Tags)
		{
			this.search(filterValue, SearchType.Tags);
		}
		else if (parsed.type === SearchType.Aliases)
		{
			this.search(filterValue, SearchType.Aliases);
		}
		else
		{
			this.search(filterValue);
		}
	}

	public clear()
	{
		this.container?.classList.remove("has-content");
		this.input.value = "";
		this.clearCurrentDocumentSearch();
		ObsidianSite.fileTree?.unfilter();
		ObsidianSite.fileTree?.removeSubHeadings();
		ObsidianSite.fileTree?.unsort();
	}

	public async init(): Promise<Search | undefined>
	{
		this.input = document.querySelector('input[type="search"]') as HTMLInputElement;
		this.container = this.input?.closest("#search-container") as HTMLElement;
		if (!this.input || !this.container) return;

		ObsidianSite.metadata.featureOptions.search.insertFeature(document.body, this.container);

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
			this.index = MiniSearch.loadJS(indexJSON, { fields: ['title', 'path', 'tags', 'headers'] });
		}
		catch (e)
		{
			console.error("Failed to load search index: ", e);
			return;
		}

		const inputClear = document.querySelector('#search-clear-button');
		inputClear?.addEventListener('click', (event) => 
		{
			this.clear();
		});

		this.input.addEventListener('input', (event) => 
		{
			const query = (event.target as HTMLInputElement)?.value ?? "";
			if (query.length == 0)
			{
				this.clear();
				return;
			}
			
			this.searchParseFilters(query);
		});

		if (!ObsidianSite.fileTree)
		{
			this.dedicatedSearchResultsList = document.createElement('div');
			this.dedicatedSearchResultsList.setAttribute('id', 'search-results');
		}

		return this;
	}

	public applyCurrentQueryToDocument()
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
		else if (parsed.type === SearchType.Content)
		{
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
		const textNodes = getTextNodes(ObsidianSite.document.sizerEl ?? ObsidianSite.document.documentEl);

		textNodes.forEach(async (node) =>
		{
			const content = node.nodeValue;
			const newContent = content?.replace(new RegExp(query, 'gi'), match => `<mark>${match}</mark>`);

			if (newContent && newContent !== content) 
			{
				const tempDiv = document.createElement('div');
				tempDiv.innerHTML = newContent;
		
				const newNodes = Array.from(tempDiv.childNodes);
		
				newNodes.forEach(newNode => 
				{
					if (newNode.nodeType != Node.TEXT_NODE)
					{
						(newNode as Element)?.classList.add(Search.inlineMarkClass);
					}
					node?.parentNode?.insertBefore(newNode, node);
				});
		
				node?.parentNode?.removeChild(node);
			}
		});

		const firstMark = document.querySelector(".search-mark");

		// wait for page to fade in
		setTimeout(() => 
		{
			if(firstMark) ObsidianSite.scrollTo(firstMark);
		}, 500);
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
		document.querySelectorAll(`.${Search.inlineMarkClass}`).forEach(node =>
		{
			node.outerHTML = node.innerHTML;
		});
		document.querySelectorAll(`.${Search.tagMarkClass}`).forEach((node) =>
		{
			node.classList.remove(Search.tagMarkClass);
		});
	}
}
