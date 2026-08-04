console.log('Starting export script...');

const statusPath = '/vault/.archivatorium/.docker-export-status.json';
const writeStatus = async (status, error = undefined) => {
	await require('node:fs/promises').writeFile(
		statusPath,
		JSON.stringify({ status, timestamp: new Date().toISOString(), error })
	);
};

(async () => {
	try {
		await writeStatus('running');
		console.log('Enabling plugins...');
		await this.app.plugins.setEnable(true);

		console.log('Enabling export plugin...');
		await this.app.plugins.enablePlugin('archivatorium-web-export');
		const plugin = await this.app.plugins.getPlugin('archivatorium-web-export');

		if (process.env.EXPORT_ENTIRE_VAULT) {
			console.log('Exporting entire vault...');
			await plugin.exportVault();
		} else {
			console.log('Exporting...');
			await plugin.exportDocker();
		}

		await writeStatus('completed');
		console.log('Exported');
	} catch (error) {
		console.error('Export failed:', error);
		await writeStatus('failed', String(error));
	} finally {
		// Let the docker command complete, by killing the process
		console.log('Killing obsidian process');
		require('node:process').kill(process.pid, 'SIGKILL');
		console.log('Killed'); // Should never get here
	}
})();
