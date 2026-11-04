export type Heading = [level: number, text: string, line: number];

export interface VaultFile {
	path: string;
	mtime: number;
	tags: string[];
	headings: Heading[];
}

export interface VaultIndex {
	generatedAt: number;
	vault: string;
	vaultPath: string;
	files: VaultFile[];
	folders: string[];
}

export interface VaultLocation {
	name: string;
	path: string;
}
