import path from "node:path";

export const SERVER_DIRECTORY_NAME = ".archivatorium";

export function resolveVaultRoot(value) {
	if (!value) throw new Error("A vault path is required.");
	return path.resolve(value);
}

export function resolveServerRoot(vaultRoot) {
	return path.join(resolveVaultRoot(vaultRoot), SERVER_DIRECTORY_NAME);
}

export function resolveCorpusDatabasePath(vaultRoot) {
	return path.join(resolveServerRoot(vaultRoot), "corpus.sqlite");
}
