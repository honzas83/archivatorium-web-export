import { Modal, Setting, TFile } from 'obsidian';
import { Utils } from 'src/plugin/utils/utils';
import { ExportPreset, Settings, SettingsPage } from './settings';
import { FilePickerTree } from 'src/plugin/features/file-picker';
import { Path } from 'src/plugin/utils/path';
import { createToggle } from './settings-components';
import { Website } from 'src/plugin/website/website';
import { i18n } from '../translations/language';

export interface ExportInfo
{
	canceled: boolean;
	pickedFiles: TFile[];
	exportPath: Path;
	validPath: boolean;
}

export class ExportModal extends Modal 
{
	private isClosed: boolean = true;
	private canceled: boolean = true;
	private filePickerModalEl: HTMLElement;
	private filePicker: FilePickerTree;
	private pickedFiles: TFile[] | undefined = undefined;
	private validPath: boolean = true;
	public static title: string = i18n.exportModal.title;

	public exportInfo: ExportInfo;

	constructor() {
		super(app);
	}

	overridePickedFiles(files: TFile[])
	{
		this.pickedFiles = files;
	}

	/**
	 * @brief Opens the modal and async blocks until the modal is closed.
	 * @returns True if the EXPORT button was pressed, false is the export was canceled.
	 * @override
	*/
	async open(): Promise<ExportInfo> 
	{
		this.isClosed = false;
		this.canceled = true;
		const lang = i18n.exportModal;

		super.open();

		if(!this.filePickerModalEl)
		{
			this.filePickerModalEl = this.containerEl.createDiv({ cls: 'modal' });
			this.containerEl.insertBefore(this.filePickerModalEl, this.modalEl);
			this.filePickerModalEl.style.position = 'relative';
			this.filePickerModalEl.style.zIndex = "1";
			this.filePickerModalEl.style.width = "25em";
			this.filePickerModalEl.style.padding = "0";
			this.filePickerModalEl.style.margin = "10px";
			this.filePickerModalEl.style.maxHeight = "80%";
			this.filePickerModalEl.style.boxShadow = "0 0 7px 1px inset #00000060";
			
			const scrollArea = this.filePickerModalEl.createDiv({ cls: 'tree-scroll-area' });
			scrollArea.style.height = "100%";
			scrollArea.style.width = "100%";
			scrollArea.style.overflowY = "auto";
			scrollArea.style.overflowX = "hidden";
			scrollArea.style.padding = "1em";
			scrollArea.style.boxShadow = "0 0 7px 1px inset #00000060";

			const paths = app.vault.getFiles().map(file => new Path(file.path));
			this.filePicker = new FilePickerTree(paths, true, true);
			this.filePicker.regexBlacklist.push(...Settings.filePickerBlacklist);
			this.filePicker.regexBlacklist.push(...[Settings.exportOptions.customHeadOptions.sourcePath, Settings.exportOptions.faviconPath]);
			this.filePicker.regexWhitelist.push(...Settings.filePickerWhitelist);
			
			this.filePicker.generateWithItemsClosed = true;
			this.filePicker.showFileExtentionTags = true;
			this.filePicker.hideFileExtentionTags = ["md"];
			this.filePicker.title = lang.filePicker.title;
			this.filePicker.class = "file-picker";
			await this.filePicker.generate(scrollArea);
			
			if((this.pickedFiles?.length ?? 0 > 0) || Settings.exportOptions.filesToExport.length > 0) 
			{
				const filesToPick = this.pickedFiles?.map(file => file.path) ?? Settings.exportOptions.filesToExport;
				this.filePicker.setSelectedFiles(filesToPick);
			}

			const saveFiles = new Setting(this.filePickerModalEl).addButton((button) => 
			{
				button.setButtonText(lang.filePicker.save).onClick(async () =>
				{
					Settings.exportOptions.filesToExport = this.filePicker.getSelectedFilesSavePaths();
					await SettingsPage.saveSettings();
				});
			});

			saveFiles.settingEl.style.border = "none";
			saveFiles.settingEl.style.marginRight = "1em";
		}


		const { contentEl } = this;

		contentEl.empty();

		this.titleEl.setText(ExportModal.title);

		const modeDescriptions = 
		{
			"online": lang.exportMode.online,
			"local": lang.exportMode.local,
			"raw-documents":  lang.exportMode.rawDocuments
		}

		const exportModeSetting = new Setting(contentEl)
			.setName(lang.exportMode.title)
			// @ts-ignore
			.setDesc(modeDescriptions[Settings.exportPreset])
			.setHeading()
			.addDropdown((dropdown) => dropdown
				.addOption('online', 'Online Website')
				.addOption('local', 'Local Website')
				.addOption('raw-documents', 'Raw HTML Documents')
				.setValue(["online", "local", "raw-documents"].contains(Settings.exportPreset) ? Settings.exportPreset : 'website')
				.onChange(async (value) =>
				{
					Settings.exportPreset = value as ExportPreset;

					switch (value) {
						case 'online':
							await Settings.onlinePreset();
							break;
						case 'local':
							await Settings.localPreset();
							break;
						case 'raw-documents':
							await Settings.rawDocumentsPreset();
							break;
					}

					this.open();
				}
				));
		exportModeSetting.descEl.style.whiteSpace = "pre-wrap";
		exportModeSetting.settingEl.style.paddingRight = "1em";

		

		// add purge export button
		new Setting(contentEl)
			
			.addButton((button) => button
			.setButtonText(lang.purgeExport.clearCache)
			.onClick(async () =>
			{
				// create a modal to confirm the deletion
				const confirmModal = new Modal(app);
				confirmModal.titleEl.setText(lang.purgeExport.confirmation);
				let warning = confirmModal.contentEl.createEl('p', { text: lang.purgeExport.clearWarning });
				warning.style.whiteSpace = "pre-wrap";
				confirmModal.open();

				new Setting(confirmModal.contentEl)
				.addButton((button) => button
				.setButtonText(i18n.cancel)
				.onClick(() => confirmModal.close()))
				.addButton((button) => button
				.setButtonText(lang.purgeExport.clearCache)
				.onClick(async () =>
				{
					const path = new Path(Settings.exportOptions.exportPath);
					const website = await new Website(path).load();
					await website.index.clearCache();
					confirmModal.close();
				}));
			})).setDesc(lang.purgeExport.description);

		

		createToggle(contentEl, lang.openAfterExport, () => Settings.openAfterExport, (value) => Settings.openAfterExport = value);

		new Setting(contentEl)
			.setDesc("Server files are stored in .archivatorium inside this vault.")
			.addButton((button) => {
			button.setButtonText(lang.exportButton).onClick(async () => 
			{
				this.canceled = false;
				this.close();
			});
		});

		this.filePickerModalEl.style.height = this.modalEl.clientHeight * 2 + "px";

		new Setting(contentEl)
		.setDesc(lang.moreOptions)
		.addExtraButton((button) => button.setTooltip('Open plugin settings').onClick(() => {
			//@ts-ignore
			app.setting.open();
			//@ts-ignore
			app.setting.openTabById('archivatorium-web-export');
		}));

		await Utils.waitUntil(() => this.isClosed, 60 * 60 * 1000, 10);
		
		this.pickedFiles = this.filePicker.getSelectedFiles();
		this.filePickerModalEl.remove();
		this.exportInfo = { canceled: this.canceled, pickedFiles: this.pickedFiles, exportPath: new Path(Settings.exportOptions.exportPath), validPath: this.validPath};

		return this.exportInfo;
	}

	onClose() 
	{
		const { contentEl } = this;
		contentEl.empty();
		this.isClosed = true;
		ExportModal.title = i18n.exportModal.title;
	}
}
