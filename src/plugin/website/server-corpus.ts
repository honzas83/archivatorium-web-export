import { createHash } from "crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { FileData, WebpageData } from "src/shared/website-data";
import { Path } from "src/plugin/utils/path";

export interface ServerSearchData
{
	metadata: string;
	headers: string[];
	content: string;
}

export interface ServerCorpusRecord
{
	kind: "webpage" | "file";
	data: WebpageData | FileData;
	redirectValues?: string[];
	search?: ServerSearchData;
}

export class ServerCorpus
{
	private readonly directory: Path;

	constructor(exportRoot: Path, libraryPath: Path)
	{
		this.directory = exportRoot.join(libraryPath).joinString("corpus");
	}

	public async write(record: ServerCorpusRecord): Promise<void>
	{
		const recordPath = this.getRecordPath(record.data.exportPath);
		const absolutePath = recordPath.absoluted().pathname;
		const temporaryPath = `${absolutePath}.tmp`;
		await mkdir(recordPath.absoluted().directory.pathname, { recursive: true });
		await writeFile(temporaryPath, JSON.stringify(record));
		await rename(temporaryPath, absolutePath);
	}

	public async remove(exportPath: string): Promise<void>
	{
		try
		{
			await unlink(this.getRecordPath(exportPath).absoluted().pathname);
		}
		catch (error: any)
		{
			if (error?.code !== "ENOENT") throw error;
		}
	}

	public async isCurrent(exportPath: string, modifiedTime: number, sourceSize: number): Promise<boolean>
	{
		try
		{
			const record = JSON.parse(await readFile(
				this.getRecordPath(exportPath).absoluted().pathname,
				"utf8"
			)) as ServerCorpusRecord;
			return record.kind === "webpage" &&
				record.data.exportPath === exportPath &&
				record.data.modifiedTime === modifiedTime &&
				record.data.sourceSize === sourceSize &&
				!!record.search;
		}
		catch
		{
			return false;
		}
	}

	private getRecordPath(exportPath: string): Path
	{
		const id = createHash("sha256").update(exportPath).digest("hex");
		return this.directory.joinString(`${id}.json`);
	}
}
