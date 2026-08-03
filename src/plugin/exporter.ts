import { Notice, TFile, TFolder } from "obsidian";
import { Path } from "src/plugin/utils/path";
import { ExportPreset, Settings, SettingsPage } from "src/plugin/settings/settings";
import { Utils } from "src/plugin/utils/utils";
import { Website } from "src/plugin/website/website";
import { ExportLog, MarkdownRendererAPI } from "src/plugin/render-api/render-api";
import { ExportInfo, ExportModal } from "src/plugin/settings/export-modal";
import { Webpage } from "./website/webpage";

export class HTMLExporter
{
	public static lastExportSucceeded: boolean = false;
	static async updateSettings(usePreviousSettings: boolean = false, overrideFiles: TFile[] | undefined = undefined, overrideExportPath: Path | undefined = undefined): Promise<ExportInfo | undefined>
	{
		if (!usePreviousSettings) 
		{
			const modal = new ExportModal();
			if(overrideFiles) modal.overridePickedFiles(overrideFiles);
			return await modal.open();
		}
		
		const path = overrideExportPath ?? new Path(Settings.exportOptions.exportPath);
		const hasFiles = (overrideFiles ?? Settings.getFilesToExport()).length > 0;

		if (!hasFiles || !path.exists || !path.isAbsolute || !path.isDirectory)
		{
			new Notice("Please set the export path and files to export in the settings first.", 5000);
			const modal = new ExportModal();
			if(overrideFiles) modal.overridePickedFiles(overrideFiles);
			return await modal.open();
		}

		return undefined;
	}

	public static async export(usePreviousSettings: boolean = true, overrideFiles: TFile[] | undefined = undefined, overrideExportPath: Path | undefined = undefined)
	{
		const info = await this.updateSettings(usePreviousSettings, overrideFiles, overrideExportPath);
		if ((!info && !usePreviousSettings) || (info && info.canceled)) return;

		const files = info?.pickedFiles ?? overrideFiles ?? Settings.getFilesToExport();
		const exportPath = overrideExportPath ?? info?.exportPath ?? new Path(Settings.exportOptions.exportPath);

		const website = await HTMLExporter.exportFiles(files, exportPath, true, Settings.deleteOldFiles);

		if (!website) return;
		if (Settings.openAfterExport) Utils.openPath(exportPath);
		new Notice("✅ Finished HTML Export:\n\n" + exportPath, 5000);
	}

	public static async exportFiles(files: TFile[], destination: Path, saveFiles: boolean, deleteOld: boolean) : Promise<Website | undefined>
	{
		HTMLExporter.lastExportSucceeded = false;
		MarkdownRendererAPI.beginBatch();
		let website = undefined;
		try
		{
			website = await (await new Website(destination).load(files)).build();

			if (!website)
			{
				new Notice("❌ Export Cancelled", 5000);
				return;
			}

			if (deleteOld)
			{
				let i = 0;
				ExportLog.addToProgressCap(website.index.deletedFiles.size / 2);
				for (const dFile of website.index.deletedFiles)
				{
					const path = new Path(dFile, destination.path);
					
					// don't delete font files
					// this is a hacky way to prevent it from deleting the matjax and other font files used in only certain files
					if (path.extension == "woff" || path.extension == "woff2" || path.extension == "ttf" || path.extension == "otf")
					{
						ExportLog.progress(0.5, "Deleting Old Files", "Skipping: " + path.path, "var(--color-yellow)");
						continue;
					}

					await path.delete();
					ExportLog.progress(0.5, "Deleting Old Files", "Deleting: " + path.path, "var(--color-red)");
					i++;
				};

				await Path.removeEmptyDirectories(destination.path);
			}
			
			if (saveFiles) 
			{
				if (Settings.exportOptions.combineAsSingleFile)
				{
					await website.saveAsCombinedHTML();
				}
				else
				{
					const newAttachments = website.index.newFiles.filter((f) => !(f instanceof Webpage));
					const updatedAttachments = website.index.updatedFiles.filter((f) => !(f instanceof Webpage));
					const attachmentCount =
						newAttachments.length + updatedAttachments.length;
					ExportLog.setRemainingOperationItems(attachmentCount);
					ExportLog.startWorkPhase(attachmentCount);
					await Utils.downloadAttachments(
						newAttachments,
						website.outputProgressWeight
					);
					await Utils.downloadAttachments(
						updatedAttachments,
						website.outputProgressWeight
					);

					if (Settings.exportPreset != ExportPreset.RawDocuments)
					{
						await website.index.saveWebsiteData();
						if (!Settings.exportOptions.searchOptions.serverSide)
						{
							await website.index.saveIndexData();
						}
					}
				}
			}
			else
			{
				ExportLog.setRemainingWorkItems(0);
			}

			HTMLExporter.lastExportSucceeded = true;
		}
		catch (e)
		{
			HTMLExporter.lastExportSucceeded = false;
			new Notice("❌ Export Failed: " + e, 5000);
			ExportLog.error(e, "Export Failed", true);
		}

		ExportLog.setRemainingWorkItems(0, 0);
		ExportLog.endDocumentProgress();
		MarkdownRendererAPI.endBatch();

		return website;
	}

	public static async exportFolder(folder: TFolder, rootExportPath: Path, saveFiles: boolean, clearDirectory: boolean) : Promise<Website | undefined>
	{
		const folderPath = new Path(folder.path);
		const allFiles = app.vault.getFiles();
		const files = allFiles.filter((file) => new Path(file.path).directory.path.startsWith(folderPath.path));

		return await this.exportFiles(files, rootExportPath, saveFiles, clearDirectory);
	}

	public static async exportVault(rootExportPath: Path, saveFiles: boolean, clearDirectory: boolean) : Promise<Website | undefined>
	{
		const files = app.vault.getFiles();
		return await this.exportFiles(files, rootExportPath, saveFiles, clearDirectory);
	}

}
