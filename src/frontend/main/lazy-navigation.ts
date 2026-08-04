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

interface SearchNavigationItem {
	sourcePath: string;
	exportPath: string;
	title: string;
}

interface SearchFolder {
	name: string;
	path: string;
	folders: Map<string, SearchFolder>;
	documents: SearchNavigationItem[];
}

/** Server-backed file tree that fetches each folder only once per page session. */
export class LazyNavigation {
	public tree: Tree;
	public onTreeChanged: ((tree: Tree) => void) | undefined;
	private readonly container: HTMLElement;
	private readonly title: string;
	private readonly loadedParents = new Set<string>();
	private readonly loadingParents = new Map<string, Promise<void>>();
	private filtering = false;

	constructor(container: HTMLElement, title: string) {
		this.container = container;
		this.title = title;
		this.buildTree();
	}

	private buildTree(): void {
		this.container.replaceChildren();
		const treeContainer = document.createElement("div");
		treeContainer.classList.add("tree-container", "nav-files-container");
		this.container.appendChild(treeContainer);

		const header = document.createElement("div");
		header.classList.add("feature-header");
		treeContainer.appendChild(header);
		const titleEl = document.createElement("div");
		titleEl.classList.add("feature-title");
		titleEl.textContent = this.title;
		header.appendChild(titleEl);
		const collapseAll = document.createElement("button");
		collapseAll.classList.add("clickable-icon", "nav-action-button", "tree-collapse-all", "is-collapsed");
		collapseAll.setAttribute("aria-label", "Collapse all");
		collapseAll.innerHTML = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'></svg>";
		header.appendChild(collapseAll);

		this.tree = new Tree(treeContainer);
		this.onTreeChanged?.(this.tree);
	}

	public async initialize(): Promise<void> {
		await this.loadChildren(this.tree, "");
	}

	public async revealDocument(sourcePath: string, exportPath: string): Promise<void> {
		if (this.filtering) {
			this.tree.findByPath(exportPath)?.setActive();
			return;
		}
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

	public async filter(items: SearchNavigationItem[]): Promise<void> {
		this.filtering = true;
		this.loadedParents.clear();
		this.buildTree();

		const root: SearchFolder = { name: "", path: "", folders: new Map(), documents: [] };
		const seen = new Set<string>();
		for (const item of items) {
			if (!item.sourcePath || !item.exportPath || seen.has(item.exportPath)) continue;
			seen.add(item.exportPath);
			const parts = item.sourcePath.replaceAll("\\", "/").split("/").filter(Boolean);
			let folder = root;
			let folderPath = "";
			for (const part of parts.slice(0, -1)) {
				folderPath = folderPath ? `${folderPath}/${part}` : part;
				let child = folder.folders.get(part);
				if (!child) {
					child = { name: part, path: folderPath, folders: new Map(), documents: [] };
					folder.folders.set(part, child);
				}
				folder = child;
			}
			folder.documents.push(item);
		}

		const appendFolder = (parent: TreeItem, folder: SearchFolder) => {
			for (const child of Array.from(folder.folders.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))) {
				const item = this.tree.appendItem(parent, this.createItemElement({ kind: "folder", name: child.name, path: child.path, hasChildren: true }, parent.depth + 1));
				item.path = child.path;
				item.collapsed = false;
				appendFolder(item, child);
			}
			for (const document of folder.documents) {
				this.tree.appendItem(parent, this.createItemElement({ kind: "document", name: document.title, path: document.sourcePath, exportPath: document.exportPath, hasChildren: false }, parent.depth + 1));
			}
		};
		appendFolder(this.tree, root);
	}

	public async clearFilter(): Promise<void> {
		if (!this.filtering) return;
		this.filtering = false;
		this.loadedParents.clear();
		this.buildTree();
		await this.initialize();
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
			const item = this.tree.appendItem(parent, this.createItemElement(entry, parent.depth + 1));
			if (entry.kind === "folder") item.path = entry.path;
			if (entry.kind === "folder") {
				const loadFolder = () => {
					void this.loadChildren(item, entry.path).catch((error) => console.error("Failed to load navigation folder", error));
				};
				item.selfEl.addEventListener("click", loadFolder);
				// Keep the chevron independently actionable, including for keyboard users.
				item.collapseIconEl?.addEventListener("click", loadFolder);
			}
		}
		this.loadedParents.add(parentPath);
	}

	private createItemElement(entry: NavigationItem, depth: number): HTMLElement {
		const item = document.createElement("div");
		item.classList.add("tree-item", entry.kind === "folder" ? "nav-folder" : "nav-file");
		item.dataset.depth = String(depth);
		if (entry.kind === "folder" && entry.hasChildren) item.classList.add("mod-collapsible", "is-collapsed");

		const self = document.createElement(entry.kind === "document" ? "a" : "div");
		self.classList.add("tree-item-self", "is-clickable", entry.kind === "folder" ? "nav-folder-title" : "nav-file-title");
		self.setAttribute("data-path", entry.path);
		if (entry.kind === "document" && entry.exportPath) self.setAttribute("href", entry.exportPath);
		if (entry.kind === "folder") {
			const icon = document.createElement("button");
			icon.type = "button";
			icon.setAttribute("aria-label", `Toggle ${entry.name}`);
			icon.setAttribute("title", `Toggle ${entry.name}`);
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
