import { Search } from "./search";
import { Sidebar } from "./sidebars";
import { Tree } from "./trees";
import { Bounds, delay, getLengthInPixels, waitUntil } from "./utils";
import { WebpageDocument as ObsidianDocument } from "./document";
import {
	DocumentType,
	FileData,
	WebpageData,
	WebsiteData,
	WebsiteOptions,
} from "src/shared/website-data";
import { GraphView } from "./graph-view";
import { Notice } from "./notifications";
import { Theme } from "./theme";
import { LinkHandler } from "./links";
import { Shared } from "src/shared/shared";
import { FilePreviewPopover } from "./link-preview";
import { DynamicInsertedFeature } from "src/shared/dynamic-inserted-feature";
import { CounterFeature } from "./counter-feature";
import {
	FeatureRelation,
	InsertedFeatureOptions,
	RelationType,
} from "src/shared/features/feature-options-base";
import { BacklinkList } from "./backlinks";
import { Tags } from "./tags";
import { Aliases } from "./aliases";
import { ShoppingBasket } from "./shopping-basket";
import { LazyNavigation } from "./lazy-navigation";

type Constructor<T> = new () => T;

function isConstructor(value: any): value is Constructor<any> {
	return (
		typeof value === "function" &&
		value.prototype &&
		value.prototype.constructor === value &&
		value.prototype.constructor.name !== "Object"
	);
}

export class ObsidianWebsite {
	public LinkHandler: LinkHandler = LinkHandler;
	public LinkPreview: unknown = FilePreviewPopover;

	public bodyEl: HTMLElement;
	public horizontalLayout: HTMLElement;
	public centerContentEl: HTMLElement;
	public loadingEl: HTMLElement;

	public isLoaded: boolean = false;
	public isHttp: boolean = window.location.protocol != "file:";
	public metadata: WebsiteData;
	public theme: Theme;
	public fileTree: Tree | undefined = undefined;
	public lazyNavigation: LazyNavigation | undefined = undefined;
	public outlineTree: Tree | undefined = undefined;
	public search: Search | undefined = undefined;
	public leftSidebar: Sidebar | undefined = undefined;
	public rightSidebar: Sidebar | undefined = undefined;
	public document: ObsidianDocument;
	public graphView: GraphView | undefined = undefined;
	public backlinkList: BacklinkList | undefined = undefined;
	public tags: Tags | undefined = undefined;
	public aliases: Aliases | undefined = undefined;
	public shoppingBasket: ShoppingBasket | undefined = undefined;

	public entryPage: string;
	private outlineObserver: IntersectionObserver | undefined = undefined;

	private onloadCallbacks: ((document: ObsidianDocument) => void)[] = [];
	public onDocumentLoad(callback: (document: ObsidianDocument) => void) {
		this.onloadCallbacks.push(callback);
	}

	public async init() {
		window.addEventListener("load", () => ObsidianSite.onInit());

		if (this.isHttp) {
			this.metadata = (await this.loadWebsiteData()) as WebsiteData;
			if (!this.metadata) {
				console.error("Failed to load website data.");
				return;
			}
		}
	}

	private async onInit() {
		if (!this.isHttp) {
			this.metadata = (await this.loadWebsiteData()) as WebsiteData;
			if (!this.metadata) {
				console.error("Failed to load website data.");
				this.metadata = new WebsiteData();
				this.metadata.ignoreMetadata = true;
			}
		}

		await waitUntil(() => this.metadata != undefined, 16);

		console.log("Website init");
		if (window.location.protocol != "file:") {
			// @ts-expect-error defined in deferred.js
			await loadIncludes();
		}

		this.theme = new Theme();

		this.bodyEl = document.body;
		this.horizontalLayout = document.querySelector("#main-horizontal") as HTMLElement;
		this.centerContentEl = document.querySelector(
			"#center-content"
		) as HTMLElement;

		const fileTreeEl = document.querySelector(
			"#file-explorer"
		) as HTMLElement;
		const leftSidebarEl = document.querySelector(
			".sidebar#left-sidebar"
		) as HTMLElement;
		const rightSidebarEl = document.querySelector(
			".sidebar#right-sidebar"
		) as HTMLElement;

		this.bodyEl.className += " " + this.metadata.bodyClasses;

		this.createLoadingEl();

		if (fileTreeEl && this.metadata.navigationMode === "lazy") {
			this.lazyNavigation = new LazyNavigation(fileTreeEl, this.metadata.siteName ?? "Files");
			this.lazyNavigation.onTreeChanged = (tree) => this.fileTree = tree;
			await this.lazyNavigation.initialize();
			this.fileTree = this.lazyNavigation.tree;
		} else if (fileTreeEl) this.fileTree = new Tree(fileTreeEl);
		if (leftSidebarEl) this.leftSidebar = new Sidebar(leftSidebarEl);
		if (rightSidebarEl) this.rightSidebar = new Sidebar(rightSidebarEl);
		this.search = await new Search().init();
		if (
			this.search &&
			this.isHttp &&
			this.metadata.featureOptions.shoppingBasket?.enabled !== false
		) {
			this.shoppingBasket = new ShoppingBasket(this.search);
		}

		const requestedPathname = LinkHandler.getPathnameFromURL(window.location.pathname);
		const metadataPathname =
			document
				.querySelector("meta[name='pathname']")
				?.getAttribute("content") ?? "unknown";
		const pathname = this.resolveWebpagePath(requestedPathname) ?? metadataPathname;
		this.entryPage = pathname;

		const initialDocument = new ObsidianDocument(pathname);
		const loadedDocument = this.metadata.serverMetadata && this.isHttp
			? await initialDocument.load()
			: initialDocument;
		if (!loadedDocument) return;
		this.document = loadedDocument;
		if (!(this.metadata.serverMetadata && this.isHttp)) {
			await this.document.loadChildDocuments();
			await this.document.postLoadInit();
		}
		await this.lazyNavigation?.revealDocument(this.document.info.sourcePath, this.document.pathname);

		if (
			!ObsidianSite.metadata.ignoreMetadata &&
			ObsidianSite.metadata.featureOptions.graphView.enabled
		) {
			this.loadGraphView().then(() =>
				this.graphView?.showGraph([pathname])
			);
		}

		this.initEvents();

		FilePreviewPopover.loadPinnedPreviews();

		this.onDocumentLoad((doc) => {
			this.updateOutline(doc);

			if (!ObsidianSite.metadata.ignoreMetadata) {
				const insertBacklinks =
					doc.isMainDocument &&
					!ObsidianSite.metadata.ignoreMetadata &&
					ObsidianSite.metadata.featureOptions.backlinks.enabled &&
					doc.documentType == DocumentType.Markdown;
				const insertTags =
					doc.isMainDocument &&
					!ObsidianSite.metadata.ignoreMetadata &&
					ObsidianSite.metadata.featureOptions.tags.enabled;
				const insertAliases =
					doc.isMainDocument &&
					!ObsidianSite.metadata.ignoreMetadata &&
					ObsidianSite.metadata.featureOptions.alias.enabled &&
					doc.documentType == DocumentType.Markdown;

				// ------------------ BACKLINKS -----------------
				if (insertBacklinks) {
					const backlinks = doc.info.backlinks?.filter(
						(b) => b != doc.pathname
					);

					if (!this.backlinkList) {
						this.backlinkList = new BacklinkList(
							doc.info.backlinks ?? []
						);
					} else {
						this.backlinkList?.modifyDependencies((d) => {
							d.backlinkPaths = doc.info.backlinks ?? [];
						});
					}

					if (!backlinks || backlinks.length == 0) {
						this.backlinkList?.hide();
					} else {
						this.backlinkList?.show();
					}
				} else {
					this.backlinkList?.hide();
				}

				// ------------------ TAGS -----------------
				if (insertTags) {
					const tagTree = ObsidianSite.metadata.tagTree ?? [];

					if (!this.tags) {
						this.tags = new Tags(tagTree);
					}

					if (tagTree.length == 0) {
						this.tags?.hide();
					} else {
						this.tags?.show();
					}
				} else {
					this.tags?.hide();
				}

				// ------------------ ALIASES -----------------
				if (insertAliases) {
					const aliases = doc.info.aliases;

					if (!this.aliases) {
						this.aliases = new Aliases(aliases ?? []);
					} else {
						this.aliases?.modifyDependencies((d) => {
							d.aliases = aliases ?? [];
						});
					}

					if (!aliases || aliases.length == 0) {
						this.aliases?.hide();
					} else {
						this.aliases?.show();
					}
				} else {
					this.aliases?.hide();
				}
			}
		});

		// Set initial history state
		const initialQuery = LinkHandler.getQueryFromURL(window.location.href);
		if (this.isHttp) {
			const initialURL = this.getBrowserURL(
				this.document.pathname,
				initialQuery,
				LinkHandler.getHashFromURL(window.location.href),
			);
			document.title = this.document.title;
			this.updateBrowserHistory(initialURL, this.document.title, true);
		}

		this.isLoaded = true;
		this.onloadCallbacks.forEach((cb) => cb(this.document));
		await this.document.show();
		if (initialQuery.startsWith("query=")) {
			await this.search?.searchParseFilters(initialQuery.substring(6));
		}
	}

	private initEvents() {
		document.addEventListener("click", (event) => {
			const target = event.target as Element | null;
			const tagLink = target?.closest(
				"a.tag, #tags a.tree-item-self"
			) as HTMLAnchorElement | null;
			if (!tagLink || event.defaultPrevented) return;
			const href = tagLink.getAttribute("href");
			if (!href) return;

			event.preventDefault();
			event.stopPropagation();
			void this.loadURL(href);
		});

		window.addEventListener("popstate", async (e) => {
			console.log("popstate", e);
			const target = e.state?.url ?? e.state?.pathname ??
				`${window.location.pathname}${window.location.search}${window.location.hash}`;
			await ObsidianSite.loadURL(target, false);
		});

		const localThis = this;
		window.addEventListener("resize", () => {
			localThis.onResize();
		});
		this.onResize();
	}

	public updateMetaTag(name: string, content: string) {
		let meta = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
		if (!meta) {
			meta = document.createElement('meta');
			if (name.startsWith('og:')) {
				meta.setAttribute('property', name);
			} else {
				meta.setAttribute('name', name);
			}
			document.head.appendChild(meta);
		}
		meta.setAttribute('content', content);
	}

	private getBrowserURL(pathname: string, query: string = "", header: string = ""): string {
		const cleanPath = LinkHandler.getPathnameFromURL(pathname).replace(/^\/+/, "");
		let browserURL = cleanPath === "index.html" || cleanPath === "" ? "/" : `/${cleanPath}`;
		if (query) {
			if (query.startsWith("query=")) {
				const encodedQuery = encodeURIComponent(query.substring(6)).replace(/%3A/gi, ":");
				browserURL += `?query=${encodedQuery}`;
			}
			else browserURL += `?${query}`;
		}
		if (header) browserURL += `#${encodeURIComponent(header)}`;
		return browserURL;
	}

	private updateBrowserHistory(url: string, title: string, replace: boolean = false): void {
		const state = { pathname: LinkHandler.getPathnameFromURL(url), url };
		if (replace) history.replaceState(state, title, url);
		else history.pushState(state, title, url);
	}

	public async loadURL(url: string, pushState: boolean = true): Promise<ObsidianDocument | undefined> {
		const header = LinkHandler.getHashFromURL(url);
		const query = LinkHandler.getQueryFromURL(url);
		url = LinkHandler.getPathnameFromURL(url);
		url = this.resolveWebpagePath(url) ?? url;
		console.log("Loading URL", url, header, query);

		if (query && query.startsWith("query=")) {
			await this.search?.searchParseFilters(query.substring(6));
			if (this.isHttp && pushState) {
				this.updateBrowserHistory(this.getBrowserURL(url, query, header), document.title);
			}
			return;
		}

		// if this document is already loaded
		if (this.document.pathname == url) {
			if (header) this.document.scrollToHeader(header);
			else if (pushState) {
				new Notice("This page is already loaded.");
			}
			if (!pushState) this.search?.clear();
			if (this.isHttp && pushState && header) {
				this.updateBrowserHistory(this.getBrowserURL(url, "", header), this.document.title);
			}

			return this.document;
		}

		if (!this.metadata.serverMetadata) {
			const data = await ObsidianSite.getWebpageDataAsync(url);
			if (!data) {
				new Notice("This page does not exist yet.");
				console.warn("Page does not exist", url);
				return undefined;
			}
		}

		const page = await new ObsidianDocument(url).load();

		if (!page)
		{
			new Notice("Failed to load page. Unknown error.");
			return;	
		}

		// Update meta tags
		document.title = page.title;
		this.updateMetaTag("pathname", page.pathname);
		this.updateMetaTag("description", page.info?.description || "");
		this.updateMetaTag("author", page.info?.author || "");
		this.updateMetaTag("og:title", page.title);
		this.updateMetaTag("og:description", page.info?.description || "");
		this.updateMetaTag("og:image", page.info?.coverImageURL || "");

		// Update graph view and file tree
		await this.graphView?.showGraph([page.pathname]);
		await this.lazyNavigation?.revealDocument(page.info.sourcePath, page.pathname);
		this.fileTree?.findByPath(page.pathname)?.setActive();
		this.fileTree?.revealPath(page.pathname);
		this.graphView?.setActiveNodeByPath(page.pathname);
		this.document = page;

		if (this.document && this.isHttp && pushState) {
			this.updateBrowserHistory(
				this.getBrowserURL(this.document.pathname, "", header),
				this.document.title,
			);
		}
		this.updateMetaTag("og:url", window.location.href);

		setTimeout(async () => {

			this.onloadCallbacks.forEach((cb) => cb(page));

			await page.show();
			this.search?.applyCurrentQueryToDocument(true);

			if (header) {
				page.scrollToHeader(header);
			}
		}, 100); // Small delay to ensure the DOM is updated

		return page;
	}

	private updateOutline(page: ObsidianDocument): void {
		this.outlineObserver?.disconnect();
		this.outlineObserver = undefined;
		document.querySelector("#outline")?.remove();

		if (this.metadata.featureOptions.outline?.enabled === false || page.documentType !== DocumentType.Markdown) return;
		const headers = page.info.headers ?? [];
		if (headers.length === 0) return;

		const outline = document.createElement("div");
		outline.id = "outline";
		outline.classList.add("tree-container", "outline-tree");
		const featureHeader = document.createElement("div");
		featureHeader.classList.add("feature-header");
		const featureTitle = document.createElement("div");
		featureTitle.classList.add("feature-title");
		featureTitle.textContent = "Table of contents";
		featureHeader.appendChild(featureTitle);
		const collapseAll = document.createElement("button");
		collapseAll.type = "button";
		collapseAll.classList.add("clickable-icon", "nav-action-button", "tree-collapse-all");
		collapseAll.setAttribute("aria-label", "Collapse or expand table of contents");
		collapseAll.innerHTML = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'></svg>";
		featureHeader.appendChild(collapseAll);
		outline.appendChild(featureHeader);

		const documentTitle = document.createElement("div");
		documentTitle.classList.add("tree-item", "outline-document-title");
		documentTitle.dataset.depth = "1";
		const documentTitleSelf = document.createElement("div");
		documentTitleSelf.classList.add("tree-item-self");
		const documentTitleInner = document.createElement("div");
		documentTitleInner.classList.add("tree-item-inner");
		documentTitleInner.textContent = page.info.browserTitle ?? page.title;
		documentTitleSelf.appendChild(documentTitleInner);
		documentTitle.append(documentTitleSelf, Object.assign(document.createElement("div"), { className: "tree-item-children" }));
		outline.appendChild(documentTitle);

		type OutlineEntry = { heading: string; id: string; level: number; children: OutlineEntry[] };
		const root: OutlineEntry = { heading: "", id: "", level: 0, children: [] };
		const stack: OutlineEntry[] = [root];
		for (const header of headers) {
			while (stack.length > 1 && stack[stack.length - 1].level >= header.level) stack.pop();
			const entry: OutlineEntry = { ...header, children: [] };
			stack[stack.length - 1].children.push(entry);
			stack.push(entry);
		}

		const createItem = (entry: OutlineEntry, depth: number): HTMLElement => {
			const item = document.createElement("div");
			item.classList.add("tree-item");
			item.dataset.depth = String(depth);
			if (entry.children.length > 0) {
				item.classList.add("mod-collapsible");
				if (this.metadata.featureOptions.outline.startCollapsed === true) item.classList.add("is-collapsed");
			}
			const self = document.createElement("a");
			self.classList.add("tree-item-self", "is-clickable");
			self.href = `#${entry.id}`;
			self.dataset.path = `#${entry.id}`;
			if (entry.children.length > 0) {
				const icon = document.createElement("div");
				icon.classList.add("tree-item-icon", "collapse-icon");
				icon.setAttribute("aria-expanded", String(this.metadata.featureOptions.outline.startCollapsed !== true));
				icon.innerHTML = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' class='svg-icon right-triangle'><path d='M3 8L12 17L21 8'></path></svg>";
				self.appendChild(icon);
			}
			const label = document.createElement("div");
			label.classList.add("tree-item-inner", "heading-link");
			label.textContent = entry.heading;
			self.appendChild(label);
			item.appendChild(self);
			const children = document.createElement("div");
			children.classList.add("tree-item-children");
			for (const child of entry.children) children.appendChild(createItem(child, depth + 1));
			item.appendChild(children);
			return item;
		};
		for (const entry of root.children) outline.appendChild(createItem(entry, 1));

		(document.querySelector("#right-sidebar-content") as HTMLElement | null)?.appendChild(outline);
		this.outlineTree = new Tree(outline, this.metadata.featureOptions.outline.minCollapseDepth);
		this.outlineTree.forAllChildren((item) => {
			item.selfEl.addEventListener("click", () => item.setActive());
		});

		this.outlineObserver = new IntersectionObserver((entries) => {
			const active = entries.filter((entry) => entry.isIntersecting)
				.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
			if (active?.target instanceof HTMLElement) this.outlineTree?.findByPath(`#${active.target.id}`)?.setActive();
		}, { root: this.centerContentEl, rootMargin: "-15% 0px -70% 0px" });
		for (const header of headers) {
			const heading = page.documentEl?.querySelector(`#${CSS.escape(header.id)}`);
			if (heading) this.outlineObserver.observe(heading);
		}
	}

	public async fetch(url: string): Promise<Response | undefined> {
		url = LinkHandler.getPathnameFromURL(url);

		if (this.isHttp || url.startsWith("http")) {
			const req = await fetch(url);
			if (req.ok) {
				return req;
			} else {
				console.error("Failed to fetch", url);
				return;
			}
		} else {
			const file = this.getFileData(url);
			if (!file?.data) {
				console.error("Failed to fetch", url);
				return;
			}

			const req = new Response(file.data, { status: 200 });
			return req;
		}
	}

	public documentExists(url: string): boolean {
		url = LinkHandler.getPathnameFromURL(url);
		if (this.isHttp) {
			if (this.metadata?.serverMetadata) return true;
			return !!this.resolveWebpagePath(url);
		} else {
			return !!this.getFileData(url)?.data;
		}
	}

	private resolveWebpagePath(url: string): string | undefined {
		const cleanURL = LinkHandler.getPathnameFromURL(url).replace(/^\/+/, "");
		if (this.metadata?.serverMetadata) return cleanURL || "index.html";
		if (!cleanURL) return this.metadata?.webpages["index.html"] ? "index.html" : undefined;
		if (this.metadata?.webpages[cleanURL]) return cleanURL;

		const withoutHTML = cleanURL.replace(/\.html$/i, "");
		const metadataValue = this.normalizeMetadataValue(withoutHTML);
		return this.metadata?.metadataValueToTarget?.[metadataValue];
	}

	private normalizeMetadataValue(value: string): string {
		return value.toLowerCase().replace(/[^a-z0-9]/g, "");
	}

	private async loadWebsiteData(): Promise<WebsiteData | undefined> {
		if (this.isHttp) {
			try {
				const dataReq = await fetch(
					Shared.libFolderName + "/metadata.json"
				);
				if (dataReq.ok) {
				const jsonStr = await dataReq.text();
				const data = WebsiteData.fromJSON(jsonStr);
				if (data.serverMetadata) {
					const bootstrapReq = await fetch("/api/app/bootstrap");
						if (!bootstrapReq.ok) throw new Error("Failed to load server metadata bootstrap.");
						return WebsiteData.fromJSON(JSON.stringify(await bootstrapReq.json()));
					}
					if (data.metadataShards)
					{
						const webpageBucketPaths = data.metadataShards.webpageBuckets;
						const [webpagesReq, fileInfoReq] = await Promise.all([
							webpageBucketPaths
								? Promise.all(webpageBucketPaths.map((path) => fetch(`${Shared.libFolderName}/${path}`)))
								: fetch(`${Shared.libFolderName}/${data.metadataShards.webpages ?? Shared.metadataPagesFileName}`),
							fetch(`${Shared.libFolderName}/${data.metadataShards.fileInfo}`),
						]);
						const webpageResponses = Array.isArray(webpagesReq) ? webpagesReq : [webpagesReq];
						if (webpageResponses.some((response) => !response.ok) || !fileInfoReq.ok)
						{
							throw new Error("Failed to load website metadata shards.");
						}
						data.webpages = Object.assign({}, ...(await Promise.all(webpageResponses.map((response) => response.json()))));
						data.fileInfo = await fileInfoReq.json();
					}
					return data;
				}
			} catch (e) {
				console.error("Failed to load website metadata.", e);
				new Notice("Failed to load website metadata.");
			}
		} else {
			const jsonData = this.getLocalDataFromId("website-metadata");
			return jsonData
				? WebsiteData.fromJSON(JSON.stringify(jsonData))
				: undefined;
		}
		return undefined;
	}

	private async loadGraphView() {
		const graphViewFeature = document.querySelector(
			".graph-view-wrapper"
		) as HTMLElement;
		if (!graphViewFeature) return;

		const localThis = this;
		//@ts-ignore
		waitLoadScripts(["graph-render-worker", "graph-wasm"], () => {
			console.log("scripts loaded");
			async function initGraphView() {
				console.log("Initializing graph view");
				const graphView = new GraphView(graphViewFeature);
				localThis.graphView = graphView;
				console.log("Graph view initialized");
			}

			//@ts-ignore
			Module["onRuntimeInitialized"] = () => {
				console.log("Wasm loaded");
				initGraphView();
			};

			//@ts-ignore
			run();

			setTimeout(() => {
				if (localThis.graphView == undefined) {
					initGraphView();
				}
			}, 100);
		});

		await waitUntil(() => this.graphView != undefined);
	}

	public getLocalDataFromId(id: string): any | undefined {
		const el = document.getElementById(id);
		if (!el) return;
		return JSON.parse(decodeURI(atob(el.getAttribute("value") ?? "")));
	}

	private cachedWebpageDataMap: Map<string, WebpageData> = new Map();
	public async getWebpageDataAsync(url: string): Promise<WebpageData | undefined> {
		const cached = this.getWebpageData(url);
		if (cached || !this.isHttp || !this.metadata?.serverMetadata) return cached;
		try {
			const pathname = LinkHandler.getPathnameFromURL(url).replace(/^\/+/, "");
			const response = await fetch(`/api/metadata/document?path=${encodeURIComponent(pathname)}`);
			if (!response.ok) return undefined;
			const data = await response.json() as WebpageData;
			this.cachedWebpageDataMap.set(pathname, data);
			return data;
		} catch (error) {
			console.error("Failed to load webpage metadata", error);
			return undefined;
		}
	}

	public getWebpageData(url: string): WebpageData | undefined {
		if (!this.isHttp) {
			if (this.cachedWebpageDataMap.has(url)) {
				return this.cachedWebpageDataMap.get(url) as WebpageData;
			} else {
				const data = this.getLocalDataFromId(
					LinkHandler.getFileDataIdFromURL(url)
				) as WebpageData;
				this.cachedWebpageDataMap.set(url, data);
				return data;
			}
		}

		if (this.metadata) {
			const cached = this.cachedWebpageDataMap.get(url);
			if (cached) return cached;
			const data = this.metadata.webpages[url];
			if (data) {
				return data;
			}
		}

		return;
	}

	private cachedFileDataMap: Map<string, FileData> = new Map();
	public getFileData(url: string): FileData {
		if (!this.isHttp) {
			if (this.cachedFileDataMap.has(url)) {
				return this.cachedFileDataMap.get(url) as FileData;
			} else {
				const data = this.getLocalDataFromId(
					LinkHandler.getFileDataIdFromURL(url)
				) as FileData;
				this.cachedFileDataMap.set(url, data);
				return data;
			}
		}

		if (this.metadata) {
			const data = this.metadata.fileInfo[url];
			if (data) {
				return data;
			}
		}

		return {} as FileData;
	}

	public scrollTo(element: Element) {
		element.scrollIntoView();
	}

	public async showLoading(
		loading: boolean,
		inside: HTMLElement = this.centerContentEl
	) {
		inside.style.transitionDuration = "";
		inside.classList.toggle("hide", loading);
		this.loadingEl.classList.toggle("show", loading);
		// this.graphView?.graphRenderer?.canvas.classList.toggle("hide", loading);

		if (loading) {
			// position loading icon in the center of the screen
			const viewBounds = Bounds.fromElement(inside);
			this.loadingEl.style.left =
				viewBounds.center.x - this.loadingEl.offsetWidth / 2 + "px";
			this.loadingEl.style.top =
				viewBounds.center.y - this.loadingEl.offsetHeight / 2 + "px";
		}

		await delay(200);
	}

	private createLoadingEl() {
		this.loadingEl = document.createElement("div");
		this.loadingEl.classList.add("loading-icon");
		document.body.appendChild(this.loadingEl);
		this.loadingEl.innerHTML = `<div></div><div></div><div></div><div></div>`;
	}

	public get documentBounds(): Bounds {
		return Bounds.fromElement(this.centerContentEl);
	}

	private onEndResize() {
		this.graphView?.graphRenderer?.autoResizeCanvas();
		document.body.classList.toggle("resizing", false);
	}

	private onStartResize() {
		document.body.classList.toggle("resizing", true);
	}

	private lastScreenWidth: number | undefined = undefined;
	private isResizing = false;
	private checkStillResizingTimeout: NodeJS.Timeout | undefined = undefined;
	private _deviceSize: string = "large-screen";
	public get deviceSize(): string {
		return this._deviceSize;
	}
	private set deviceSize(size: string) {
		this._deviceSize = size;
	}
	
	private onResize() {
		if (!this.isResizing) {
			this.onStartResize();
			this.isResizing = true;
		}

		const localThis = this;

		function widthNowInRange(low: number, high: number) {
			const w = window.innerWidth;
			return (
				(w > low &&
					w < high &&
					localThis.lastScreenWidth == undefined) ||
				(w > low &&
					w < high &&
					((localThis.lastScreenWidth ?? 0) <= low ||
						(localThis.lastScreenWidth ?? 0) >= high))
			);
		}

		function widthNowGreaterThan(value: number) {
			const w = window.innerWidth;
			return (
				(w > value && localThis.lastScreenWidth == undefined) ||
				(w > value && (localThis.lastScreenWidth ?? 0) < value)
			);
		}

		function widthNowLessThan(value: number) {
			const w = window.innerWidth;
			return (
				(w < value && localThis.lastScreenWidth == undefined) ||
				(w < value && (localThis.lastScreenWidth ?? 0) > value)
			);
		}

		const docWidthCSS =
			this.metadata.featureOptions.document?.documentWidth ?? "45em";
		const leftWdithCSS =
			this.metadata.featureOptions.sidebar?.leftDefaultWidth ?? "20em";
		const rightWidthCSS =
			this.metadata.featureOptions.sidebar?.rightDefaultWidth ?? "20em";

		// calculate the css widths
		const docWidth = getLengthInPixels(docWidthCSS, this.centerContentEl);
		const leftWidth = this.leftSidebar
			? getLengthInPixels(leftWdithCSS, this.leftSidebar?.containerEl)
			: 0;
		const rightWidth = this.rightSidebar
			? getLengthInPixels(rightWidthCSS, this.rightSidebar?.containerEl)
			: 0;

		if (
			widthNowGreaterThan(docWidth + leftWidth + rightWidth) ||
			widthNowGreaterThan(1025)
		) {
			this.deviceSize = "large-screen";
			document.body.classList.toggle("floating-sidebars", false);
			document.body.classList.toggle("is-large-screen", true);
			document.body.classList.toggle("is-small-screen", false);
			document.body.classList.toggle("is-tablet", false);
			document.body.classList.toggle("is-phone", false);

			if (this.leftSidebar) this.leftSidebar.collapsed = false;
			if (this.rightSidebar) this.rightSidebar.collapsed = false;
		} else if (
			widthNowInRange(
				docWidth + leftWidth,
				docWidth + leftWidth + rightWidth
			) ||
			widthNowInRange(769, 1024)
		) {
			this.deviceSize = "small screen";
			document.body.classList.toggle("floating-sidebars", false);
			document.body.classList.toggle("is-large-screen", false);
			document.body.classList.toggle("is-small-screen", true);
			document.body.classList.toggle("is-tablet", false);
			document.body.classList.toggle("is-phone", false);

			if (
				this.leftSidebar &&
				this.rightSidebar &&
				!this.leftSidebar.collapsed
			) {
				this.rightSidebar.collapsed = true;
			}
		} else if (
			widthNowInRange(leftWidth + rightWidth, docWidth + leftWidth) ||
			widthNowInRange(481, 768)
		) {
			this.deviceSize = "tablet";
			document.body.classList.toggle("floating-sidebars", true);
			document.body.classList.toggle("is-large-screen", false);
			document.body.classList.toggle("is-small-screen", false);
			document.body.classList.toggle("is-tablet", true);
			document.body.classList.toggle("is-phone", false);

			if (
				this.leftSidebar &&
				this.rightSidebar &&
				!this.leftSidebar.collapsed
			) {
				this.rightSidebar.collapsed = true;
			}
		} else if (
			widthNowLessThan(leftWidth + rightWidth) ||
			widthNowLessThan(480)
		) {
			this.deviceSize = "phone";
			document.body.classList.toggle("floating-sidebars", true);
			document.body.classList.toggle("is-large-screen", false);
			document.body.classList.toggle("is-small-screen", false);
			document.body.classList.toggle("is-tablet", false);
			document.body.classList.toggle("is-phone", true);
			if (this.leftSidebar) this.leftSidebar.collapsed = true;
			if (this.rightSidebar) this.rightSidebar.collapsed = true;
		}

		this.lastScreenWidth = window.innerWidth;

		if (this.checkStillResizingTimeout != undefined)
			clearTimeout(this.checkStillResizingTimeout);

		// wait a little bit of time and if the width is still the same then we are done resizing
		const screenWidthSnapshot = window.innerWidth;
		this.checkStillResizingTimeout = setTimeout(function () {
			if (window.innerWidth == screenWidthSnapshot) {
				localThis.checkStillResizingTimeout = undefined;
				localThis.isResizing = false;
				localThis.onEndResize();
			}
		}, 200);
	}
}
