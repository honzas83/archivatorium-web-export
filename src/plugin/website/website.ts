import { Attachment } from "src/plugin/utils/downloadable";
import {  TAbstractFile, TFile, TFolder } from "obsidian";
import {  Settings } from "src/plugin/settings/settings";
import { Path } from "src/plugin/utils/path";
import { ExportLog } from "src/plugin/render-api/render-api";
import { ExportPipelineOptions } from "src/plugin/website/pipeline-options.js";
import { Index as WebsiteIndex } from "src/plugin/website/index";
import { WebpageTemplate } from "./webpage-template";
import { AssetHandler } from "src/plugin/asset-loaders/asset-handler";
import { GraphView } from "src/plugin/features/graph-view";
import { ThemeToggle } from "src/plugin/features/theme-toggle";
import { SearchInput } from "src/plugin/features/search-input";
import { Utils } from "src/plugin/utils/utils";
import { appendFile, mkdir, rename, writeFile } from "fs/promises";
import { createMarkdownCorpusRecord } from "./markdown-corpus";


export class Website
{
	public destination: Path;
	public index: WebsiteIndex;
	
	private sourceFiles: TFile[] = [];
	private markdownSourceFiles: TFile[] = [];
	private directAttachmentSourcePaths: Set<string> = new Set();
	private fileTreeOrderBySourcePath: Map<string, number> = new Map();

	public webpageTemplate: WebpageTemplate;
	public exportOptions: ExportPipelineOptions;
	public outputProgressWeight: number = 1;
	private totalProgressWeight: number = 1;
	private readonly exportFileLogPath = ".export-files.log";
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
			template.insertLazyFileExplorer(this.exportOptions.fileNavigationOptions);
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
		this.markdownSourceFiles = [];
		this.directAttachmentSourcePaths.clear();
		this.fileTreeOrderBySourcePath.clear();
		this.totalProgressWeight = Math.max(1, this.sourceFiles.length);
		ExportLog.startDocumentProgress(
			this.totalProgressWeight,
			this.sourceFiles.length,
			this.sourceFiles.length
		);
		await this.writeProgress("indexing-files", 0, this.sourceFiles.length);

		let rootPath = this.findCommonRootPath(this.sourceFiles);
		this.exportOptions.exportRoot = rootPath;
		console.log("Root path: " + rootPath);

		// The experiment has one output architecture: a server-rendered SPA.
		this.exportOptions.combineAsSingleFile = false;
		this.exportOptions.searchOptions.serverSide = true;
		if (this.exportOptions.rssOptions.enabled)
		{
			this.exportOptions.rssOptions.enabled = false;
			ExportLog.log("The server-rendered SPA does not generate an RSS feed.", "Disabling RSS");
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

		let initializedFiles = 0;
		for (const file of this.sourceFiles)
		{
			if (file.extension.toLowerCase() === "md") this.markdownSourceFiles.push(file);
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

		this.markdownSourceFiles.forEach((file, index) =>
		{
			this.fileTreeOrderBySourcePath.set(file.path, index + 1);
		});
		await this.writeProgress("indexing-complete", initializedFiles, this.sourceFiles.length);

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
		await this.writeProgress("preparing-spa-shell", 0, 2);
		console.log(`Creating website with ${this.sourceFiles.length} files.`);
		console.log("[export-phase] building SPA shell");
		await this.buildTemplate();
		console.log("[export-phase] SPA shell ready");
		await this.writeProgress("preparing-spa-shell", 1, 2);
		await this.writeProgress("building-markdown-corpus", 0, this.markdownSourceFiles.length);

		const downloads = AssetHandler.getDownloads(this.destination, this.exportOptions);
		await this.index.addFiles(downloads);

		let progress = 0;
		const pendingAttachmentPaths = new Set(
			[...this.index.newFiles, ...this.index.updatedFiles]
				.map((file) => file.targetPath.path)
		);
		const initialWorkTotal = this.markdownSourceFiles.length + pendingAttachmentPaths.size;
		ExportLog.setRemainingOperationItems(initialWorkTotal);
		ExportLog.startWorkPhase(this.markdownSourceFiles.length);
		this.outputProgressWeight = initialWorkTotal > 0
			? this.totalProgressWeight / initialWorkTotal
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
			const fileLogLine = `[export-file] ${progress}/${this.markdownSourceFiles.length} ${subMessage}`;
			console.log(fileLogLine);
			await this.writeExportFileLog(fileLogLine);
			ExportLog.advanceWorkProgress(
				this.outputProgressWeight,
				"Building Markdown Corpus",
				subMessage,
				"var(--interactive-accent)"
			);
			if (progress % 25 === 0)
			{
				await this.writeProgress("building-markdown-corpus", progress, this.markdownSourceFiles.length);
			}
			await Utils.delay(0);
		};

		for (const sourceFile of this.markdownSourceFiles)
		{
			if (ExportLog.isCancelled()) return;
			const targetPath = this.getTargetPathForFile(sourceFile, sourceFile.name);
			targetPath.setExtension("html");
			if (await this.index.isMarkdownCorpusCurrent(targetPath.path, sourceFile.stat.mtime, sourceFile.stat.size))
			{
				console.log(`[export-resume] ${sourceFile.path}`);
				await completeDocument(`Reused ${sourceFile.path}`);
				continue;
			}

			ExportLog.setProgress(0, "Building Markdown Corpus", sourceFile.path);
			const corpus = await createMarkdownCorpusRecord(
				sourceFile,
				this,
				this.fileTreeOrderBySourcePath.get(sourceFile.path) ?? 0
			);
			await this.index.recordMarkdownCorpus(corpus.record);
			for (const attachmentFile of corpus.attachmentFiles)
			{
				if (this.directAttachmentSourcePaths.has(attachmentFile.path)) continue;
				this.directAttachmentSourcePaths.add(attachmentFile.path);
				const attachment = Attachment.fromSource(
					this.getTargetPathForFile(attachmentFile),
					attachmentFile,
					this.exportOptions
				);
				await this.index.recordDirectAttachment(attachment);
			}
			await completeDocument(sourceFile.path);
		}
		
		try
		{
			await this.index.finalize();
			await this.destination.joinString("index.html").write(this.webpageTemplate.getHTML());
			await this.writeProgress("finalizing", progress, this.markdownSourceFiles.length);
		}
		catch (error)
		{
			ExportLog.error(error, "Problem finalizing index");
		}

		await this.writeProgress("complete", progress, this.markdownSourceFiles.length);
		return this;
	}

	private async writeExportFileLog(line: string): Promise<void>
	{
		const fileLogPath = this.destination.joinString(this.exportFileLogPath).absoluted();
		await appendFile(fileLogPath.pathname, `${line}\n`);
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

}
