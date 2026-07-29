import { ExportPipelineOptions } from "src/plugin/website/pipeline-options.js";
import { Path } from "./path";
import { FileStats, FileSystemAdapter, TFile } from "obsidian";
import { copyFile, link, rename, unlink } from "fs/promises";
import { constants } from "fs";

export class Attachment
{
	private static temporaryLinkCounter: number = 0;

	/**
	 * The raw data of the file
	 */
	private _data: string | Buffer;
	private _source: TFile | null;
	private _sourcePath: string | undefined;
	private _sourcePathRootRelative: string | undefined;
	private _targetPath: Path;
	private _copySourceOnDownload: boolean = false;
	public sourceStat: FileStats;
	public exportOptions: ExportPipelineOptions;
	public showInTree: boolean = false;
	public treeOrder: number = 0;

	public get filename() { return this.targetPath.fullName; }
	public get basename() { return this.targetPath.basename; }
	public get extension() { return this.targetPath.extension; }
	public get extensionName() { return this.targetPath.extensionName; }
	public get sourcePath() { return this._sourcePath; }
	public set sourcePath(source: string | undefined)
	{
		this._sourcePath = source;
		this._sourcePathRootRelative = this.removeRootFromPath(new Path(source ?? ""), false).path;
	}
	public get sourcePathRootRelative() { return this._sourcePathRootRelative;};
	public set source(source: TFile | null)
	{
		this._source = source;
		this.sourceStat = source?.stat ?? { ctime: Date.now(), mtime: Date.now(), size: this.data?.length ?? 0 };
		this.sourcePath = source?.path;
	}
	public get source() { return this._source; }
	public get targetPath() { return this._targetPath; }
	public set targetPath(target: Path)
	{
		target.slugify(this.exportOptions.slugifyPaths);
		target = this.removeRootFromPath(target);
		this._targetPath = target;
	}

	public get data() { return this._data; }
	public set data(data: string | Buffer)
	{
		this._data = data;
		if (!this.source) this.sourceStat = { ctime: Date.now(), mtime: Date.now(), size: this.data?.length ?? 0 };
	}


	constructor(data: string | Buffer, target: Path, source: TFile | undefined | null, options: ExportPipelineOptions)
	{
		// @ts-ignore
		if (target.extensionName == "html" && !Object.getPrototypeOf(this).constructor.name.contains("Webpage"))	target.setFileName(target.basename + "-content");
		if (target.isDirectory) throw new Error("target must be a file: " + target.path);
		if (target.isAbsolute) throw new Error("(absolute) Target must be a relative path with the working directory set to the root: " + target.path);
		this.exportOptions = options;
		this.source = source ?? null;
		this.data = data;
		this.targetPath = target;
	}

	public static fromSource(target: Path, source: TFile, options: ExportPipelineOptions): Attachment
	{
		const attachment = new Attachment(Buffer.alloc(0), target, source, options);
		attachment._copySourceOnDownload = true;
		return attachment;
	}

	private removeRootFromPath(path: Path, allowSlugify: boolean = true)
	{
		// remove the export root from the target path
		const root = new Path(this.exportOptions.exportRoot ?? "").slugify(allowSlugify && this.exportOptions.slugifyPaths).path + "/";
		if (path.path.startsWith(root))
		{
			path.reparse(path.path.substring(root.length));
		}
		return path;
	}

	async download()
	{
		if (this.targetPath.workingDirectory == Path.vaultPath.path)
		{ 
			throw new Error("(working dir) Target should be a relative path with the working directory set to the root: " + this.targetPath.absoluted().path);
		}

		if (this._copySourceOnDownload && this.source)
		{
			const adapter = app.vault.adapter;
			if (adapter instanceof FileSystemAdapter)
			{
				await this.targetPath.createDirectory();
				await Attachment.linkOrCopy(
					adapter.getFullPath(this.source.path),
					this.targetPath.absoluted().pathname
				);
				return;
			}

			// Non-filesystem adapters cannot expose a source path. Keep memory bounded
			// by reading only this file immediately before it is written.
			const sourceData = Buffer.from(await app.vault.readBinary(this.source));
			await this.targetPath.write(sourceData);
			return;
		}

		const data = this.data instanceof Buffer ? this.data : Buffer.from(this.data.toString());
		await this.targetPath.write(data);
	}

	private static async linkOrCopy(sourcePath: string, targetPath: string): Promise<void>
	{
		const temporaryPath =
			`${targetPath}.hardlink-${process.pid}-${Date.now()}-${Attachment.temporaryLinkCounter++}`;
		try
		{
			await link(sourcePath, temporaryPath);
			await rename(temporaryPath, targetPath);
			// POSIX permits rename to be a no-op when both names already reference
			// the same inode, so clean up the temporary name explicitly.
			await Attachment.unlinkIfExists(temporaryPath);
			return;
		}
		catch (error: any)
		{
			await Attachment.unlinkIfExists(temporaryPath);
			const fallbackCodes = new Set([
				"EXDEV",
				"EPERM",
				"EACCES",
				"EMLINK",
				"ENOSYS",
				"ENOTSUP",
				"EOPNOTSUPP",
			]);
			if (!fallbackCodes.has(error?.code)) throw error;
		}

		// COPYFILE_FICLONE still avoids a physical copy on filesystems supporting
		// copy-on-write, but transparently falls back to a normal copy elsewhere.
		await copyFile(sourcePath, targetPath, constants.COPYFILE_FICLONE);
	}

	private static async unlinkIfExists(path: string): Promise<void>
	{
		try
		{
			await unlink(path);
		}
		catch (error: any)
		{
			if (error?.code !== "ENOENT") throw error;
		}
	}
}
