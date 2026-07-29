import { createHash } from "crypto";
import { mkdir, rename, unlink, writeFile } from "fs/promises";
import { Path } from "src/plugin/utils/path";

export interface SearchCorpusRecord
{
	path: string;
	sourcePath: string;
	title: string;
	metadata: string;
	aliases: string[];
	headers: string[];
	tags: string[];
	content: string;
}

export class SearchCorpus
{
	private readonly directory: Path;

	constructor(exportRoot: Path, libraryPath: Path)
	{
		this.directory = exportRoot.join(libraryPath).joinString("search-corpus");
	}

	public async write(record: SearchCorpusRecord): Promise<void>
	{
		const recordPath = this.getRecordPath(record.path);
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

	private getRecordPath(exportPath: string): Path
	{
		const id = createHash("sha256").update(exportPath).digest("hex");
		return this.directory.joinString(`${id}.json`);
	}
}
