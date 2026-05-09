import { DynamicInsertedFeature } from "src/shared/dynamic-inserted-feature";
import { TagsOptions } from "src/shared/features/tags";
import { TagTreeItemData } from "src/shared/website-data";
import { Tree } from "./trees";

interface TagsDependencies {
	tagTree: TagTreeItemData[];
}

class RightSidebarViewManager {
	private static instance: RightSidebarViewManager | undefined = undefined;
	private static readonly storageKey = "right-sidebar-active-view";

	private readonly rightSidebarContentEl: HTMLElement;
	private readonly rightSidebarTopbarContentEl: HTMLElement;
	private readonly switcherEl: HTMLDivElement;
	private readonly originalButtonEl: HTMLButtonElement;
	private readonly tagsButtonEl: HTMLButtonElement;
	private readonly panelsEl: HTMLDivElement;
	private readonly originalPanelEl: HTMLDivElement;
	private readonly tagsPanelEl: HTMLDivElement;
	private readonly observer: MutationObserver;

	private activeView: "original" | "tags";
	private refreshing = false;

	private constructor() {
		this.rightSidebarContentEl = document.querySelector(
			"#right-sidebar-content"
		) as HTMLElement;
		this.rightSidebarTopbarContentEl = document.querySelector(
			"#right-sidebar .topbar-content"
		) as HTMLElement;

		if (!this.rightSidebarContentEl || !this.rightSidebarTopbarContentEl) {
			throw new Error("Right sidebar content not found");
		}

		this.activeView =
			(localStorage.getItem(
				RightSidebarViewManager.storageKey
			) as "original" | "tags" | null) ?? "original";

		this.switcherEl = document.createElement("div");
		this.switcherEl.classList.add("right-sidebar-view-switcher");
		this.switcherEl.setAttribute("role", "tablist");

		this.originalButtonEl = this.createViewButton(
			"original",
			"Table of contents & Interactive graph"
		);
		this.tagsButtonEl = this.createViewButton("tags", "Tags");
		this.switcherEl.append(this.originalButtonEl, this.tagsButtonEl);

		this.panelsEl = document.createElement("div");
		this.panelsEl.classList.add("right-sidebar-view-panels");

		this.originalPanelEl = document.createElement("div");
		this.originalPanelEl.classList.add(
			"right-sidebar-view-panel",
			"right-sidebar-view-panel-original"
		);
		this.originalPanelEl.dataset.view = "original";

		this.tagsPanelEl = document.createElement("div");
		this.tagsPanelEl.classList.add(
			"right-sidebar-view-panel",
			"right-sidebar-view-panel-tags"
		);
		this.tagsPanelEl.dataset.view = "tags";

		this.panelsEl.append(this.originalPanelEl, this.tagsPanelEl);
		this.rightSidebarContentEl.prepend(this.panelsEl);
		this.rightSidebarTopbarContentEl.append(this.switcherEl);

		this.observer = new MutationObserver(() => {
			if (this.refreshing) return;
			this.refresh();
		});
		this.observer.observe(this.rightSidebarContentEl, { childList: true });

		this.refresh();
	}

	public static getOrCreate(): RightSidebarViewManager {
		if (!RightSidebarViewManager.instance) {
			RightSidebarViewManager.instance = new RightSidebarViewManager();
		}

		return RightSidebarViewManager.instance;
	}

	public refresh(): void {
		this.refreshing = true;

		const directChildren = Array.from(this.rightSidebarContentEl.children);
		for (const child of directChildren) {
			if (child === this.switcherEl || child === this.panelsEl) continue;
			if ((child as HTMLElement).id === "tags") {
				this.tagsPanelEl.appendChild(child);
			} else {
				this.originalPanelEl.appendChild(child);
			}
		}

		const tagsFeatureEl = this.tagsPanelEl.querySelector("#tags") as
			| HTMLElement
			| null;
		const tagsVisible =
			!!tagsFeatureEl && getComputedStyle(tagsFeatureEl).display !== "none";

		this.tagsButtonEl.hidden = !tagsVisible;
		this.switcherEl.classList.toggle("has-tags-view", tagsVisible);

		if (!tagsVisible && this.activeView === "tags") {
			this.activeView = "original";
		}

		this.applyState();
		this.refreshing = false;
	}

	private createViewButton(
		view: "original" | "tags",
		label: string
	): HTMLButtonElement {
		const button = document.createElement("button");
		button.classList.add("right-sidebar-view-button");
		button.dataset.view = view;
		button.type = "button";
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
		button.setAttribute("role", "tab");
		button.innerHTML =
			view === "original"
				? '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path></svg>'
				: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82Z"></path><path d="M7 7h.01"></path></svg>';
		button.addEventListener("click", () => this.setActiveView(view));
		return button;
	}

	private setActiveView(view: "original" | "tags"): void {
		if (view === "tags" && this.tagsButtonEl.hidden) {
			view = "original";
		}

		this.activeView = view;
		localStorage.setItem(RightSidebarViewManager.storageKey, view);
		this.applyState();
	}

	private applyState(): void {
		const showTags = this.activeView === "tags" && !this.tagsButtonEl.hidden;

		this.originalButtonEl.classList.toggle("is-active", !showTags);
		this.originalButtonEl.setAttribute("aria-selected", String(!showTags));
		this.tagsButtonEl.classList.toggle("is-active", showTags);
		this.tagsButtonEl.setAttribute("aria-selected", String(showTags));

		this.originalPanelEl.classList.toggle("is-active", !showTags);
		this.tagsPanelEl.classList.toggle("is-active", showTags);

		this.originalPanelEl.hidden = showTags;
		this.tagsPanelEl.hidden = !showTags;
	}
}

export class Tags extends DynamicInsertedFeature<TagsOptions, TagsDependencies> {
	private tree: Tree | undefined = undefined;

	constructor(tagTree: TagTreeItemData[]) {
		super(ObsidianSite.metadata.featureOptions.tags, { tagTree });
	}

	protected generateContent(container: HTMLElement) {
		const deps = this.getDependencies();
		RightSidebarViewManager.getOrCreate().refresh();

		const featureEl = container.parentElement as HTMLElement | null;
		const featureHeaderEl = featureEl?.querySelector(
			":scope > .feature-header"
		) as HTMLElement | null;
		if (featureHeaderEl) {
			featureHeaderEl.style.display = "none";
		}

		const treeContainer = document.createElement("div");
		treeContainer.classList.add("tree-container", "tags-tree");
		container.appendChild(treeContainer);

		const headerEl = document.createElement("div");
		headerEl.classList.add("tag-view-header");
		treeContainer.appendChild(headerEl);

		const titleEl = document.createElement("div");
		titleEl.classList.add("tag-view-title");
		titleEl.innerText = "Tags";
		headerEl.appendChild(titleEl);

		const controlsEl = document.createElement("div");
		controlsEl.classList.add("tag-view-controls");
		headerEl.appendChild(controlsEl);

		const collapseAllEl = document.createElement("button");
		collapseAllEl.classList.add(
			"clickable-icon",
			"nav-action-button",
			"tree-collapse-all"
		);
		collapseAllEl.setAttribute("aria-label", "Collapse or expand all tags");
		collapseAllEl.setAttribute("title", "Collapse or expand all tags");
		collapseAllEl.innerHTML =
			"<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'></svg>";
		controlsEl.appendChild(collapseAllEl);

		for (const node of deps.tagTree) {
			treeContainer.appendChild(this.createTreeItem(node));
		}

		this.tree = new Tree(treeContainer, 1);
		RightSidebarViewManager.getOrCreate().refresh();
	}

	private createTreeItem(node: TagTreeItemData): HTMLElement {
		const itemEl = document.createElement("div");
		itemEl.classList.add("tree-item");
		if (node.children.length > 0) {
			itemEl.classList.add("mod-collapsible");
		}

		const itemLinkEl = document.createElement("a");
		itemLinkEl.classList.add("tree-item-self", "is-clickable");
		itemLinkEl.setAttribute("href", this.getTagSearchHref(node.path));
		itemLinkEl.setAttribute("data-path", node.path);
		itemEl.appendChild(itemLinkEl);

		if (node.children.length > 0) {
			const collapseIconEl = document.createElement("div");
			collapseIconEl.classList.add("tree-item-icon", "collapse-icon");
			collapseIconEl.innerHTML =
				'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon right-triangle"><path d="M3 8L12 17L21 8"></path></svg>';
			itemLinkEl.appendChild(collapseIconEl);
		}

		const innerEl = document.createElement("div");
		innerEl.classList.add("tree-item-inner", "tag-tree-label");
		innerEl.innerText = node.name;
		itemLinkEl.appendChild(innerEl);

		const countEl = document.createElement("span");
		countEl.classList.add("tag-tree-count");
		countEl.innerText = String(node.count);
		itemLinkEl.appendChild(countEl);

		const childrenEl = document.createElement("div");
		childrenEl.classList.add("tree-item-children");
		itemEl.appendChild(childrenEl);

		for (const child of node.children) {
			childrenEl.appendChild(this.createTreeItem(child));
		}

		return itemEl;
	}

	private getTagSearchHref(tagPath: string): string {
		return `?query=tag:${tagPath}`;
	}

	public override hide(): void {
		super.hide();
		RightSidebarViewManager.getOrCreate().refresh();
	}

	public override show(): void {
		super.show();
		RightSidebarViewManager.getOrCreate().refresh();
	}
}
