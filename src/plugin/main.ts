// imports from obsidian API
import { Notice, Plugin, TFile, TFolder } from 'obsidian';

// modules that are part of the plugin
import { AssetHandler } from 'src/plugin/asset-loaders/asset-handler';
import { Settings, SettingsPage } from 'src/plugin/settings/settings';
import { HTMLExporter } from 'src/plugin/exporter';
import { Path } from 'src/plugin/utils/path';
import { ExportModal } from 'src/plugin/settings/export-modal';
import { _MarkdownRendererInternal, ExportLog, MarkdownRendererAPI } from 'src/plugin/render-api/render-api';
import { DataviewRenderer } from './render-api/dataview-renderer';
import { Website } from './website/website';
import { i18n } from './translations/language';



export default class HTMLExportPlugin extends Plugin {
	static pluginVersion: string = "0.0.0";
	public api = MarkdownRendererAPI;
	public internalAPI = _MarkdownRendererInternal;
	public settings = Settings;
	public assetHandler = AssetHandler;
	public Path = Path;
	public dv = DataviewRenderer;
	public Website = Website;

	public async exportDocker() {
		await HTMLExporter.export(true, undefined, new Path("/output"));
	}

	public async exportVault(path: string) {
		await HTMLExporter.exportVault(new Path(path), true, false);
	}

	async onload() {
		console.log("Loading archivatorium-web-export plugin");
		HTMLExportPlugin.pluginVersion = this.manifest.version;

		// @ts-ignore
		window.ArchivatoriumWebExport = this;
		// Keep the upstream API name available for integrations.
		// @ts-ignore
		window.WebpageHTMLExport = this;

		this.addSettingTab(new SettingsPage(this));
		await SettingsPage.loadSettings();
		await AssetHandler.initialize();

		this.addRibbonIcon("folder-up", i18n.exportAsHTML, () => {
			HTMLExporter.export(false);
		});

		// register callback for file rename so we can update the saved files to export
		this.registerEvent(
			this.app.vault.on("rename", SettingsPage.renameFile)
		);

		this.addCommand({
			id: "export-html-vault",
			name: "Export using previous settings",
			callback: () => {
				HTMLExporter.export(true);
			},
		});

		this.addCommand({
			id: "export-html-current",
			name: "Export only current file using previous settings",
			callback: () => {
				const file = this.app.workspace.getActiveFile();

				if (!file) {
					new Notice("No file is currently open!", 5000);
					return;
				}

				HTMLExporter.export(true, [file]);
			},
		});

		this.addCommand({
			id: "export-html-setting",
			name: "Set html export settings",
			callback: () => {
				HTMLExporter.export(false);
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				menu.addItem((item) => {
					item.setTitle(i18n.exportAsHTML)
						.setIcon("download")
						.setSection("export")
						.onClick(() => {
							ExportModal.title =
								i18n.exportModal.exportAsTitle.format(
									file.name
								);
							if (file instanceof TFile) {
								HTMLExporter.export(false, [file]);
							} else if (file instanceof TFolder) {
								const filesInFolder = this.app.vault
									.getFiles()
									.filter((f) =>
										new Path(
											f.path
										).directory.path.startsWith(file.path)
									);
								HTMLExporter.export(false, filesInFolder);
							} else {
								ExportLog.error(
									"File is not a TFile or TFolder! Invalid type: " +
										typeof file +
										""
								);
								new Notice(
									"File is not a File or Folder! Invalid type: " +
										typeof file +
										"",
									5000
								);
							}
						});
				});
			})
		);
	}

	onunload() {
		ExportLog.log("unloading archivatorium-web-export plugin");
	}
}
