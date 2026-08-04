import { Attachment } from "src/plugin/utils/downloadable";
import { FileTree } from "src/plugin/features/file-tree";
import {  TAbstractFile, TFile, TFolder } from "obsidian";
import {  Settings } from "src/plugin/settings/settings";
import { Path } from "src/plugin/utils/path";
import { ExportLog, MarkdownRendererAPI, _MarkdownRendererInternal } from "src/plugin/render-api/render-api";
import { AssetLoader } from "src/plugin/asset-loaders/base-asset";
import { AssetType, InlinePolicy, Mutability } from "src/plugin/asset-loaders/asset-types.js";
import { ExportPipelineOptions } from "src/plugin/website/pipeline-options.js";
import { Index as WebsiteIndex } from "src/plugin/website/index";
import { WebpageTemplate } from "./webpage-template";
import { AssetHandler } from "src/plugin/asset-loaders/asset-handler";
import { Webpage } from "./webpage";
import { GraphView } from "src/plugin/features/graph-view";
import { ThemeToggle } from "src/plugin/features/theme-toggle";
import { SearchInput } from "src/plugin/features/search-input";
import { Utils } from "src/plugin/utils/utils";
import { appendFile, mkdir, rename, unlink, writeFile } from "fs/promises";
import { createMarkdownCorpusRecord } from "./markdown-corpus";


export class Website
{
	public destination: Path;
	public index: WebsiteIndex;
	
	private sourceFiles: TFile[] = [];
	private webpageSourceFiles: TFile[] = [];
	private directAttachmentSourcePaths: Set<string> = new Set();
	private fileTreeOrderBySourcePath: Map<string, number> = new Map();

	public fileTree: FileTree;
	public fileTreeAsset: AssetLoader;
	public webpageTemplate: WebpageTemplate;
	public exportOptions: ExportPipelineOptions;
	public outputProgressWeight: number = 1;
	private totalProgressWeight: number = 1;
	private fileTreeProgressBudget: number = 0;
	private exportTimingRows: string[] = [];
	private exportTimingSequence: number = 0;
	private readonly exportTimingPath = ".export-timings.jsonl";
	private readonly exportFileLogPath = ".export-files.log";
	private readonly renderWatchdogMs = 120_000;
	private readonly currentRenderPath = ".export-current-render.json";
	private progressStage = "";
	private progressStartedAt = 0;
	private progressStartedCompleted = 0;

	constructor(destination: Path | string, options?: ExportPipelineOptions)
	{
		if (typeof destination == "string") destination = new Path(destination);
		this.exportOptions = Object.assign(Settings.exportOptions, options);
		if (!destination.isDirectoryFS) throw new Error("Website destination must be a folder: " + destination.path);
		this.destination = destination;
	}

	private async buildTemplate(): Promise<void>
	{
		const template = this.webpageTemplate;
		await template.loadLayout();
			
		// inject graph view
		if (this.exportOptions.graphViewOptions.enabled)
		{
			template.insertFeature(await new GraphView().generate(), this.exportOptions.graphViewOptions);
		}

		// inject darkmode toggle
		if (this.exportOptions.themeToggleOptions.enabled)
		{
			template.insertFeature(await new ThemeToggle().generate(), this.exportOptions.themeToggleOptions);
		}

		// inject search bar
		if (this.exportOptions.searchOptions.enabled)
		{
			template.insertFeature(await new SearchInput().generate(), this.exportOptions.searchOptions);
		}

		// inject file tree
		if (this.exportOptions.fileNavigationOptions.enabled)
		{
			if (this.exportOptions.searchOptions.serverSide)
			{
				template.insertLazyFileExplorer(this.exportOptions.fileNavigationOptions);
			}
			else
			{
				const fileTreeElContainer = document.body.createDiv();
				fileTreeElContainer.innerHTML = this.fileTreeAsset.getHTML(this.exportOptions);
				const fileTreeEl = fileTreeElContainer.firstElementChild as HTMLElement;

				template.insertFeature(fileTreeEl, this.exportOptions.fileNavigationOptions);
				fileTreeElContainer.remove();
				// The template now owns the generated markup; the construction tree can be collected.
				// @ts-ignore
				this.fileTree = undefined;
			}
		}

		// inject custom head content
		if (this.exportOptions.customHeadOptions.enabled)
		{
			let string = AssetHandler.customHeadContent.getHTML(this.exportOptions);
			template.insertFeatureString(string, this.exportOptions.customHeadOptions);
		}
	}

	private findCommonRootPath(files: { path: string }[]): string {
		if (!files || files.length === 0) {
			return '';
		}
	
		if (files.length === 1) {
			return new Path(files[0].path).parent?.path ?? '';
		}
	
		const paths = files.map(file => new Path(file.path).split());
		let commonPath: string[] = [];
		const shortestPathLength = Math.min(...paths.map(p => p.length));
	
		for (let i = 0; i < shortestPathLength; i++) {
			const segment = paths[0][i];
			if (paths.every(path => path[i] === segment)) {
				commonPath.push(segment);
			} else {
				break;
			}
		}
	
		// If the common path is just the root, return an empty string
		if (commonPath.length <= 1) {
			return '';
		}
	
		// Remove the last segment if it's not a common parent for all files
		const lastCommonSegment = commonPath[commonPath.length - 1];
		if (!paths.every(path => path.length > commonPath.length || path[commonPath.length - 1] !== lastCommonSegment)) {
			commonPath.pop();
		}
	
		return commonPath.length > 0 ? new Path(commonPath.join("/")).path : '';
	}

	public async load(files?: TFile[]): Promise<this>
	{
		ExportLog.resetProgress();
		this.sourceFiles = files?.filter((file) => file) ?? [];
		this.webpageSourceFiles = [];
		this.directAttachmentSourcePaths.clear();
		this.fileTreeOrderBySourcePath.clear();
		// Indexing is intentionally excluded from export progress. It prepares
		// the workload, while the measured work starts with the optional file
		// tree and continues through page and attachment output.
		this.totalProgressWeight = Math.max(1, this.sourceFiles.length);
		this.fileTreeProgressBudget = this.exportOptions.fileNavigationOptions.enabled
			? this.totalProgressWeight * 0.05
			: 0;
		const estimatedOperationTotal =
			this.sourceFiles.length * (
				this.exportOptions.fileNavigationOptions.enabled ? 2 : 1
			);
		ExportLog.startDocumentProgress(
			this.totalProgressWeight,
			this.sourceFiles.length,
			estimatedOperationTotal
		);
		await this.writeProgress("indexing-files", 0, this.sourceFiles.length);

		let rootPath = this.findCommonRootPath(this.sourceFiles);
		this.exportOptions.exportRoot = rootPath;
		console.log("Root path: " + rootPath);

		// Server-backed export is the only supported mode. It keeps the browser
		// bootstrap and exporter metadata bounded even for archival-scale vaults.
		const useLargeVaultMode = true;
		this.exportOptions.combineAsSingleFile = false;
		this.exportOptions.searchOptions.serverSide = true;
		this.fileTreeProgressBudget = 0;
		if (this.exportOptions.rssOptions.enabled)
		{
			this.exportOptions.rssOptions.enabled = false;
			ExportLog.log(
				"Large-vault mode does not generate an RSS feed.",
				"Disabling RSS"
			);
		}

		await AssetHandler.reloadAssets(this.exportOptions);
		this.index = new WebsiteIndex();
		try
		{
			await this.index.load(this, this.exportOptions);
		}
		catch (error)
		{
			ExportLog.error(error, "Problem loading index");
		}

		try
		{
			this.webpageTemplate = new WebpageTemplate(this.exportOptions, this.index.rssURL.path);
		}
		catch (error)
		{
			ExportLog.error(error, "Problem creating webpage template");
		}

		// create webpages
		let initializedFiles = 0;
		const exportMediaDirectly =
			!this.exportOptions.combineAsSingleFile &&
			(useLargeVaultMode || this.exportOptions.searchOptions.serverSide);
		const directMarkdownCorpus = this.exportOptions.searchOptions.serverSide;
		for (const file of this.sourceFiles)
		{
			try
			{
				const isConvertable = MarkdownRendererAPI.isConvertable(file.extension);
				const isViewableMedia = MarkdownRendererAPI.viewableMediaExtensions.contains(file.extension);
				if (directMarkdownCorpus)
				{
					if (file.extension.toLowerCase() === "md")
					{
						this.webpageSourceFiles.push(file);
					}
					continue;
				}

				// Make sure files which need to be saved directly without conversion are added to the index as attachments
				if (!isConvertable || isViewableMedia)
				{
					const path = this.getTargetPathForFile(file);
					const attachment = this.exportOptions.combineAsSingleFile
						? new Attachment(Buffer.from(await app.vault.readBinary(file)), path, file, this.exportOptions)
						: Attachment.fromSource(path, file, this.exportOptions);
					attachment.showInTree = !(exportMediaDirectly && isViewableMedia);
					await this.index.addFile(attachment);
				}

				// Create pages for normal convertable files (md, canvas, excalidraw, etc) as well as convertable media files (png, pdf, etc)
				if (isConvertable && !(exportMediaDirectly && isViewableMedia))
				{
					// Avoid retaining a Webpage and its future render state for every note.
					// It is constructed only when this source file reaches the render loop.
					this.webpageSourceFiles.push(file);
				}

			}
			catch (error)
			{
				ExportLog.error(error, "Problem indexing file: " + file.path);
			}
			finally
			{
				initializedFiles++;
				ExportLog.advanceWorkProgress(
					0,
					"Indexing Files",
					`${initializedFiles}/${this.sourceFiles.length}: ${file.path}`,
					"var(--color-yellow)",
					0
				);
				if (initializedFiles % 250 === 0)
				{
					await this.writeProgress("indexing-files", initializedFiles, this.sourceFiles.length);
				}
				if (initializedFiles % 100 === 0) await Utils.delay(0);
			}
		}

		this.index.sortFiles();
		await this.writeProgress("building-file-tree", initializedFiles, this.sourceFiles.length);

		try
		{
			// create file tree asset
			if (this.exportOptions.fileNavigationOptions.enabled)
			{
				if (this.exportOptions.searchOptions.serverSide)
				{
					this.webpageSourceFiles.forEach((file, index) =>
					{
						this.fileTreeOrderBySourcePath.set(file.path, index + 1);
					});
					await this.writeProgress("file-tree-complete", initializedFiles, this.sourceFiles.length);
					return this;
				}
				const rootPrefix = this.exportOptions.exportRoot
					? `${this.exportOptions.exportRoot}/`
					: "";
				const paths = this.sourceFiles.map((file) => new Path(
					rootPrefix && file.path.startsWith(rootPrefix)
						? file.path.slice(rootPrefix.length)
						: file.path
				));
				ExportLog.setRemainingOperationItems(
					paths.length + this.sourceFiles.length
				);
				ExportLog.startWorkPhase(paths.length);
				ExportLog.setProgress(
					0,
					"Building File Tree",
					`0/${paths.length} files`,
					"var(--color-yellow)"
				);
				this.fileTree = new FileTree(paths, false, true);
				this.fileTree.onFileProcessed = (completed, total, path) =>
				{
					ExportLog.advanceWorkProgress(
						this.fileTreeProgressBudget / Math.max(1, total),
						"Building File Tree",
						`${completed}/${total}: ${path.path}`,
						"var(--color-yellow)"
					);
				};
				this.fileTree.makeLinksWebStyle = this.exportOptions.slugifyPaths ?? true;
				this.fileTree.showNestingIndicator = true;
				this.fileTree.generateWithItemsClosed = true;
				this.fileTree.showFileExtentionTags = true;
				this.fileTree.hideFileExtentionTags = ["md"];
				this.fileTree.renderMarkdownTitles = paths.length < 5000;
				this.fileTree.title = this.exportOptions.siteName ?? app.vault.getName();
				this.fileTree.id = "file-explorer";
				const tempContainer = document.createElement("div");
				await this.fileTree.generate(tempContainer);
				const data = tempContainer.innerHTML;
				
				// extract file order and apply to attachments
				this.index.attachmentsShownInTree.forEach((file) => 
				{
					if (!file.sourcePathRootRelative) return;
					const fileTreeItem = this.fileTree?.getItemBySourcePath(file.sourcePathRootRelative);
					file.treeOrder = fileTreeItem?.treeOrder ?? 0;
				});
				for (const sourceFile of this.webpageSourceFiles)
				{
					const sourcePath = rootPrefix && sourceFile.path.startsWith(rootPrefix)
						? sourceFile.path.slice(rootPrefix.length)
						: sourceFile.path;
					this.fileTreeOrderBySourcePath.set(
						sourceFile.path,
						this.fileTree?.getItemBySourcePath(sourcePath)?.treeOrder ?? 0
					);
				}

				tempContainer.remove();
				this.fileTreeAsset = new AssetLoader("file-tree.html", data, null, AssetType.HTML, InlinePolicy.Auto, true, Mutability.Temporary);
			}
		}
		catch (error)
		{
			ExportLog.error(error, "Problem creating file tree");
		}
		await this.writeProgress("file-tree-complete", initializedFiles, this.sourceFiles.length);

		return this;
	}
	
	/**
	 * Create a new website with the given files and options.
	 * @param files The files to include in the website.
	 * @param destination The folder to export the website to.
	 * @param options The api options to use for the export.
	 * @returns The website object.
	 */
	public async build(files?: TFile[]): Promise<Website | undefined>
	{
		if (files) await this.load(files);
		this.exportTimingRows = [];
		this.exportTimingSequence = 0;
		await this.destination.joinString(this.exportTimingPath).write("");

		console.log(`Creating website with ${this.sourceFiles.length} files.`);

		await this.buildTemplate();
		await this.writeProgress("rendering-and-writing-pages", 0, this.webpageSourceFiles.length);
		
		// this.refreshUpdatedFilesList();
		
		// if body classes have changed write new body classes to existing files
		// if (this.bodyClasses != (this.index.oldWebsiteData?.bodyClasses ?? this.bodyClasses))
		// {
		// 	await this.index.applyToOldWebpages(async (document: Document, oldData: WebpageData) => 
		// 	{
		// 		document.body.className = this.bodyClasses;
		// 		ExportLog.progress(0, "Updating Body Classes", oldData.sourcePath);
		// 	});
		// }

		const directMarkdownCorpus = this.exportOptions.searchOptions.serverSide;
		if (!directMarkdownCorpus) await MarkdownRendererAPI.beginBatch(this.exportOptions);
		this.validateSettings();

		const webpageFiles = this.webpageSourceFiles;

		const downloads = AssetHandler.getDownloads(this.destination, this.exportOptions);
		await this.index.addFiles(downloads);

		
		let progress = 0;
		const pendingAttachmentPaths = new Set(
			[...this.index.newFiles, ...this.index.updatedFiles]
				.filter((file) => !(file instanceof Webpage))
				.map((file) => file.targetPath.path)
		);
		const initialWorkTotal = webpageFiles.length +
			(this.exportOptions.combineAsSingleFile ? 0 : pendingAttachmentPaths.size);
		ExportLog.setRemainingOperationItems(initialWorkTotal);
		ExportLog.startWorkPhase(webpageFiles.length);
		const completedPreparationBudget =
			this.fileTreeProgressBudget;
		this.outputProgressWeight = initialWorkTotal > 0
			? (this.totalProgressWeight - completedPreparationBudget) / initialWorkTotal
			: 0;
		const completeDocument = async (subMessage: string): Promise<void> =>
		{
			progress += 1;
			// Persist the resume index before reporting a checkpoint boundary as done.
			// The Docker runner may intentionally restart immediately after this log.
			if (progress % 500 === 0)
			{
				await this.index.writeCheckpoint();
			}
			const fileLogLine = `[export-file] ${progress}/${webpageFiles.length} ${subMessage}`;
			console.log(fileLogLine);
			await this.writeExportFileLog(fileLogLine);
			ExportLog.advanceWorkProgress(
				this.outputProgressWeight,
				"Rendering and Writing Pages",
				subMessage,
				"var(--interactive-accent)"
			);
			if (progress % 25 === 0)
			{
				await this.writeProgress("rendering-and-writing-pages", progress, webpageFiles.length);
			}
			if (progress % 50 === 0)
			{
				await this.flushExportTimings();
			}
			await Utils.delay(0);
		};

		for (const sourceFile of webpageFiles)
		{
			const webpage = new Webpage(sourceFile, sourceFile.name, this, this.exportOptions);
			webpage.showInTree = true;
			webpage.treeOrder = this.fileTreeOrderBySourcePath.get(sourceFile.path) ?? 0;
			if (ExportLog.isCancelled())
			{
				await this.flushExportTimings();
				return;
			}
			if (directMarkdownCorpus)
			{
				const targetPath = this.getTargetPathForFile(sourceFile, sourceFile.name);
				targetPath.setExtension("html");
				if (await this.index.isMarkdownCorpusCurrent(targetPath.path, sourceFile.stat.mtime, sourceFile.stat.size))
				{
					console.log(`[export-resume] ${sourceFile.path}`);
					await completeDocument(`Reused ${sourceFile.path}`);
					continue;
				}
				ExportLog.setProgress(0, "Building Markdown Corpus", sourceFile.path);
				await this.writeCurrentRender(sourceFile.path);
				const recordStart = performance.now();
				const corpus = await createMarkdownCorpusRecord(sourceFile, this, webpage.treeOrder);
				await this.index.recordMarkdownCorpus(corpus.record);
				for (const attachmentFile of corpus.attachmentFiles)
				{
					if (this.directAttachmentSourcePaths.has(attachmentFile.path)) continue;
					this.directAttachmentSourcePaths.add(attachmentFile.path);
					const attachment = Attachment.fromSource(
						this.getTargetPathForFile(attachmentFile), attachmentFile, this.exportOptions
					);
					await this.index.recordDirectAttachment(attachment);
				}
				await this.clearCurrentRender();
				this.recordExportTiming({
					renderMs: performance.now() - recordStart,
					indexMs: 0,
					writeMs: 0,
					failed: false,
					sourcePath: sourceFile.path,
				});
				await completeDocument(sourceFile.path);
				continue;
			}
			if (await this.index.isGeneratedWebpageCurrent(webpage))
			{
				console.log(`[export-resume] ${webpage.source.path}`);
				await completeDocument(`Reused ${webpage.source.path}`);
				continue;
			}

			ExportLog.setProgress(
				0,
				"Rendering and Writing Pages",
				webpage.source.path
			);
			await this.writeCurrentRender(webpage.source.path);

			const documentStart = performance.now();
			let renderTimedOut = false;
			let renderTimeout: ReturnType<typeof setTimeout> | undefined;
			const renderPromise = webpage.renderDocument();
			const rendered = await new Promise<Webpage | undefined>((resolve) =>
			{
				let settled = false;
				renderTimeout = setTimeout(async () =>
				{
					if (settled) return;
					settled = true;
					renderTimedOut = true;
					_MarkdownRendererInternal.invalidateCurrentRender(
						`watchdog timeout after ${this.renderWatchdogMs} ms for ${webpage.source.path}`
					);
					ExportLog.error(
						`The renderer exceeded ${this.renderWatchdogMs / 1000} seconds. The document was skipped and the render view was reset.`,
						`Render watchdog: ${webpage.source.path}`
					);
					await _MarkdownRendererInternal.resetForNextDocument("watchdog timeout");
					resolve(undefined);
				}, this.renderWatchdogMs);
				renderPromise.then((value) =>
				{
					if (settled) return;
					settled = true;
					if (renderTimeout) clearTimeout(renderTimeout);
					resolve(value);
				}).catch(() =>
				{
					if (settled) return;
					settled = true;
					if (renderTimeout) clearTimeout(renderTimeout);
					resolve(undefined);
				});
			});
			const renderMs = performance.now() - documentStart;
			if (!rendered)
			{
				await this.clearCurrentRender();
				this.recordExportTiming({ renderMs, resetMs: _MarkdownRendererInternal.lastRenderResetMs, failed: true, timedOut: renderTimedOut, sourcePath: webpage.source.path });
				webpage.dispose();
				await completeDocument(webpage.source.path);
				continue;
			}
			
			const attachmentsStart = performance.now();
			const attachments = await webpage.getAttachments();
			await this.index.addFiles(attachments);
			const attachmentsMs = performance.now() - attachmentsStart;
			const buildStart = performance.now();
			const built = await webpage.build();
			const buildMs = performance.now() - buildStart;
			const indexStart = performance.now();
			if (built) await this.index.recordGeneratedWebpage(webpage);
			const indexMs = performance.now() - indexStart;
			// save the file and then dispose of the webpage
			const writeStart = performance.now();
			if (!this.exportOptions.combineAsSingleFile)
				await webpage.download();
			const writeMs = performance.now() - writeStart;
			
			if (this.exportOptions.autoDisposeWebpages)
				webpage.dispose();
			await this.clearCurrentRender();

			this.recordExportTiming({
				renderMs,
				attachmentsMs,
				buildMs,
				indexMs,
				writeMs,
				resetMs: _MarkdownRendererInternal.lastRenderResetMs,
				failed: !built,
				sourcePath: webpage.source.path,
			});
			await completeDocument(webpage.source.path);
		}
		await this.flushExportTimings();
	
		if (this.exportOptions.rssOptions.enabled)
		{
			try
			{
				await this.index.createRSSFeed();
			}
			catch (error)
			{
				ExportLog.error(error, "Problem creating RSS feed");
			}
		}
		
		try
		{
			await this.index.finalize();
			if (directMarkdownCorpus)
			{
				await this.destination.joinString("index.html").write(this.webpageTemplate.getHTML());
			}
			await this.writeProgress("finalizing", progress, webpageFiles.length);
		}
		catch (error)
		{
			ExportLog.error(error, "Problem finalizing index");
		}

		// this.refreshUpdatedFilesList();

		this.validateSite();
		await this.writeProgress("complete", progress, webpageFiles.length);
		return this;
	}

	private recordExportTiming(timings: {
		renderMs: number;
		attachmentsMs?: number;
		buildMs?: number;
		indexMs?: number;
		writeMs?: number;
		resetMs?: number;
		failed: boolean;
		timedOut?: boolean;
		sourcePath?: string;
	}): void
	{
		const memory = process.memoryUsage();
		this.exportTimingRows.push(JSON.stringify({
			item: ++this.exportTimingSequence,
			...timings,
			heapUsed: memory.heapUsed,
			rss: memory.rss,
			timestamp: Date.now(),
		}));
	}

	private async flushExportTimings(): Promise<void>
	{
		if (this.exportTimingRows.length === 0) return;
		const timingPath = this.destination.joinString(this.exportTimingPath).absoluted();
		await appendFile(timingPath.pathname, `${this.exportTimingRows.join("\n")}\n`);
		this.exportTimingRows = [];
	}

	private async writeExportFileLog(line: string): Promise<void>
	{
		const fileLogPath = this.destination.joinString(this.exportFileLogPath).absoluted();
		await appendFile(fileLogPath.pathname, `${line}\n`);
	}

	private async writeCurrentRender(sourcePath: string): Promise<void>
	{
		const progressPath = this.destination.joinString(this.currentRenderPath).absoluted();
		await writeFile(`${progressPath.pathname}.tmp`, JSON.stringify({ sourcePath, startedAt: Date.now() }));
		await rename(`${progressPath.pathname}.tmp`, progressPath.pathname);
	}

	private async clearCurrentRender(): Promise<void>
	{
		const progressPath = this.destination.joinString(this.currentRenderPath).absoluted();
		await unlink(progressPath.pathname).catch(() => undefined);
	}

	private async writeProgress(stage: string, completed: number, total: number): Promise<void>
	{
		const now = Date.now();
		if (stage !== this.progressStage || completed < this.progressStartedCompleted)
		{
			this.progressStage = stage;
			this.progressStartedAt = now;
			this.progressStartedCompleted = completed;
		}
		const progressPath = this.destination.joinString(".export-progress.json").absoluted();
		const temporaryPath = `${progressPath.pathname}.tmp`;
		const memory = process.memoryUsage();
		await mkdir(progressPath.directory.pathname, { recursive: true });
		await writeFile(temporaryPath, JSON.stringify({
			stage,
			completed,
			total,
			timestamp: Date.now(),
			memory: {
				rss: memory.rss,
				heapUsed: memory.heapUsed,
				external: memory.external,
				arrayBuffers: memory.arrayBuffers,
			},
		}));
		await rename(temporaryPath, progressPath.pathname);
		const percentage = total > 0 ? ((completed / total) * 100).toFixed(1) : "100.0";
		const elapsedSeconds = Math.max(0, (now - this.progressStartedAt) / 1000);
		const processed = Math.max(0, completed - this.progressStartedCompleted);
		const itemsPerSecond = elapsedSeconds > 0 ? processed / elapsedSeconds : 0;
		const remainingSeconds = itemsPerSecond > 0 ? Math.max(0, (total - completed) / itemsPerSecond) : undefined;
		const eta = remainingSeconds === undefined
			? "calculating"
			: remainingSeconds < 3600
				? `${Math.floor(remainingSeconds / 60)}m ${Math.floor(remainingSeconds % 60)}s`
				: `${Math.floor(remainingSeconds / 3600)}h ${Math.floor((remainingSeconds % 3600) / 60)}m`;
		console.log(
			`[export-progress] ${stage} ${completed}/${total} (${percentage}%) ` +
			`rate=${itemsPerSecond.toFixed(2)}/s ETA=${eta} ` +
			`heap=${(memory.heapUsed / 1024 / 1024 / 1024).toFixed(2)}GB ` +
			`rss=${(memory.rss / 1024 / 1024 / 1024).toFixed(2)}GB`
		);
	}

	/** 
	 * Display updated files on the render window
	 * */ 
	private refreshUpdatedFilesList()
	{
		try
		{
			let updatedNames = this.index.updatedFiles.map((file) => file.filename);
			updatedNames.concat(this.index.newFiles.map((file) => file.filename));
			if (updatedNames.length == 0) updatedNames = ["None Updated"];
			ExportLog.setFileList(updatedNames, 
			{
				icons: "file",
				renderAsMarkdown: false,
				title: "Updated & New"
			});
		}
		catch (error)
		{
			ExportLog.warning(error, "Problem updating changed files display list on render window");
		}
	}

	private validateSettings()
	{
		// if iconize plugin is installed, warn if note icons are not enabled
		// @ts-ignore
		if (app.plugins?.enabledPlugins?.has("obsidian-icon-folder"))
		{
			// @ts-ignore
			const fileToIconName = app.plugins?.plugins?.['obsidian-icon-folder']?.data;
			const noteIconsEnabled = fileToIconName?.settings?.iconsInNotesEnabled ?? false;
			if (!noteIconsEnabled)
			{
				ExportLog.warning("For Iconize plugin support, enable \"Toggle icons while editing notes\" in the Iconize plugin settings.");
			}
		}

		// if excalidraw installed and the embed mode is not set to Native SVG, warn
		// @ts-ignore
		if (app.plugins?.enabledPlugins?.has("obsidian-excalidraw-plugin"))
		{
			// @ts-ignore
			const embedMode = app.plugins?.plugins?.['obsidian-excalidraw-plugin']?.settings?.['previewImageType'] ?? "";		
			if (embedMode != "SVG")
			{
				ExportLog.warning("For Excalidraw embed support, set the embed mode to \"Native SVG\" in the Excalidraw plugin settings.");
			}
		}

		// the plugin only supports the banner plugin above version 2.0.5
		// @ts-ignore
		if (app.plugins?.enabledPlugins?.has("obsidian-banners"))
		{
			// @ts-ignore
			const bannerPlugin = app.plugins?.plugins?.['obsidian-banners'];
			let version = bannerPlugin?.manifest?.version ?? "0.0.0";
			version = version?.substring(0, 5);
			if (version < "2.0.5")
			{
				ExportLog.warning("The Banner plugin version 2.0.5 or higher is required for full support. You have version " + version + ".");
			}
		}

		// warn the user if they are trying to create an rss feed without a site url
		if (this.exportOptions.rssOptions.enabled && (this.exportOptions.rssOptions.siteUrl == "" || this.exportOptions.rssOptions.siteUrl == undefined))
		{
			ExportLog.warning("Creating an RSS feed requires a site url to be set in the export settings.");
		}

	}

	/**
	 * Run some checks to make sure certain formatting and element rules are followed everywhere.
	 */
	private validateSite()
	{
		// check for .feature-title elements not inside a .feature-header
		this.index.webpages.forEach(async (webpage: Webpage) => 
		{
			const titles = webpage.pageDocument?.querySelectorAll(".feature-title");
			if (!titles) return;
			titles.forEach(async (title: HTMLElement) => 
			{
				if (!title.closest(".feature-header"))
				{
					ExportLog.warning(title, `Feature title not inside a feature header in ${webpage.source.path}`);
				}
			});
			await Utils.delay(0);
		});
	}

	public getTargetPathForFile(file: TFile, filename?: string): Path
	{
		const targetPath = new Path(file.path);
		if (filename) targetPath.fullName = filename;
		targetPath.setWorkingDirectory((this.destination ?? Path.vaultPath.joinString("Web Export")).path);
		targetPath.slugify(this.exportOptions.slugifyPaths);
		return targetPath;
	}

	public async createAttachmentFromSrc(src: string, sourceFile: TFile): Promise<Attachment | undefined>
	{
		const attachedFile = this.getFilePathFromSrc(src, sourceFile.path);
		if (attachedFile.isDirectory) return;

		const file = app.vault.getFileByPath(attachedFile.pathname);
		let path = file?.path ?? "";
		if (!file) path = AssetHandler.mediaPath.joinString(attachedFile.fullName).path;

		const target = new Path(path, this.destination.path)
							.slugify(this.exportOptions.slugifyPaths);

		if (file && !this.exportOptions.combineAsSingleFile)
		{
			return Attachment.fromSource(target, file, this.exportOptions);
		}

		const data: Buffer | undefined = await attachedFile.readAsBuffer();
		if (!data) return;

		const attachment = new Attachment(data, target, file, this.exportOptions);
		if (!attachment.sourcePath) attachment.sourcePath = attachedFile.pathname;
		return attachment;
	}

	public getFilePathFromSrc(src: string, exportingFilePath: string): Path
	{
		// @ts-ignore
		let pathString = "";
		if (src.startsWith("app://"))
		{
			let fail = false;
			try
			{
				// @ts-ignore
				pathString = app.vault.resolveFileUrl(src)?.path ?? "";
				if (pathString == "") fail = true;
			}
			catch
			{
				fail = true;
			}

			if(fail)
			{
				pathString = src.replaceAll("app://", "").replaceAll("\\", "/");
				pathString = pathString.replaceAll(pathString.split("/")[0] + "/", "");
				pathString = Path.getRelativePathFromVault(new Path(pathString), true).path;
				ExportLog.log(pathString, "Fallback path parsing:");
			}
		}
		else
		{
			const split = src.split("#");

			const hash = split[1]?.trim();
			const path = split[0];
			pathString = app.metadataCache.getFirstLinkpathDest(path, exportingFilePath)?.path ?? "";
			if (hash) 
			{
				pathString += "#" + hash;
			}
		}

		pathString = pathString ?? "";

		return new Path(pathString);
	}

	public async getCombinedHTML(): Promise<string>
	{
		// get index.html
		let index = this.index.webpages.find((file) => file.filename == "index.html");
		if (!index?.data && this.index.webpages.length > 0)
		{
			ExportLog.warning("No index.html found, using the first webpage");
			index = this.index.webpages[0];
		}

		if (!index?.data)
		{
			ExportLog.error("No index.html found, website creation failed");
			return "";
		}

		let html = new DOMParser().parseFromString(index.data as string, "text/html");

		// insert head references
		html.head.innerHTML += AssetHandler.getHeadReferences(this.exportOptions);

		// define metadata
		let metadataScript = html.head.createEl("data");
		metadataScript.id = "website-metadata";

		const fileInfo = this.index.websiteData.fileInfo;
		const webpages = this.index.websiteData.webpages;
		// @ts-ignore
		delete this.index.websiteData.fileInfo;
		// @ts-ignore
		delete this.index.websiteData.webpages;
		metadataScript.setAttribute("value", btoa(encodeURI(JSON.stringify(this.index.websiteData))));

		// create a data element with the id being the file path for each file
		for (const [path, data] of Object.entries(webpages))
		{
			const dataElement = html.head.createEl("data");
			dataElement.id = btoa(encodeURI(path));
			dataElement.setAttribute("value", btoa(encodeURI(JSON.stringify(data))));
		}

		// do the same for file info skipping already existing elements
		for (const [path, data] of Object.entries(fileInfo))
		{
			if (html.getElementById(btoa(encodeURI(path)))) continue;
			const dataElement = html.head.createEl("data");
			dataElement.id = btoa(encodeURI(path));
			dataElement.setAttribute("value", btoa(encodeURI(JSON.stringify(data))));
		}

		return `<!DOCTYPE html>\n${html.documentElement.outerHTML}`;
	}

	public async saveAsCombinedHTML(): Promise<void>
	{
		const html = await this.getCombinedHTML();
		const path = this.destination.joinString(this.exportOptions.siteName + ".html");
		await path.write(html);
	}
}
