import { Attachment } from "src/plugin/utils/downloadable";
import { Website } from "./website";
import { Webpage } from "./webpage";
import { Notice, TFile } from "obsidian";
import { ExportPipelineOptions } from "src/plugin/website/pipeline-options.js";
import { AssetHandler } from "src/plugin/asset-loaders/asset-handler";
import { ExportLog } from "src/plugin/render-api/render-api";
import Minisearch from 'minisearch';
import { Path } from "src/plugin/utils/path";
import HTMLExportPlugin from "src/plugin/main";
import { AssetType } from "src/plugin/asset-loaders/asset-types";
import RSS from 'rss';
import { AssetLoader } from "src/plugin/asset-loaders/base-asset";
import { FileData, TagTreeItemData, WebpageData, WebsiteData } from "src/shared/website-data";
import { Utils } from "src/plugin/utils/utils";
import { Shared } from "src/shared/shared";
import { WebpageTemplate } from "./webpage-template";
import { ServerCorpus } from "./server-corpus";
import { mkdir, rename, writeFile } from "fs/promises";

export class Index
{
	private website: Website;
	private sourceToWebpage: Map<string, Webpage> = new Map();
	private sourceToAttachment: Map<string, Attachment> = new Map();
	private exportOptions: ExportPipelineOptions;
	private newFilePaths: Set<string> = new Set();
	private updatedFilePaths: Set<string> = new Set();
	private allFilePaths: Set<string> = new Set();
	private shownInTreePaths: Set<string> = new Set();
	private webpagePaths: Set<string> = new Set();
	private attachmentPaths: Set<string> = new Set();
	private oldFileData: Map<string, FileData> = new Map();
	private oldWebpageData: Map<string, WebpageData> = new Map();
	private metadataValuesByTarget: Map<string, Set<string>> = new Map();
	private websiteAttachmentPaths: Set<string> = new Set();
	private webpagePathsByMetadataBucket: Map<number, Set<string>> = new Map();
	private dirtyMetadataBuckets: Set<number> = new Set();
	private serverCorpus: ServerCorpus;
	private static readonly metadataBucketCount = 64;

	private stopWords = ["a", "about", "actually", "almost", "also", "although", "always", "am", "an", "and", "any", "are", "as", "at", "be", "became", "become", "but", "by", "can", "could", "did", "do", "does", "each", "either", "else", "for", "from", "had", "has", "have", "hence", "how", "i", "if", "in", "is", "it", "its", "just", "may", "maybe", "me", "might", "mine", "must", "my", "mine", "must", "my", "neither", "nor", "not", "of", "oh", "ok", "when", "where", "whereas", "wherever", "whenever", "whether", "which", "while", "who", "whom", "whoever", "whose", "why", "will", "with", "within", "without", "would", "yes", "yet", "you", "your"];
	private minisearchOptions = 
	{
		idField: 'path',
		fields: ['title', 'metadata', 'aliases', 'headers', 'tags', 'path', 'content'],
		storeFields: ['title', 'path'],
		processTerm: (term:any, _fieldName:any) =>
			this.stopWords.includes(term) ? null : term.toLowerCase()
	}

	public webpages: Webpage[] = [];
	public attachments: Attachment[] = [];
	public attachmentsShownInTree: Attachment[] = [];

	public oldWebsiteData: WebsiteData | undefined = undefined;
	public websiteData: WebsiteData = {} as WebsiteData;
	public minisearch: Minisearch<any> | undefined = undefined;
	public rssFeed: RSS | undefined = undefined;
	public rssPath: Path;
	public rssURL: Path;
	public rssAsset: AssetLoader | undefined = undefined;

	public deletedFiles: Set<string> = new Set();
	public newFiles: Attachment[] = [];
	public updatedFiles: Attachment[] = [];
	public allFiles: Attachment[] = [];

	public async load(website: Website, options: ExportPipelineOptions)
	{
		this.website = website;
		this.exportOptions = options;
		this.serverCorpus = new ServerCorpus(this.website.destination, AssetHandler.libraryPath);
		if (this.usesServerMetadata())
		{
			this.websiteData = new WebsiteData();
			this.websiteData.createdTime = Date.now();
		}
		else
		{

		try
		{
			// try to load website data
			const metadataPath = this.website.destination.join(AssetHandler.libraryPath).joinString(Shared.metadataFileName);
	
			const metadata = await metadataPath.readAsString();
			if (metadata) 
			{
				const parsedWebsiteData = JSON.parse(metadata) as WebsiteData;
				if (parsedWebsiteData.metadataShards)
				{
					const libraryPath = this.website.destination.join(AssetHandler.libraryPath);
					const webpageBuckets = parsedWebsiteData.metadataShards.webpageBuckets;
					const [webpages, fileInfo] = await Promise.all([
						webpageBuckets
							? Promise.all(webpageBuckets.map((bucket) => libraryPath.joinString(bucket).readAsString()))
							: libraryPath.joinString(parsedWebsiteData.metadataShards.webpages ?? Shared.metadataPagesFileName).readAsString(),
						libraryPath.joinString(parsedWebsiteData.metadataShards.fileInfo ?? Shared.metadataFilesFileName).readAsString(),
					]);
					parsedWebsiteData.webpages = Array.isArray(webpages)
						? Object.assign({}, ...webpages.filter((bucket): bucket is string => !!bucket).map((bucket) => JSON.parse(bucket)))
						: webpages ? JSON.parse(webpages) : {};
					parsedWebsiteData.fileInfo = fileInfo ? JSON.parse(fileInfo) : {};
				}
				this.oldWebsiteData = parsedWebsiteData;
				this.websiteData = parsedWebsiteData;
				this.oldFileData = new Map(Object.entries(parsedWebsiteData.fileInfo ?? {}));
				this.oldWebpageData = new Map(Object.entries(parsedWebsiteData.webpages ?? {}));
				for (const [targetPath, webpageData] of this.oldWebpageData)
				{
					if (!this.oldFileData.has(targetPath)) this.oldFileData.set(targetPath, webpageData);
				}

				this.deletedFiles = new Set(this.oldWebsiteData.allFiles ?? []);
			}
			else
			{
				console.log("No metadata found. Creating new metadata.");
				this.websiteData = {} as WebsiteData;
				this.websiteData.createdTime = Date.now();
			}
			
			// default values
			if (!this.websiteData.shownInTree) this.websiteData.shownInTree = [];
			if (!this.websiteData.attachments) this.websiteData.attachments = [];
			if (!this.websiteData.allFiles) this.websiteData.allFiles = [];
			if (!this.websiteData.webpages) this.websiteData.webpages = {};
			if (!this.websiteData.fileInfo) this.websiteData.fileInfo = {};
			if (!this.websiteData.sourceToTarget) this.websiteData.sourceToTarget = {};
			if (!this.websiteData.metadataValueToTarget) this.websiteData.metadataValueToTarget = {};
			this.rebuildMetadataBuckets();
			if (!this.websiteData.metadataShards?.webpageBuckets)
			{
				for (const bucket of this.webpagePathsByMetadataBucket.keys())
				{
					this.dirtyMetadataBuckets.add(bucket);
				}
			}
			this.websiteAttachmentPaths = new Set(this.websiteData.attachments);
			this.metadataValuesByTarget.clear();
			for (const [metadataValue, targetPath] of Object.entries(this.websiteData.metadataValueToTarget))
			{
				let values = this.metadataValuesByTarget.get(targetPath);
				if (!values)
				{
					values = new Set();
					this.metadataValuesByTarget.set(targetPath, values);
				}
				values.add(metadataValue);
			}
			this.websiteData.featureOptions = 
			{
				backlinks: options.backlinkOptions,
				tags: options.tagOptions,
				alias: options.aliasOptions,
				properties: options.propertiesOptions,
				fileNavigation: options.fileNavigationOptions,
				search: options.searchOptions,
				shoppingBasket: options.shoppingBasketOptions,
				outline: options.outlineOptions,
				themeToggle: options.themeToggleOptions,
				graphView: options.graphViewOptions,
				sidebar: options.sidebarOptions,
				customHead: options.customHeadOptions,
				document: options.documentOptions,
				rss: options.rssOptions,
				linkPreview: options.linkPreviewOptions,
			};
			
			// set global values
			this.websiteData.modifiedTime = Date.now();
			this.websiteData.siteName = this.website.exportOptions.siteName ?? "";
			this.websiteData.vaultName = app.vault.getName();
			this.websiteData.exportRoot = this.website.exportOptions.exportRoot ?? "";
			this.websiteData.baseURL = this.website.exportOptions.rssOptions.siteUrl ?? "";
			this.websiteData.pluginVersion = HTMLExportPlugin.pluginVersion;
			this.websiteData.themeName = this.website.exportOptions.themeName ?? "Default";
			this.websiteData.bodyClasses = await WebpageTemplate.getValidBodyClasses() ?? "";
			this.websiteData.hasFavicon = this.exportOptions.faviconPath != "";
		}
		catch (e)
		{
			ExportLog.warning(e, "Failed to load metadata.json. Recreating metadata.");
		}
		}

		// Server metadata exports intentionally do not load prior page records.
		// The companion server owns those records after importing the disk journal.
		if (this.usesServerMetadata())
		{
			this.websiteData.featureOptions = {
				backlinks: options.backlinkOptions,
				tags: options.tagOptions,
				alias: options.aliasOptions,
				properties: options.propertiesOptions,
				fileNavigation: options.fileNavigationOptions,
				search: options.searchOptions,
				shoppingBasket: options.shoppingBasketOptions,
				outline: options.outlineOptions,
				themeToggle: options.themeToggleOptions,
				graphView: options.graphViewOptions,
				sidebar: options.sidebarOptions,
				customHead: options.customHeadOptions,
				document: options.documentOptions,
				rss: options.rssOptions,
				linkPreview: options.linkPreviewOptions,
			};
			this.websiteData.modifiedTime = Date.now();
			this.websiteData.siteName = this.website.exportOptions.siteName ?? "";
			this.websiteData.vaultName = app.vault.getName();
			this.websiteData.exportRoot = this.website.exportOptions.exportRoot ?? "";
			this.websiteData.baseURL = this.website.exportOptions.rssOptions.siteUrl ?? "";
			this.websiteData.pluginVersion = HTMLExportPlugin.pluginVersion;
			this.websiteData.themeName = this.website.exportOptions.themeName ?? "Default";
			this.websiteData.bodyClasses = await WebpageTemplate.getValidBodyClasses() ?? "";
			this.websiteData.hasFavicon = this.exportOptions.faviconPath != "";
			this.websiteData.serverMetadata = true;
		}

		if (this.exportOptions.searchOptions.serverSide)
		{
			this.minisearch = undefined;
		}
		// load current index or create a new one if it doesn't exist
		else
		try
		{			
			const indexPath = this.website.destination.join(AssetHandler.libraryPath).joinString(Shared.searchIndexFileName);
			const indexJson = await indexPath.readAsString();
			if (indexJson)
			{
				this.minisearch = Minisearch.loadJSON(indexJson, this.minisearchOptions);
			}
			else throw new Error("No index found");
		}
		catch (e)
		{
			ExportLog.log(e, "No search-index.json exists. Creating new index.");
			this.minisearch = new Minisearch(this.minisearchOptions);
		}

		this.rssPath = AssetHandler.generateSavePath("rss.xml", AssetType.Other, this.website.destination);
		this.rssURL = AssetHandler.generateSavePath("rss.xml", AssetType.Other, new Path(this.exportOptions.rssOptions.siteUrl ?? "")).absolute();
	}

	private usesServerMetadata(): boolean
	{
		return this.exportOptions.searchOptions.serverSide && !this.exportOptions.combineAsSingleFile;
	}

	public async finalize()
	{
		if (this.usesServerMetadata())
		{
			for (const file of this.deletedFiles)
			{
				await this.serverCorpus.remove(file);
			}
			return;
		}

		this.sortFiles();
		if (this.exportOptions.searchOptions.serverSide)
		{
			const browserIndexPath = this.website.destination.join(AssetHandler.libraryPath).joinString(Shared.searchIndexFileName);
			await browserIndexPath.delete();
		}

		this.updateCurrentFileLists();

		// remove deleted files from website data
		for (const file of this.deletedFiles)
		{
			delete this.websiteData.fileInfo[file];
			delete this.websiteData.webpages[file];
			this.markMetadataBucketDirty(file);
			if (this.exportOptions.searchOptions.serverSide && file.toLowerCase().endsWith(".html"))
			{
				await this.serverCorpus.remove(file);
			}
		}
		this.websiteData.attachments = this.websiteData.attachments.filter((file) => !this.deletedFiles.has(file));
		this.websiteData.allFiles = this.websiteData.allFiles.filter((file) => !this.deletedFiles.has(file));
		this.websiteData.shownInTree = this.websiteData.shownInTree.filter((file) => !this.deletedFiles.has(file));
		this.websiteData.sourceToTarget = Object.fromEntries(
			Object.entries(this.websiteData.sourceToTarget)
				.filter(([, targetPath]) => !this.deletedFiles.has(targetPath))
		);
		this.websiteData.metadataValueToTarget = Object.fromEntries(
			Object.entries(this.websiteData.metadataValueToTarget)
				.filter(([, targetPath]) => !this.deletedFiles.has(targetPath))
		);
		for (const webpage of Object.values(this.websiteData.webpages))
		{
			webpage.attachments = webpage.attachments.filter((file) => !this.deletedFiles.has(file));
			webpage.backlinks = webpage.backlinks.filter((file) => !this.deletedFiles.has(file));
		}

		if (!this.exportOptions.combineAsSingleFile)
		{
			for (const webpagePath of Object.keys(this.websiteData.webpages))
			{
				delete this.websiteData.fileInfo[webpagePath];
			}
		}

		this.websiteData.tagTree = this.buildTagTree();
	}

	private updateCurrentFileLists(): void
	{
		this.websiteData.shownInTree = this.attachmentsShownInTree.map((attachment) => attachment.targetPath.path);
		this.websiteData.allFiles = this.allFiles.map((file) => file.targetPath.path);
	}

	public async writeCheckpoint(): Promise<void>
	{
		if (!this.exportOptions.searchOptions.serverSide) return;
		this.updateCurrentFileLists();
		await this.saveWebsiteData();
	}

	public async saveWebsiteData(): Promise<void>
	{
		const websiteDataPath = AssetHandler.generateSavePath("metadata.json", AssetType.Other, this.website.destination);
		if (this.usesServerMetadata())
		{
			const { webpages, fileInfo, sourceToTarget, metadataValueToTarget, attachments, shownInTree, allFiles, tagTree, ...bootstrap } = this.websiteData;
			await this.writeAtomically(
				websiteDataPath,
				JSON.stringify(bootstrap, Index.compactMetadataReplacer)
			);
			return;
		}

		if (!this.exportOptions.combineAsSingleFile)
		{
			const fileInfoPath = AssetHandler.generateSavePath(Shared.metadataFilesFileName, AssetType.Other, this.website.destination);
			const { webpages, fileInfo, ...coreData } = this.websiteData;
			const webpageBuckets = Array.from({ length: Index.metadataBucketCount }, (_, bucket) =>
				`${Shared.metadataPagesDirectoryName}/${bucket.toString().padStart(2, "0")}.json`
			);
			coreData.metadataShards = {
				webpageBuckets,
				fileInfo: Shared.metadataFilesFileName,
			};
			const dirtyBuckets = this.dirtyMetadataBuckets.size > 0
				? Array.from(this.dirtyMetadataBuckets)
				: [];
			await Promise.all(dirtyBuckets.map(async (bucket) =>
			{
				const bucketData: {[targetPath: string]: WebpageData} = {};
				for (const targetPath of this.webpagePathsByMetadataBucket.get(bucket) ?? [])
				{
					const data = webpages[targetPath];
					if (data) bucketData[targetPath] = data;
				}
				await this.writeAtomically(
					AssetHandler.generateSavePath(webpageBuckets[bucket], AssetType.Other, this.website.destination),
					JSON.stringify(bucketData, Index.compactMetadataReplacer)
				);
			}));
			this.dirtyMetadataBuckets.clear();
			await Promise.all([
				this.writeAtomically(fileInfoPath, JSON.stringify(fileInfo, Index.compactMetadataReplacer)),
			]);
			await this.writeAtomically(
				websiteDataPath,
				JSON.stringify(coreData, Index.compactMetadataReplacer)
			);
			return;
		}

		await this.writeAtomically(
			websiteDataPath,
			JSON.stringify(this.websiteData, Index.compactMetadataReplacer)
		);
	}

	public async saveIndexData(): Promise<void>
	{
		if (!this.minisearch) return;
		const indexDataPath = AssetHandler.generateSavePath("search-index.json", AssetType.Other, this.website.destination);
		await this.writeAtomically(indexDataPath, JSON.stringify(this.minisearch));
	}

	private async writeAtomically(targetPath: Path, data: string): Promise<void>
	{
		const absolutePath = targetPath.absoluted().pathname;
		const temporaryPath = `${absolutePath}.tmp`;
		await mkdir(targetPath.absoluted().directory.pathname, { recursive: true });
		await writeFile(temporaryPath, data);
		await rename(temporaryPath, absolutePath);
	}

	private getMetadataBucket(targetPath: string): number
	{
		let hash = 2166136261;
		for (let index = 0; index < targetPath.length; index++)
		{
			hash ^= targetPath.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0) % Index.metadataBucketCount;
	}

	private rebuildMetadataBuckets(): void
	{
		this.webpagePathsByMetadataBucket.clear();
		for (const targetPath of Object.keys(this.websiteData.webpages))
		{
			const bucket = this.getMetadataBucket(targetPath);
			let paths = this.webpagePathsByMetadataBucket.get(bucket);
			if (!paths)
			{
				paths = new Set();
				this.webpagePathsByMetadataBucket.set(bucket, paths);
			}
			paths.add(targetPath);
		}
	}

	private markMetadataBucketDirty(targetPath: string): void
	{
		const bucket = this.getMetadataBucket(targetPath);
		let paths = this.webpagePathsByMetadataBucket.get(bucket);
		if (!paths)
		{
			paths = new Set();
			this.webpagePathsByMetadataBucket.set(bucket, paths);
		}
		if (this.websiteData.webpages[targetPath]) paths.add(targetPath);
		else paths.delete(targetPath);
		this.dirtyMetadataBuckets.add(bucket);
	}

	private buildTagTree(): TagTreeItemData[]
	{
		interface MutableTagNode extends TagTreeItemData
		{
			childMap: Map<string, MutableTagNode>;
		}

		const rootNodes = new Map<string, MutableTagNode>();

		const getOrCreateNode = (
			nodeMap: Map<string, MutableTagNode>,
			name: string,
			path: string
		): MutableTagNode =>
		{
			let node = nodeMap.get(name);
			if (!node)
			{
				node = {
					name,
					path,
					count: 0,
					children: [],
					childMap: new Map<string, MutableTagNode>(),
				};
				nodeMap.set(name, node);
			}

			return node;
		};

		for (const webpage of Object.values(this.websiteData.webpages))
		{
			const uniqueTags = new Set<string>();
			if (this.exportOptions.tagOptions.showInlineTags)
			{
				(webpage.inlineTags ?? []).forEach((tag) => uniqueTags.add(tag));
			}
			if (this.exportOptions.tagOptions.showFrontmatterTags)
			{
				(webpage.frontmatterTags ?? []).forEach((tag) => uniqueTags.add(tag));
			}

			for (const rawTag of uniqueTags)
			{
				const normalizedTag = rawTag.trim().replace(/^#+/, "");
				if (normalizedTag.length == 0) continue;

				const parts = normalizedTag
					.split("/")
					.map((part) => part.trim())
					.filter((part) => part.length > 0);
				if (parts.length == 0) continue;

				let currentMap = rootNodes;
				let currentPath = "";
				for (const part of parts)
				{
					currentPath = currentPath ? `${currentPath}/${part}` : part;
					const node = getOrCreateNode(currentMap, part, currentPath);
					node.count++;
					currentMap = node.childMap;
				}
			}
		}

		const sortNodes = (nodeMap: Map<string, MutableTagNode>): TagTreeItemData[] =>
		{
			return Array.from(nodeMap.values())
				.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
				.map((node) => ({
					name: node.name,
					path: node.path,
					count: node.count,
					children: sortNodes(node.childMap),
				}));
		};

		return sortNodes(rootNodes);
	}

	/**
	 * Simply deletes metadata.json and search-index.json
	 */
	public async clearCache()
	{
		const metadataPath = this.website.destination.join(AssetHandler.libraryPath).joinString(Shared.metadataFileName);
		const indexPath = this.website.destination.join(AssetHandler.libraryPath).joinString(Shared.searchIndexFileName);

		await metadataPath.delete();
		await indexPath.delete();
	}

	public async createRSSFeed()
	{
		let author = this.exportOptions.rssOptions.authorName || undefined;

		this.rssFeed = new RSS(
		{
			title: this.exportOptions.siteName ?? app.vault.getName(),
			description: "Obsidian digital garden",
			generator: "Archivatorium Web Export",
			feed_url: this.rssURL.path,
			site_url: this.exportOptions.rssOptions.siteUrl ?? "",
			image_url: Path.joinStrings(this.exportOptions.rssOptions.siteUrl ?? "", AssetHandler.favicon.targetPath.path).path,
			pubDate: new Date(this.websiteData.modifiedTime),
			copyright: author,
			ttl: 60,
			custom_elements:
			[
				{ "dc:creator": author },
			]
		});
		
		for (const page of this.webpages)
		{
			const title = page.title;
			const url = Path.joinStrings(this.exportOptions.rssOptions.siteUrl ?? "", page.targetPath.path).path;
			const guid = page.source.path;
			const outputData = page.generatedOutputData;
			const storedData = this.websiteData.webpages[page.targetPath.path];
			const date =
				outputData?.rssDate ??
				storedData?.rssDate ??
				new Date(page.source.stat.mtime);
			author = outputData?.author ?? storedData?.author ?? author;
			const media = outputData?.coverImageURL ?? storedData?.coverImageURL ?? "";
			const hasMedia = media != "";
			const description = outputData?.descriptionOrShortenedContent ?? storedData?.description ?? "";

			this.rssFeed.item(
			{ 
				title: title,
				description: description,
				url: url,
				guid: guid,
				date: date,
				enclosure: hasMedia ? { url: media } : undefined,
				author: author,
				custom_elements: 
				[
					hasMedia ? { "content:encoded": `<figure><img src="${media}"></figure>` } : undefined,
				]
			});
		}

		let rssXML = this.rssFeed.xml();

		const rssFileOld = await this.rssPath.readAsString();
		if (rssFileOld)
		{
			const rssDocOld = new DOMParser().parseFromString(rssFileOld, "text/xml");
			const rssDocNew = new DOMParser().parseFromString(rssXML, "text/xml");

			// insert old items into new rss and remove duplicates
			let oldItems = Array.from(rssDocOld.querySelectorAll("item"));
			let newItems = Array.from(rssDocNew.querySelectorAll("item"));

			// filter out deleted files and remove duplicated items favoring the new rss
			const newItemGuids = new Set(
				newItems.map((newItem) =>
					newItem.querySelector("guid")?.textContent ?? ""
				)
			);
			oldItems = oldItems.filter((oldItem) =>
			{
				const guid = oldItem.querySelector("guid")?.textContent ?? "";
				return !this.deletedFiles.has(guid) && !newItemGuids.has(guid);
			});
			
			// remove all items from new rss
			newItems.forEach((item) => item.remove());
			
			
			// add items back to new rss with old items
			newItems = newItems.concat(oldItems);
			const channel = rssDocNew.querySelector("channel");
			newItems.forEach((item) => channel?.appendChild(item));

			rssXML = rssDocNew.documentElement.outerHTML;
		}

		const rssAsset = new Attachment(rssXML, this.rssPath, null, this.exportOptions);
		await this.addFile(rssAsset);
	}

	public async addFile(file: Attachment | Webpage, updateData: boolean = true)
	{
		// determine if the file is new, updated, or unchanged
		let updatedFile = false;
		let newFile = false;
		const key = file.targetPath.path;
		if(!this.hadFile(key))
		{
			if (!this.newFilePaths.has(key))
			{
				this.newFilePaths.add(key);
				this.newFiles.push(file);
			}
			newFile = true;
		}
		else
		{
			const oldData = this.getOldFile(key);
			if (oldData)
			{
				if (oldData.modifiedTime != file.sourceStat.mtime || oldData.sourceSize != file.sourceStat.size)
				{
					if (!this.updatedFilePaths.has(key))
					{
						this.updatedFilePaths.add(key);
						this.updatedFiles.push(file);
					}
					updatedFile = true;
				}
			}

			this.deletedFiles.delete(file.targetPath.path);

			// if we didn't update the file make sure we don't delete the file's attachments
			// if we did update the file we don't need to worry, because the attachments will be recreated
			if (!updatedFile)
			{
				const oldWebpage = this.getOldWebpage(key);
				if (oldWebpage)
				{
					for (const attachment of oldWebpage.attachments)
					{
						this.deletedFiles.delete(attachment);
					}
				}
			}
		}

		// add the file to the list of all files
		if (!this.allFilePaths.has(key))
		{
			this.allFilePaths.add(key);
			this.allFiles.push(file);
		}

		// add the file to the list of files shown in the tree
		if (file.showInTree && !this.shownInTreePaths.has(key))
		{
			this.shownInTreePaths.add(key);
			this.attachmentsShownInTree.push(file);
		}

		if (file instanceof Webpage && file.sourcePath && !this.sourceToWebpage.has(file.sourcePath))
		{
			this.sourceToWebpage.set(file.sourcePath, file);
		}
		if (file instanceof Webpage && !this.webpagePaths.has(key))
		{
			this.webpagePaths.add(key);
			this.webpages.push(file);
		}

		if (file instanceof Attachment && file.sourcePath && !this.sourceToAttachment.has(file.sourcePath))
		{
			this.sourceToAttachment.set(file.sourcePath, file);
		}

		// only update the index if the file is new or updated
		if (updateData && (newFile || updatedFile))
		{
			if (file instanceof Webpage)
			{
				await this.updateWebpage(file);
			}
			else
			{
				await this.updateAttachment(file);
			}
		}
	}

	public async addFiles(files: (Attachment | Webpage)[])
	{
		for (const file of files)
		{
			await this.addFile(file);
		}
	}

	public async removeFile(file: Attachment | Webpage)
	{
		if (file instanceof Webpage)
		{
			await this.removeWebpage(file);
		}
		else
		{
			await this.removeAttachment(file);
		}
	}

	public async removeFiles(files: (Attachment | Webpage)[])
	{
		for (const file of files)
		{
			await this.removeFile(file);
		}
	}

	public getFileFromSrc(src: string, sourceFile: TFile): Attachment | undefined
	{
		const attachedFile = this.website.getFilePathFromSrc(src, sourceFile.path);
		return this.getFile(attachedFile.pathname);
	}

	public getAttachment(sourcePath: string): Attachment | undefined
	{
		return this.sourceToAttachment.get(sourcePath);
	}

	public getWebpage(sourcePath: string): Webpage | undefined
	{
		return this.sourceToWebpage.get(sourcePath);
	}

	public getFile(sourcePath: string, preferAttachment: boolean = false): Attachment | Webpage | undefined
	{
		if (preferAttachment)
		{
			return this.sourceToAttachment.get(sourcePath) ?? this.sourceToWebpage.get(sourcePath);
		}
		
		return this.sourceToWebpage.get(sourcePath) ?? this.sourceToAttachment.get(sourcePath);
	}

	public hasFile(sourcePath: string): boolean
	{
		return this.sourceToWebpage.has(sourcePath);
	}

	public hadFile(targetPath: string): boolean
	{
		return this.oldFileData.has(targetPath);
	}

	public getOldFile(targetPath: string): FileData | undefined
	{
		return this.oldFileData.get(targetPath);
	}

	public getOldWebpage(targetPath: string): WebpageData | undefined
	{
		return this.oldWebpageData.get(targetPath);
	}

	public async applyToOldWebpages(callback: (document: Document, oldData: WebpageData) => Promise<any>)
	{
		if (this.oldWebsiteData)
		{
			const webpages = Array.from(this.oldWebpageData.entries());
			for (const [path, data] of webpages)
			{
				// skip files that were deleted
				if (this.deletedFiles.has(path)) continue;

				const filePath = new Path(path, this.website.destination.path);
				const fileData = await filePath.readAsBuffer();
				if (fileData)
				{
					const document = new DOMParser().parseFromString(fileData.toString(), "text/html");
					await callback(document, data);
					await filePath.write(`<!DOCTYPE html>\n${document.documentElement.outerHTML}`);
				}
			}
		}
	}

	private async addWebpageToWebsiteData(webpage: Webpage): Promise<WebpageData | undefined>
	{
		if (webpage.sourcePath && this.websiteData)
		{
			const webpageInfo: WebpageData = {} as WebpageData;
			webpageInfo.title = webpage.title;
			webpageInfo.icon = webpage.icon;
			webpageInfo.description = webpage.outputData.descriptionOrShortenedContent;
			webpageInfo.aliases = webpage.outputData.aliases;
			webpageInfo.inlineTags = webpage.outputData.inlineTags;
			webpageInfo.frontmatterTags = webpage.outputData.frontmatterTags;
			webpageInfo.rssDate = webpage.outputData.rssDate;
			const compactLargeVaultMetadata =
				this.exportOptions.searchOptions.serverSide &&
				!this.exportOptions.graphViewOptions.enabled;
			webpageInfo.headers = compactLargeVaultMetadata ? [] : await webpage.outputData.renderedHeadings;
			webpageInfo.links = compactLargeVaultMetadata ? [] : webpage.outputData.linksToOtherFiles;
			webpageInfo.author = webpage.outputData.author;
			webpageInfo.coverImageURL = webpage.outputData.coverImageURL;
			webpageInfo.fullURL = webpage.outputData.fullURL;
			webpageInfo.pathToRoot = webpage.outputData.pathToRoot == "" ? "." : webpage.outputData.pathToRoot;
			webpageInfo.attachments = compactLargeVaultMetadata ? [] : webpage.attachments.map((download) => download.targetPath.path);
			
			webpageInfo.createdTime = webpage.source.stat.ctime;
			webpageInfo.modifiedTime = webpage.source.stat.mtime;
			webpageInfo.sourceSize = webpage.source.stat.size;
			webpageInfo.sourcePath = new Path(webpage.source.path).path;
			webpageInfo.exportPath = webpage.targetPath.path;
			webpageInfo.showInTree = webpage.showInTree;
			webpageInfo.treeOrder = webpage.treeOrder;
			webpageInfo.backlinks = webpage.outputData.backlinks.map((backlink) => backlink.targetPath.path);
			webpageInfo.type = webpage.type;
			if (this.exportOptions.combineAsSingleFile)
			{
				webpageInfo.data = webpage.data.toString();
			}
			if (this.usesServerMetadata())
			{
				return webpageInfo;
			}

			// get file info version of the webpage
			const fileInfo: FileData = {} as FileData;
			fileInfo.createdTime = webpageInfo.createdTime;
			fileInfo.modifiedTime = webpageInfo.modifiedTime;
			fileInfo.sourceSize = webpageInfo.sourceSize;
			fileInfo.sourcePath = webpageInfo.sourcePath;
			fileInfo.exportPath = webpageInfo.exportPath;
			fileInfo.showInTree = webpageInfo.showInTree;
			fileInfo.treeOrder = webpageInfo.treeOrder;
			fileInfo.backlinks = webpageInfo.backlinks;
			fileInfo.type = webpageInfo.type;
			fileInfo.data = null;
			

			this.websiteData.webpages[webpageInfo.exportPath] = webpageInfo;
			this.markMetadataBucketDirty(webpageInfo.exportPath);
			if (!this.websiteData.metadataValueToTarget) this.websiteData.metadataValueToTarget = {};
			const previousMetadataValues =
				this.metadataValuesByTarget.get(webpageInfo.exportPath);
			if (previousMetadataValues)
			{
				for (const metadataValue of previousMetadataValues)
				{
					if (
						this.websiteData.metadataValueToTarget[metadataValue] ===
						webpageInfo.exportPath
					)
					{
						delete this.websiteData.metadataValueToTarget[metadataValue];
					}
				}
				this.metadataValuesByTarget.delete(webpageInfo.exportPath);
			}
			for (const metadataValue of webpage.outputData.metadataRedirectValues)
			{
				if (!this.websiteData.metadataValueToTarget[metadataValue])
				{
					this.websiteData.metadataValueToTarget[metadataValue] = webpageInfo.exportPath;
					let values =
						this.metadataValuesByTarget.get(webpageInfo.exportPath);
					if (!values)
					{
						values = new Set();
						this.metadataValuesByTarget.set(
							webpageInfo.exportPath,
							values
						);
					}
					values.add(metadataValue);
				}
			}
			if (this.exportOptions.combineAsSingleFile)
			{
				this.websiteData.fileInfo[webpageInfo.exportPath] = fileInfo;
			}
			else
			{
				delete this.websiteData.fileInfo[webpageInfo.exportPath];
			}
			this.websiteData.sourceToTarget[webpageInfo.sourcePath] = webpageInfo.exportPath;
		}
	}

	private async addWebpageToMinisearch(webpage: Webpage, webpageInfo?: WebpageData)
	{
		const headersInfo = [...await webpage.outputData.renderedHeadings];
		if (headersInfo.length > 0 && headersInfo[0].level == 1 && headersInfo[0].heading == webpage.title) headersInfo.shift();
		const headers = headersInfo.map((header) => header.heading);
		const content = `${webpage.outputData.metadataSearchText} ${webpage.outputData.description} ${webpage.outputData.searchContent}`;

		if (this.exportOptions.searchOptions.serverSide)
		{
			if (!webpageInfo) throw new Error(`Missing metadata for ${webpage.targetPath.path}`);
			await this.serverCorpus.write({
				kind: "webpage",
				data: webpageInfo,
				redirectValues: webpage.outputData.metadataRedirectValues,
				search: {
					metadata: webpage.outputData.metadataSearchText,
					headers,
					tags: webpage.outputData.allTags,
					content,
				},
			});
			return;
		}

		if (this.minisearch)
		{
			const webpagePath = webpage.targetPath.path;
			if (this.minisearch.has(webpagePath)) 
			{
				this.minisearch.discard(webpagePath);
			}

			this.minisearch.add({
				title: webpage.title,
				metadata: webpage.outputData.metadataSearchText,
				aliases: webpage.outputData.aliases,
				headers: headers,
				tags: webpage.outputData.allTags,
				path: webpagePath,
				content,
			});
		}
	}

	private async updateWebpage(webpage: Webpage)
	{
		const webpageInfo = await this.addWebpageToWebsiteData(webpage);
		await this.addWebpageToMinisearch(webpage, webpageInfo);
	}

	public async recordGeneratedWebpage(webpage: Webpage): Promise<void>
	{
		await this.updateWebpage(webpage);
	}

	public async isGeneratedWebpageCurrent(webpage: Webpage): Promise<boolean>
	{
		if (!this.usesServerMetadata()) return false;
		if (!webpage.targetPath.absoluted().exists) return false;
		return await this.serverCorpus.isCurrent(
			webpage.targetPath.path,
			webpage.source.stat.mtime,
			webpage.source.stat.size
		);
	}

	private async addAttachmentToWebsiteData(attachment: Attachment): Promise<string>
	{
		const exportPath = attachment.targetPath.path;
		const key = exportPath;

		if (this.websiteData)
		{
			const fileInfo: FileData = {} as FileData;
			fileInfo.createdTime = attachment.sourceStat.ctime;
			fileInfo.modifiedTime = attachment.sourceStat.mtime;
			fileInfo.sourceSize = attachment.sourceStat.size;
			fileInfo.sourcePath = attachment.sourcePath ?? "";
			fileInfo.exportPath = exportPath;
			fileInfo.showInTree = attachment.showInTree;
			fileInfo.treeOrder = attachment.treeOrder;
			fileInfo.backlinks = [];
			fileInfo.type = AssetLoader.extentionToType(attachment.targetPath.extension);
			fileInfo.data = null;
			if (this.exportOptions.combineAsSingleFile)
			{
				if (attachment.data instanceof Buffer) fileInfo.data = attachment.data.toString("base64");
				else fileInfo.data = attachment.data.toString();
			}
			if (this.usesServerMetadata())
			{
				await this.serverCorpus.write({ kind: "file", data: fileInfo });
				return key;
			}

			this.websiteData.fileInfo[key] = fileInfo;
			if (!this.websiteAttachmentPaths.has(key))
			{
				this.websiteAttachmentPaths.add(key);
				this.websiteData.attachments.push(key);
			}
			this.websiteData.sourceToTarget[fileInfo.sourcePath] = fileInfo.exportPath;
		}

		return key;
	}

	private async updateAttachment(attachment: Attachment)
	{
		await this.addAttachmentToWebsiteData(attachment);

		const path = attachment.targetPath.path;
		if (!this.attachmentPaths.has(path))
		{
			this.attachmentPaths.add(path);
			this.attachments.push(attachment);
		}
	}

	public isNewOrUpdated(file: Attachment): boolean
	{
		const path = file.targetPath.path;
		return this.newFilePaths.has(path) || this.updatedFilePaths.has(path);
	}

	public sortFiles(): void
	{
		const newestFirst = (a: Attachment, b: Attachment) =>
			(b.source?.stat.mtime ?? 0) - (a.source?.stat.mtime ?? 0);
		this.allFiles.sort(newestFirst);
		this.attachments.sort(newestFirst);
		this.attachmentsShownInTree.sort(newestFirst);
		this.webpages.sort((a, b) => b.source.stat.mtime - a.source.stat.mtime);
	}

	private async removeWebpage(webpage: Webpage)
	{
		if (webpage.sourcePath && this.sourceToWebpage.has(webpage.sourcePath))
		{
			this.sourceToWebpage.delete(webpage.sourcePath);
		}

		const key = webpage.targetPath.path;
		if (this.usesServerMetadata())
		{
			await this.serverCorpus.remove(key);
			return;
		}
		delete this.websiteData.webpages[key];
		this.markMetadataBucketDirty(key);
		delete this.websiteData.fileInfo[key];

		if (this.minisearch)
		{
			if (this.minisearch.has(key)) 
			{
				this.minisearch.discard(key);
			}
		}
	}

	private async removeAttachment(attachment: Attachment)
	{
		if (attachment.sourcePath && this.sourceToAttachment.has(attachment.sourcePath))
		{
			this.sourceToAttachment.delete(attachment.sourcePath);
		}

		const key = attachment.targetPath.path;
		if (this.usesServerMetadata())
		{
			await this.serverCorpus.remove(key);
			return;
		}
		delete this.websiteData.fileInfo[key];
	}

	public websiteDataAttachment(): Attachment
	{
		const websiteDataString = JSON.stringify(this.websiteData, Index.compactMetadataReplacer);
		const websiteDataPath = AssetHandler.generateSavePath("metadata.json", AssetType.Other, this.website.destination);
		return new Attachment(websiteDataString, websiteDataPath, null, this.exportOptions);
	}

	public indexDataAttachment(): Attachment
	{
		const indexDataString = JSON.stringify(this.minisearch);
		const indexDataPath = AssetHandler.generateSavePath("search-index.json", AssetType.Other, this.website.destination);
		return new Attachment(indexDataString, indexDataPath, null, this.exportOptions);
	}

	private static compactMetadataReplacer(key: string, value: any)
	{
		if (key.startsWith("info_")) return undefined;
		if (key == "data" && value == null) return undefined;
		return value;
	}

}
