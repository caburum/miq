import Dexie from "dexie";
import Papa from "papaparse";
import { derived, get, writable, type Readable } from "svelte/store";
import { makeToast, selectedConfigId } from "./stores";

export const ddp = {
	notesRow: 0,
	namesRow: 1,
	flagsRow: 2,
	micsStartRow: 3,

	// referenceCol: 0,
	actorNamesCol: 1,
	scenesStartCol: 2,
};

export type Table = string[][];

export interface Config {
	id: number | string; // number for db configs, string for external configs
	name: string;

	notesRow: number;
	namesRow: number;
	flagsRow: number;
	micsStartRow: number;
	actorNamesCol: number;
	scenesStartCol: number;

	source: "google-sheets" | "file";
	sheetId?: string;
	fileHandle?: FileSystemFileHandle;

	table?: Table;
	lastFetched?: Date;
}

export interface DbConfig extends Config {
	id: number;
}

export interface ExternalConfig extends Config {
	id: string;
}

export const db = new Dexie("miq") as Dexie & {
	configs: Dexie.Table<DbConfig, number>;
};
db.version(1).stores({
	configs: "++id, name",
	sheets: "++id",
});
db.version(2)
	.stores({
		configs: "++id",
		sheets: null,
	})
	.upgrade((tx) => {
		return tx
			.table<
				{
					id: number;
					name: string;
					sheetId: string;
					lastFetched?: Date;
					table?: Table;
				},
				number
			>("sheets")
			.toArray()
			.then((sheets) => {
				const sheetMap = new Map(sheets.map((sheet) => [sheet.id, sheet]));

				return tx
					.table<
						Record<string, any> & {
							sheetId?: number;
						},
						number
					>("configs")
					.toCollection()
					.modify((config) => {
						let sid = config.sheetId;
						if (sid) {
							const sheet = sheetMap.get(sid);

							if (sheet) {
								const { id, name, ...sheetProps } = sheet;
								Object.assign(config, sheetProps);
							}
						}
					});
			})
			.then(() => {
				makeToast("Database migrated", "sheets data merged into configs", "info");
			})
			.catch((e) => {
				makeToast("Database error", e, "error");
			});
	});
db.version(3).upgrade((tx) => {
	return tx
		.table("configs")
		.toCollection()
		.modify((config) => {
			// new required field
			config.source = "google-sheets";
		});
});

function dexieStore<T>(querier: () => T | Promise<T>, initialValue: T): Readable<T> {
	const dexieObservable = Dexie.liveQuery(querier);
	return {
		subscribe(run, invalidate) {
			run(initialValue);
			return dexieObservable.subscribe(run, invalidate).unsubscribe;
		},
	};
}

export const storedConfigs = dexieStore(async () => await db.configs.toArray(), []);
export const externalConfigs = writable<{ [s: string]: ExternalConfig }>({});

export const configs = derived([storedConfigs, externalConfigs], ([$storedConfigs, $externalConfigs]) => [
	...($storedConfigs || []),
	...Object.keys($externalConfigs).map(
		(id) =>
			({
				...$externalConfigs[id],
				id,
			} as ExternalConfig)
	),
]);

async function _parseSheet(source: string | File, options: object): Promise<Table> {
	return new Promise<Table>((resolve, reject) => {
		Papa.parse<string[]>(source, {
			download: true,
			header: false,
			complete: function (results) {
				if (results.data && results.data.length > 0 && results.data[0]?.length > 0) {
					resolve(results.data);
				} else {
					reject(new Error("No data found in the sheet"));
				}
			},
			error: function (error) {
				reject(error);
			},
		});
	});
}

const parseSheetFromUrl = (sheetId: string) =>
	_parseSheet(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`, { download: true });
const parseSheetFromFile = (file: File) => _parseSheet(file, { download: false });

export async function loadExternalConfig(
	id: string,
	source: string,
	config: Omit<Config, "sheetId"> & { sheetId?: string }
) {
	// make sure config contains all the required fields
	if (!config || !(config.sheetId || config.table)) {
		console.error("No config provided");
		return;
	}
	let newConfig = {
		...config,
		notesRow: config.notesRow ?? ddp.notesRow,
		namesRow: config.namesRow ?? ddp.namesRow,
		flagsRow: config.flagsRow ?? ddp.flagsRow,
		micsStartRow: config.micsStartRow ?? ddp.micsStartRow,
		actorNamesCol: config.actorNamesCol ?? ddp.actorNamesCol,
		scenesStartCol: config.scenesStartCol ?? ddp.scenesStartCol,
		name: source + ": " + (config.name ?? "Unnamed Config"),
		id: id,
	};
	if (!newConfig.table) {
		const table = await parseSheetFromUrl(newConfig.sheetId!);
		newConfig.table = table;
	}
	externalConfigs.update((configs) => {
		return { ...configs, [id]: newConfig };
	});
	selectedConfigId.update(() => id);
	makeToast("Loaded external config", `${newConfig.name}`, "info");
}

/** refetches and updates a sheet */
export async function updateSheet<T extends DbConfig | ExternalConfig>(id: T["id"]) {
	const isExternal = typeof id === "string";

	let editing = isExternal ? get(externalConfigs)[id] : await db.configs.get(id);

	let record = { ...editing, lastFetched: new Date() } as T;

	if (editing?.source === "file") {
		const fileHandle = editing.fileHandle;
		if (!fileHandle) throw makeToast("No file selected", "", "error");
		// browser should be supported if we have a handle

		const options = { mode: "read" };
		if ((await (fileHandle as any).queryPermission?.(options)) !== "granted") {
			if ((await (fileHandle as any).requestPermission?.(options)) !== "granted") {
				throw makeToast("File permission not granted", String(editing.fileHandle?.name), "error");
			}
		}

		const file = await editing.fileHandle?.getFile();
		if (!file) throw makeToast("Failed accessing file", String(editing.fileHandle?.name), "error");

		record.table = await parseSheetFromFile(file);
	} else if (editing?.source === "google-sheets") {
		if (!editing?.sheetId) throw makeToast("No sheetId configured", "", "error");
		record.table = await parseSheetFromUrl(editing.sheetId);
	}

	isExternal
		? externalConfigs.update((configs) => {
				return { ...configs, [id]: record as ExternalConfig };
		  })
		: await db.configs.update(id, record as DbConfig);

	makeToast("Sheet updated", `"${editing?.name}"`, "info");

	return record;
}
