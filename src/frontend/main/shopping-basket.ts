import { Notice } from "./notifications";
import { LinkHandler } from "./links";
import { BasketSearchItem, BasketSearchSnapshot, Search } from "./search";

interface BasketBatch {
	id: string;
	query: string;
	timestamp: number;
	items: BasketSearchItem[];
}

interface BasketState {
	batches: BasketBatch[];
	openBatchIds?: string[];
}

interface CheckoutItem {
	exportPath: string;
	sourcePath: string;
	title: string;
}

export class ShoppingBasket {
	private static readonly storageKey = "shopping-basket-state";
	private static readonly currentDocumentsBatchId = "current-documents";

	private readonly search: Search;
	private readonly endpoint: string;
	private readonly rootEl: HTMLElement;
	private readonly addButtonEl: HTMLButtonElement;
	private readonly addDocumentButtonEl: HTMLButtonElement;
	private readonly summaryEl: HTMLElement;
	private readonly drawerEl: HTMLElement;
	private readonly batchListEl: HTMLElement;
	private readonly checkoutButtonEl: HTMLButtonElement;
	private readonly clearButtonEl: HTMLButtonElement;
	private state: BasketState;
	private openBatchIds = new Set<string>();

	constructor(search: Search) {
		this.search = search;
		this.endpoint =
			ObsidianSite.metadata.featureOptions.shoppingBasket.checkoutEndpoint ??
			"/api/checkout";
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
		this.addButtonEl.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="M5 7h14l-1.5 13h-11L5 7Z"></path><path d="M8 7a4 4 0 0 1 8 0"></path><path d="M12 11v6"></path><path d="M9 14h6"></path></svg><span>Add search</span>';
		this.addButtonEl.addEventListener("click", () => this.addCurrentSearch());
		toolbarEl.appendChild(this.addButtonEl);

		this.addDocumentButtonEl = document.createElement("button");
		this.addDocumentButtonEl.type = "button";
		this.addDocumentButtonEl.classList.add("shopping-basket-add", "shopping-basket-add-document");
		this.addDocumentButtonEl.setAttribute("aria-label", "Add current document to basket");
		this.addDocumentButtonEl.setAttribute("title", "Add current document to basket");
		this.addDocumentButtonEl.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path><path d="M12 11v6"></path><path d="M9 14h6"></path></svg><span>Add current</span>';
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
		this.checkoutButtonEl.addEventListener("click", () => this.checkout());
		actionsEl.appendChild(this.checkoutButtonEl);

		this.clearButtonEl = document.createElement("button");
		this.clearButtonEl.type = "button";
		this.clearButtonEl.classList.add("shopping-basket-clear");
		this.clearButtonEl.innerText = "Clear";
		this.clearButtonEl.addEventListener("click", () => this.clear());
		actionsEl.appendChild(this.clearButtonEl);

		const leftSidebarContentEl = document.querySelector("#left-sidebar-content");
		const searchContainer = this.search.getContainer();
		if (leftSidebarContentEl) {
			leftSidebarContentEl.append(this.rootEl);
		} else {
			searchContainer?.after(this.rootEl);
		}
		this.render();
	}

	private addCurrentSearch(): void {
		const query = this.search.getCurrentQuery();
		if (!query) {
			new Notice("Run a search first.");
			return;
		}

		const snapshot = this.search.getMatchesForQuery(query);
		if (snapshot.items.length === 0) {
			new Notice("No Markdown documents matched this search.");
			return;
		}

		this.addSnapshot(snapshot);
		new Notice(`Added ${snapshot.items.length} matching documents to the basket.`);
	}

	private addSnapshot(snapshot: BasketSearchSnapshot): void {
		this.state.batches.push({
			id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
			query: snapshot.query,
			timestamp: Date.now(),
			items: snapshot.items,
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

		const item = {
			exportPath: info.exportPath,
			sourcePath: info.sourcePath,
			title: document.title,
		};
		let batch = this.state.batches.find((candidate) => candidate.id === ShoppingBasket.currentDocumentsBatchId);
		if (!batch) {
			batch = {
				id: ShoppingBasket.currentDocumentsBatchId,
				query: "Selected documents",
				timestamp: Date.now(),
				items: [],
			};
			this.state.batches.push(batch);
		}
		if (!batch.items.some((candidate) => candidate.sourcePath === item.sourcePath)) {
			batch.items.push(item);
			batch.timestamp = Date.now();
		}
		this.saveState();
		this.render();
		new Notice(`Added ${document.title} to the basket.`);
	}

	private getCheckoutItems(): CheckoutItem[] {
		const deduped = new Map<string, CheckoutItem>();
		for (const batch of this.state.batches) {
			for (const item of batch.items) {
				if (!item.sourcePath || deduped.has(item.sourcePath)) continue;
				deduped.set(item.sourcePath, item);
			}
		}
		return Array.from(deduped.values());
	}

	private async checkout(): Promise<void> {
		const items = this.getCheckoutItems();
		if (items.length === 0) {
			new Notice("The basket is empty.");
			return;
		}

		this.checkoutButtonEl.disabled = true;
		this.checkoutButtonEl.innerText = "Preparing...";

		try {
			const response = await fetch(this.endpoint, {
				method: "POST",
				credentials: "same-origin",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ items, batches: this.state.batches }),
			});

			if (response.status === 401 || response.status === 403) {
				new Notice("Checkout is not authorized for this account.");
				return;
			}

			if (!response.ok) {
				const message = await response.text();
				new Notice(message || "Checkout failed.");
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
		const disposition = response.headers.get("Content-Disposition") ?? "";
		const match = disposition.match(/filename="?([^"]+)"?/i);
		return match?.[1] ?? "vault-subset.zip";
	}

	private removeBatch(id: string): void {
		this.state.batches = this.state.batches.filter((batch) => batch.id !== id);
		this.openBatchIds.delete(id);
		this.saveState();
		this.render();
	}

	private removeItem(batchId: string, sourcePath: string): void {
		const batch = this.state.batches.find((candidate) => candidate.id === batchId);
		if (!batch) return;
		batch.items = batch.items.filter((item) => item.sourcePath !== sourcePath);
		this.state.batches = this.state.batches.filter((candidate) => candidate.items.length > 0);
		this.openBatchIds = new Set(
			Array.from(this.openBatchIds).filter((id) => this.state.batches.some((batch) => batch.id === id))
		);
		this.saveState();
		this.render();
	}

	private clear(): void {
		this.state = { batches: [] };
		this.openBatchIds.clear();
		this.saveState();
		this.render();
	}

	private render(options: { resetOpenBatches?: boolean } = {}): void {
		const items = this.getCheckoutItems();
		const batchCount = this.state.batches.length;
		this.summaryEl.innerText =
			batchCount === 0
				? "No searches added yet."
				: `${items.length} unique documents from ${batchCount} search${batchCount === 1 ? "" : "es"}.`;

		this.checkoutButtonEl.disabled = items.length === 0;
		this.clearButtonEl.disabled = this.state.batches.length === 0;
		if (options.resetOpenBatches) this.openBatchIds.clear();
		this.saveOpenBatchState(options.resetOpenBatches === true);
		this.renderBatches();
	}

	private renderBatches(): void {
		this.batchListEl.replaceChildren();

		for (const batch of this.state.batches) {
			const batchEl = document.createElement("details");
			batchEl.classList.add("shopping-basket-batch");
			batchEl.open = this.openBatchIds.has(batch.id);
			batchEl.addEventListener("toggle", () =>
			{
				if (batchEl.open) this.openBatchIds.add(batch.id);
				else this.openBatchIds.delete(batch.id);
				this.saveOpenBatchState(true);
			});

			const summaryEl = document.createElement("summary");
			summaryEl.classList.add("shopping-basket-batch-summary");
			summaryEl.innerText = `${batch.query} (${batch.items.length})`;
			batchEl.appendChild(summaryEl);

			const removeBatchButtonEl = document.createElement("button");
			removeBatchButtonEl.type = "button";
			removeBatchButtonEl.classList.add("shopping-basket-remove-batch");
			removeBatchButtonEl.innerText = "Remove search";
			removeBatchButtonEl.addEventListener("click", () => this.removeBatch(batch.id));
			batchEl.appendChild(removeBatchButtonEl);

			const listEl = document.createElement("div");
			listEl.classList.add("shopping-basket-items");
			batchEl.appendChild(listEl);

			for (const item of batch.items) {
				const itemEl = document.createElement("div");
				itemEl.classList.add("shopping-basket-item");

				const titleEl = document.createElement("a");
				titleEl.classList.add("shopping-basket-item-title");
				titleEl.innerText = item.title;
				titleEl.title = item.sourcePath;
				titleEl.href = this.getItemLink(item);
				titleEl.addEventListener("click", (event) => event.stopPropagation());
				itemEl.appendChild(titleEl);

				const removeItemButtonEl = document.createElement("button");
				removeItemButtonEl.type = "button";
				removeItemButtonEl.classList.add("shopping-basket-remove-item");
				removeItemButtonEl.setAttribute("aria-label", `Remove ${item.title}`);
				removeItemButtonEl.innerText = "x";
				removeItemButtonEl.addEventListener("click", () =>
					this.removeItem(batch.id, item.sourcePath)
				);
				itemEl.appendChild(removeItemButtonEl);

				listEl.appendChild(itemEl);
			}

			this.batchListEl.appendChild(batchEl);
		}

		LinkHandler.initializeLinks(this.batchListEl);
	}

	private getItemLink(item: BasketSearchItem): string {
		const query = this.search.getCurrentQuery();
		if (!query) return item.exportPath;
		return `${item.exportPath}?mark=${encodeURIComponent(query)}`;
	}

	private loadState(): BasketState {
		try {
			const raw = localStorage.getItem(ShoppingBasket.storageKey);
			if (!raw) return { batches: [] };
			const parsed = JSON.parse(raw) as BasketState;
			if (!Array.isArray(parsed.batches)) return { batches: [] };
			return parsed;
		} catch (error) {
			console.warn("Failed to load shopping basket state", error);
			return { batches: [] };
		}
	}

	private saveState(): void {
		this.saveOpenBatchState();
		localStorage.setItem(ShoppingBasket.storageKey, JSON.stringify(this.state));
	}

	private saveOpenBatchState(persist: boolean = false): void {
		this.state.openBatchIds = Array.from(this.openBatchIds).filter((id) =>
			this.state.batches.some((batch) => batch.id === id)
		);
		if (persist) {
			localStorage.setItem(ShoppingBasket.storageKey, JSON.stringify(this.state));
		}
	}
}
