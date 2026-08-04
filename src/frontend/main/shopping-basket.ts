import { Notice } from "./notifications";
import { LinkHandler } from "./links";
import { BasketSearchItem, BasketSearchSnapshot, Search, SearchType } from "./search";

interface BasketBatchBase {
	id: string;
	query: string;
	timestamp: number;
}

interface BasketQueryBatch extends BasketBatchBase {
	kind: "query";
	searchQuery: string;
	type: SearchType;
	total: number;
	excludedSourcePaths: string[];
}

interface BasketItemsBatch extends BasketBatchBase {
	kind: "items";
	items: BasketSearchItem[];
}

type BasketBatch = BasketQueryBatch | BasketItemsBatch;

interface BasketState {
	version: 2;
	batches: BasketBatch[];
	openBatchIds?: string[];
}

interface QueryPageState {
	items: BasketSearchItem[];
	nextOffset: number;
	total: number;
	loading: boolean;
}

export class ShoppingBasket {
	private static readonly storageKey = "shopping-basket-state-v2";
	private static readonly currentDocumentsBatchId = "current-documents";
	private static readonly pageSize = 100;

	private readonly search: Search;
	private readonly endpoint: string;
	private readonly summaryEndpoint: string;
	private readonly rootEl: HTMLElement;
	private readonly addButtonEl: HTMLButtonElement;
	private readonly addDocumentButtonEl: HTMLButtonElement;
	private readonly summaryEl: HTMLElement;
	private readonly drawerEl: HTMLElement;
	private readonly batchListEl: HTMLElement;
	private readonly checkoutButtonEl: HTMLButtonElement;
	private readonly clearButtonEl: HTMLButtonElement;
	private readonly queryPages = new Map<string, QueryPageState>();
	private state: BasketState;
	private openBatchIds = new Set<string>();
	private uniqueItemCount = 0;
	private summaryRequestId = 0;

	constructor(search: Search) {
		this.search = search;
		this.endpoint = ObsidianSite.metadata.featureOptions.shoppingBasket.checkoutEndpoint ?? "/api/checkout";
		this.summaryEndpoint = `${this.endpoint.replace(/\/$/, "")}/summary`;
		this.state = this.loadState();
		this.openBatchIds = new Set(this.state.openBatchIds ?? []);

		this.rootEl = document.createElement("div");
		this.rootEl.id = "shopping-basket";
		this.rootEl.classList.add("shopping-basket");

		const toolbarEl = document.createElement("div");
		toolbarEl.classList.add("shopping-basket-toolbar");
		this.rootEl.appendChild(toolbarEl);

		this.addButtonEl = document.createElement("button");
		this.addButtonEl.type = "button";
		this.addButtonEl.classList.add("shopping-basket-add");
		this.addButtonEl.setAttribute("aria-label", "Add current search to basket");
		this.addButtonEl.setAttribute("title", "Add current search to basket");
		this.addButtonEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="M5 7h14l-1.5 13h-11L5 7Z"></path><path d="M8 7a4 4 0 0 1 8 0"></path><path d="M12 11v6"></path><path d="M9 14h6"></path></svg><span>Add search</span>';
		this.addButtonEl.addEventListener("click", () => void this.addCurrentSearch());
		toolbarEl.appendChild(this.addButtonEl);

		this.addDocumentButtonEl = document.createElement("button");
		this.addDocumentButtonEl.type = "button";
		this.addDocumentButtonEl.classList.add("shopping-basket-add", "shopping-basket-add-document");
		this.addDocumentButtonEl.setAttribute("aria-label", "Add current document to basket");
		this.addDocumentButtonEl.setAttribute("title", "Add current document to basket");
		this.addDocumentButtonEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path><path d="M12 11v6"></path><path d="M9 14h6"></path></svg><span>Add current</span>';
		this.addDocumentButtonEl.addEventListener("click", () => this.addCurrentDocument());
		toolbarEl.appendChild(this.addDocumentButtonEl);

		this.drawerEl = document.createElement("div");
		this.drawerEl.classList.add("shopping-basket-drawer");
		this.rootEl.appendChild(this.drawerEl);

		this.summaryEl = document.createElement("div");
		this.summaryEl.classList.add("shopping-basket-summary");
		this.drawerEl.appendChild(this.summaryEl);

		this.batchListEl = document.createElement("div");
		this.batchListEl.classList.add("shopping-basket-batches");
		this.drawerEl.appendChild(this.batchListEl);

		const actionsEl = document.createElement("div");
		actionsEl.classList.add("shopping-basket-actions");
		this.drawerEl.appendChild(actionsEl);

		this.checkoutButtonEl = document.createElement("button");
		this.checkoutButtonEl.type = "button";
		this.checkoutButtonEl.classList.add("mod-cta", "shopping-basket-checkout");
		this.checkoutButtonEl.innerText = "Checkout";
		this.checkoutButtonEl.addEventListener("click", () => void this.checkout());
		actionsEl.appendChild(this.checkoutButtonEl);

		this.clearButtonEl = document.createElement("button");
		this.clearButtonEl.type = "button";
		this.clearButtonEl.classList.add("shopping-basket-clear");
		this.clearButtonEl.innerText = "Clear";
		this.clearButtonEl.addEventListener("click", () => this.clear());
		actionsEl.appendChild(this.clearButtonEl);

		const leftSidebarContentEl = document.querySelector("#left-sidebar-content");
		const searchContainer = this.search.getContainer();
		if (leftSidebarContentEl) leftSidebarContentEl.append(this.rootEl);
		else searchContainer?.after(this.rootEl);
		this.render();
	}

	private async addCurrentSearch(): Promise<void> {
		const query = this.search.getCurrentQuery();
		if (!query) {
			new Notice("Run a search first.");
			return;
		}

		this.addButtonEl.disabled = true;
		try {
			const snapshot = await this.search.getMatchesForQuery(query);
			if (snapshot.total === 0) {
				new Notice("No Markdown documents matched this search.");
				return;
			}
			this.addSnapshot(snapshot);
			new Notice(`Added ${snapshot.total.toLocaleString()} matching documents to the basket.`);
		} catch (error) {
			console.error("Failed to add search to basket:", error);
			new Notice("The search server is not available.");
		} finally {
			this.addButtonEl.disabled = false;
		}
	}

	private addSnapshot(snapshot: BasketSearchSnapshot): void {
		this.state.batches.push({
			id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
			kind: "query",
			query: snapshot.query,
			searchQuery: snapshot.searchQuery,
			type: snapshot.type,
			total: snapshot.total,
			excludedSourcePaths: [],
			timestamp: Date.now(),
		});
		this.saveState();
		this.render({ resetOpenBatches: true });
	}

	private addCurrentDocument(): void {
		const document = ObsidianSite.document;
		const info = document?.info;
		if (!info?.sourcePath || !info.exportPath) {
			new Notice("The current document cannot be added to the basket.");
			return;
		}
		const item = { exportPath: info.exportPath, sourcePath: info.sourcePath, title: document.title };
		let batch = this.state.batches.find((candidate): candidate is BasketItemsBatch =>
			candidate.id === ShoppingBasket.currentDocumentsBatchId && candidate.kind === "items"
		);
		if (!batch) {
			batch = { id: ShoppingBasket.currentDocumentsBatchId, kind: "items", query: "Selected documents", timestamp: Date.now(), items: [] };
			this.state.batches.push(batch);
		}
		if (!batch.items.some((candidate) => candidate.sourcePath === item.sourcePath)) batch.items.push(item);
		batch.timestamp = Date.now();
		this.saveState();
		this.render();
		new Notice(`Added ${this.getItemDisplayName(item)} to the basket.`);
	}

	private getItemDisplayName(item: BasketSearchItem): string {
		if (ObsidianSite.metadata.featureOptions.fileNavigation.showDocumentTitles === true) return item.title;
		const filename = item.sourcePath.replaceAll("\\", "/").split("/").pop() ?? "";
		return filename.replace(/\.[^/.]+$/, "") || item.title;
	}

	private getExplicitItems(): BasketSearchItem[] {
		const deduped = new Map<string, BasketSearchItem>();
		for (const batch of this.state.batches) {
			if (batch.kind !== "items") continue;
			for (const item of batch.items) if (item.sourcePath && !deduped.has(item.sourcePath)) deduped.set(item.sourcePath, item);
		}
		return Array.from(deduped.values());
	}

	private getQueryBatches(): BasketQueryBatch[] {
		return this.state.batches.filter((batch): batch is BasketQueryBatch => batch.kind === "query");
	}

	private async checkout(): Promise<void> {
		if (this.uniqueItemCount === 0) {
			new Notice("The basket is empty.");
			return;
		}
		this.checkoutButtonEl.disabled = true;
		this.checkoutButtonEl.innerText = "Preparing...";
		try {
			const response = await fetch(this.endpoint, {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ items: this.getExplicitItems(), batches: this.getQueryBatches() }),
			});
			if (response.status === 401 || response.status === 403) {
				new Notice("Checkout is not authorized for this account.");
				return;
			}
			if (!response.ok) {
				new Notice((await response.text()) || "Checkout failed.");
				return;
			}
			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = this.getDownloadFilename(response);
			document.body.appendChild(link);
			link.click();
			link.remove();
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error("Checkout failed", error);
			new Notice("Checkout failed. The basket server may be unavailable.");
		} finally {
			this.checkoutButtonEl.disabled = false;
			this.checkoutButtonEl.innerText = "Checkout";
		}
	}

	private getDownloadFilename(response: Response): string {
		const match = (response.headers.get("Content-Disposition") ?? "").match(/filename="?([^"]+)"?/i);
		return match?.[1] ?? "vault-subset.zip";
	}

	private removeBatch(id: string): void {
		this.state.batches = this.state.batches.filter((batch) => batch.id !== id);
		this.openBatchIds.delete(id);
		this.queryPages.delete(id);
		this.saveState();
		this.render();
	}

	private removeItem(batchId: string, sourcePath: string): void {
		const batch = this.state.batches.find((candidate) => candidate.id === batchId);
		if (!batch) return;
		if (batch.kind === "query") {
			if (!batch.excludedSourcePaths.includes(sourcePath)) batch.excludedSourcePaths.push(sourcePath);
		} else {
			batch.items = batch.items.filter((item) => item.sourcePath !== sourcePath);
			if (batch.items.length === 0) this.state.batches = this.state.batches.filter((candidate) => candidate.id !== batch.id);
		}
		this.saveState();
		this.render();
	}

	private clear(): void {
		this.state = { version: 2, batches: [] };
		this.openBatchIds.clear();
		this.queryPages.clear();
		this.saveState();
		this.render();
	}

	private render(options: { resetOpenBatches?: boolean } = {}): void {
		if (options.resetOpenBatches) this.openBatchIds.clear();
		this.saveOpenBatchState();
		this.renderBatches();
		this.clearButtonEl.disabled = this.state.batches.length === 0;
		this.summaryEl.innerText = this.state.batches.length === 0 ? "No searches added yet." : "Calculating unique documents...";
		this.checkoutButtonEl.disabled = this.state.batches.length === 0;
		void this.refreshSummary();
	}

	private async refreshSummary(): Promise<void> {
		const requestId = ++this.summaryRequestId;
		if (this.state.batches.length === 0) {
			this.uniqueItemCount = 0;
			return;
		}
		try {
			const response = await fetch(this.summaryEndpoint, {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ items: this.getExplicitItems(), batches: this.getQueryBatches() }),
			});
			if (!response.ok) throw new Error(`Summary server returned ${response.status}.`);
			const data = await response.json();
			if (requestId !== this.summaryRequestId) return;
			this.uniqueItemCount = Number(data.count ?? 0);
			const batchCount = this.state.batches.length;
			this.summaryEl.innerText = `${this.uniqueItemCount.toLocaleString()} unique documents from ${batchCount} search${batchCount === 1 ? "" : "es"}.`;
			this.checkoutButtonEl.disabled = this.uniqueItemCount === 0;
		} catch (error) {
			console.error("Failed to calculate basket summary", error);
			if (requestId === this.summaryRequestId) this.summaryEl.innerText = "Unable to calculate basket size.";
		}
	}

	private renderBatches(): void {
		this.batchListEl.replaceChildren();
		for (const batch of this.state.batches) {
			const batchEl = document.createElement("details");
			batchEl.classList.add("shopping-basket-batch");
			batchEl.open = this.openBatchIds.has(batch.id);
			const count = batch.kind === "query" ? Math.max(0, batch.total - batch.excludedSourcePaths.length) : batch.items.length;
			const summaryEl = document.createElement("summary");
			summaryEl.classList.add("shopping-basket-batch-summary");
			summaryEl.innerText = `${batch.query} (${count.toLocaleString()})`;
			batchEl.appendChild(summaryEl);

			const contentEl = document.createElement("div");
			contentEl.classList.add("shopping-basket-batch-content");
			batchEl.appendChild(contentEl);
			batchEl.addEventListener("toggle", () => {
				if (batchEl.open) {
					this.openBatchIds.add(batch.id);
					if (contentEl.childElementCount === 0) void this.renderBatchContent(batch, contentEl);
				} else this.openBatchIds.delete(batch.id);
				this.saveOpenBatchState(true);
			});
			if (batchEl.open) void this.renderBatchContent(batch, contentEl);
			this.batchListEl.appendChild(batchEl);
		}
	}

	private async renderBatchContent(batch: BasketBatch, contentEl: HTMLElement): Promise<void> {
		contentEl.replaceChildren();
		const removeBatchButtonEl = document.createElement("button");
		removeBatchButtonEl.type = "button";
		removeBatchButtonEl.classList.add("shopping-basket-remove-batch");
		removeBatchButtonEl.innerText = "Remove search";
		removeBatchButtonEl.addEventListener("click", () => this.removeBatch(batch.id));
		contentEl.appendChild(removeBatchButtonEl);

		const listEl = document.createElement("div");
		listEl.classList.add("shopping-basket-items");
		contentEl.appendChild(listEl);
		if (batch.kind === "items") {
			this.appendItems(batch, batch.items, listEl);
			return;
		}

		let page = this.queryPages.get(batch.id);
		if (!page) {
			page = { items: [], nextOffset: 0, total: batch.total, loading: false };
			this.queryPages.set(batch.id, page);
		}
		if (page.items.length === 0) await this.loadNextQueryPage(batch, page);
		this.appendItems(batch, page.items.filter((item) => !batch.excludedSourcePaths.includes(item.sourcePath)), listEl);
		if (page.nextOffset < page.total) {
			const moreEl = document.createElement("button");
			moreEl.type = "button";
			moreEl.classList.add("shopping-basket-load-more");
			moreEl.innerText = `Load more (${Math.min(ShoppingBasket.pageSize, page.total - page.nextOffset).toLocaleString()})`;
			moreEl.addEventListener("click", async () => {
				moreEl.disabled = true;
				await this.loadNextQueryPage(batch, page!);
				await this.renderBatchContent(batch, contentEl);
			});
			contentEl.appendChild(moreEl);
		}
		LinkHandler.initializeLinks(contentEl);
	}

	private async loadNextQueryPage(batch: BasketQueryBatch, page: QueryPageState): Promise<void> {
		if (page.loading || page.nextOffset >= page.total) return;
		page.loading = true;
		try {
			const result = await this.search.getSearchPage({
				query: batch.query,
				searchQuery: batch.searchQuery,
				type: batch.type,
				total: batch.total,
			}, page.nextOffset, ShoppingBasket.pageSize);
			page.items.push(...result.items);
			page.nextOffset += result.items.length;
			page.total = result.total;
			batch.total = result.total;
			this.saveState();
		} finally {
			page.loading = false;
		}
	}

	private appendItems(batch: BasketBatch, items: BasketSearchItem[], listEl: HTMLElement): void {
		for (const item of items) {
			const displayName = this.getItemDisplayName(item);
			const itemEl = document.createElement("div");
			itemEl.classList.add("shopping-basket-item");
			const titleEl = document.createElement("a");
			titleEl.classList.add("shopping-basket-item-title");
			titleEl.innerText = displayName;
			titleEl.title = item.sourcePath;
			titleEl.href = this.getItemLink(item, batch.query);
			itemEl.appendChild(titleEl);
			const removeItemButtonEl = document.createElement("button");
			removeItemButtonEl.type = "button";
			removeItemButtonEl.classList.add("shopping-basket-remove-item");
			removeItemButtonEl.setAttribute("aria-label", `Remove ${displayName}`);
			removeItemButtonEl.innerText = "x";
			removeItemButtonEl.addEventListener("click", () => this.removeItem(batch.id, item.sourcePath));
			itemEl.appendChild(removeItemButtonEl);
			listEl.appendChild(itemEl);
		}
	}

	private getItemLink(item: BasketSearchItem, query: string): string {
		return query ? `${item.exportPath}?mark=${encodeURIComponent(query)}` : item.exportPath;
	}

	private loadState(): BasketState {
		try {
			const parsed = JSON.parse(localStorage.getItem(ShoppingBasket.storageKey) ?? "null") as BasketState | null;
			if (parsed?.version !== 2 || !Array.isArray(parsed.batches)) return { version: 2, batches: [] };
			return parsed;
		} catch (error) {
			console.warn("Failed to load shopping basket state", error);
			return { version: 2, batches: [] };
		}
	}

	private saveState(): void {
		this.saveOpenBatchState();
		localStorage.setItem(ShoppingBasket.storageKey, JSON.stringify(this.state));
	}

	private saveOpenBatchState(persist: boolean = false): void {
		this.state.openBatchIds = Array.from(this.openBatchIds).filter((id) => this.state.batches.some((batch) => batch.id === id));
		if (persist) localStorage.setItem(ShoppingBasket.storageKey, JSON.stringify(this.state));
	}
}
