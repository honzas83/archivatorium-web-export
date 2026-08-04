import { Tree, TreeItem } from "./trees";

interface NavigationItem {
	kind: "folder" | "document";
	name: string;
	path: string;
	exportPath?: string;
	hasChildren: boolean;
}

interface NavigationResponse {
	parent: string;
	items: NavigationItem[];
}

/** Server-backed file tree that fetches each folder only once per page session. */
export class LazyNavigation {
	public readonly tree: Tree;
	private readonly loadedParents = new Set<string>();
	private readonly loadingParents = new Map<string, Promise<void>>();

	constructor(container: HTMLElement, title: string) {
		container.replaceChildren();
		const treeContainer = document.createElement("div");
		treeContainer.classList.add("tree-container", "nav-files-container");
		container.appendChild(treeContainer);

		const header = document.createElement("div");
		header.classList.add("feature-header");
		treeContainer.appendChild(header);
		const titleEl = document.createElement("div");
		titleEl.classList.add("feature-title");
		titleEl.textContent = title;
		header.appendChild(titleEl);
		const collapseAll = document.createElement("button");
		collapseAll.classList.add("clickable-icon", "nav-action-button", "tree-collapse-all", "is-collapsed");
		collapseAll.setAttribute("aria-label", "Collapse all");
		collapseAll.innerHTML = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'></svg>";
		header.appendChild(collapseAll);

		this.tree = new Tree(treeContainer);
	}

	public async initialize(): Promise<void> {
		await this.loadChildren(this.tree, "");
	}

	public async revealDocument(sourcePath: string, exportPath: string): Promise<void> {
		const parts = sourcePath.replaceAll("\\", "/").split("/").filter(Boolean);
		let parent: TreeItem = this.tree;
		let parentPath = "";
		await this.loadChildren(parent, parentPath);
		for (const part of parts.slice(0, -1)) {
			parentPath = parentPath ? `${parentPath}/${part}` : part;
			let folder = this.tree.findByPath(parentPath);
			if (!folder) return;
			await this.loadChildren(folder, parentPath);
			folder.collapsed = false;
			parent = folder;
		}
		const document = this.tree.findByPath(exportPath);
		if (document) {
			document.setActive();
			document.parent && (document.parent.collapsed = false);
		}
	}

	private async loadChildren(parent: TreeItem, parentPath: string): Promise<void> {
		if (this.loadedParents.has(parentPath)) return;
		const pending = this.loadingParents.get(parentPath);
		if (pending) return pending;
		const request = this.fetchChildren(parent, parentPath).finally(() => this.loadingParents.delete(parentPath));
		this.loadingParents.set(parentPath, request);
		return request;
	}

	private async fetchChildren(parent: TreeItem, parentPath: string): Promise<void> {
		const response = await fetch(`/api/navigation?parent=${encodeURIComponent(parentPath)}`);
		if (!response.ok) throw new Error("Failed to load navigation folder.");
		const payload = await response.json() as NavigationResponse;
		for (const entry of payload.items) {
			const item = this.tree.appendItem(parent, this.createItemElement(entry));
			if (entry.kind === "folder") item.path = entry.path;
			if (entry.kind === "folder") {
				item.selfEl.addEventListener("click", () => {
					void this.loadChildren(item, entry.path).catch((error) => console.error("Failed to load navigation folder", error));
				});
			}
		}
		this.loadedParents.add(parentPath);
	}

	private createItemElement(entry: NavigationItem): HTMLElement {
		const item = document.createElement("div");
		item.classList.add("tree-item", entry.kind === "folder" ? "nav-folder" : "nav-file");
		if (entry.kind === "folder" && entry.hasChildren) item.classList.add("mod-collapsible", "is-collapsed");

		const self = document.createElement(entry.kind === "document" ? "a" : "div");
		self.classList.add("tree-item-self", "is-clickable", entry.kind === "folder" ? "nav-folder-title" : "nav-file-title");
		self.setAttribute("data-path", entry.path);
		if (entry.kind === "document" && entry.exportPath) self.setAttribute("href", entry.exportPath);
		if (entry.kind === "folder") {
			const icon = document.createElement("div");
			icon.classList.add("tree-item-icon", "collapse-icon", "nav-folder-collapse-indicator", "is-collapsed");
			icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon right-triangle"><path d="M3 8L12 17L21 8"></path></svg>';
			self.appendChild(icon);
		}
		const label = document.createElement("div");
		label.classList.add("tree-item-inner", entry.kind === "folder" ? "nav-folder-title-content" : "nav-file-title-content");
		label.textContent = entry.name;
		self.appendChild(label);
		item.appendChild(self);
		const children = document.createElement("div");
		children.classList.add("tree-item-children", entry.kind === "folder" ? "nav-folder-children" : "nav-file-children");
		item.appendChild(children);
		return item;
	}
}
