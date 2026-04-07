import { ddp, type Config } from "./db";
import { makeToast } from "./stores";
import type { Scene, SceneConfigKey } from "./types";

const isMic = (micNum: number | undefined): micNum is number =>
	typeof micNum == "number" && !Number.isNaN(micNum) && micNum > 0;

export function regenerateScenes(selectedConfig: Config) {
	console.log("regenerating scenes");

	const config = {
		notesRow: selectedConfig.notesRow ?? ddp.notesRow,
		namesRow: selectedConfig.namesRow ?? ddp.namesRow,
		flagsRow: selectedConfig.flagsRow ?? ddp.flagsRow,
		micsStartRow: selectedConfig.micsStartRow ?? ddp.micsStartRow,
		actorNamesCol: selectedConfig.actorNamesCol ?? ddp.actorNamesCol,
		scenesStartCol: selectedConfig.scenesStartCol ?? ddp.scenesStartCol,
	};

	if (selectedConfig.table && selectedConfig.table.length > 0 && selectedConfig.table[0]?.length > 0) {
		let table = selectedConfig.table;
		let newScenes: Scene[] = [];
		let actorMicPairs = new Map<number, { row: number; actor: string }>();
		let lastDcaAssignments: Scene["dcas"] = undefined; // same map object may be shared across scenes, only replaced when modified

		function generateActorMicPairs(col: number) {
			for (let j = config.micsStartRow; j < table.length; j++) {
				const micNum = parseInt(table[j][col]);
				if (isMic(micNum)) {
					actorMicPairs.set(micNum, {
						row: j,
						actor: table[j][config.actorNamesCol],
					});
				}
			}
		}

		function generateDCAChange(col: number) {
			let map: Scene["dcas"] = new Map();

			// previously used DCAs should be cleared
			if (lastDcaAssignments) {
				for (const dca of lastDcaAssignments.keys()) {
					map.set(dca, { name: "", mics: new Set() });
				}
			}

			for (let j = config.micsStartRow; j < table.length; j++) {
				const micNum = Array.from(actorMicPairs.entries()).find(([_channel, { row }]) => row === j)?.[0];
				if (!isMic(micNum)) continue;

				const dcasOfChannel = table[j][col]
					.split(",")
					.map((row) => {
						const match = /^(\d+)(?:\s+(.+))?$/.exec(row.trim());
						if (match) return [Number.parseInt(match[1]), match[2] || ""] as const;
					})
					.filter((row): row is [number, string] => row !== undefined && !isNaN(row[0]));

				for (const [dca, name] of dcasOfChannel) {
					if (!map.has(dca)) map.set(dca, { name: "", mics: new Set() });
					const dcaEntry = map.get(dca);
					dcaEntry?.mics.add(micNum);
					if (name && dcaEntry) dcaEntry.name = name;
				}
			}

			lastDcaAssignments = Object.freeze(map);
		}

		for (let i = config.scenesStartCol; i < table[0].length; i++) {
			let configMode = table[config.flagsRow][i].trim() as SceneConfigKey;

			switch (configMode) {
				case "MIC_CHANGE":
				case "MIC":
					generateActorMicPairs(i);
					continue;

				case "DCA":
					generateDCAChange(i);
					continue;

				case "":
					// treat as mute/unmute
					break;

				default:
					makeToast("invalid miq flag", `column ${i}: ${configMode}`, "warn");
			}

			let mics: Scene["mics"] = new Map();
			actorMicPairs.forEach(({ row, actor }, micNum) => {
				mics.set(micNum, {
					actor: actor,
					character: table[row][i],
					active: table[row][i].trim() !== "" && table[row][i].trim().slice(0, 2) !== "//",
					// row, // todo: determine useful information to store to reconstruct the sheet later
				});
			});
			newScenes.push({
				notes: table[config.notesRow][i],
				name: table[config.namesRow][i],
				mics,
				dcas: lastDcaAssignments,
			});
		}

		// backward pass
		let backwardPassMem = new Map<number, string>();
		newScenes.reverse();
		newScenes.forEach((scene) => {
			scene.mics.forEach((mic, micNum) => {
				let mem = backwardPassMem.get(micNum);

				if (mem && !mic.active) {
					mic.actor = mem;
				} else {
					backwardPassMem.set(micNum, mic.actor);
				}
			});
		});

		// forward pass
		let forwardPassMem = new Map<number, string>();
		newScenes.reverse();
		newScenes.forEach((scene) => {
			scene.mics.forEach((mic, micNum) => {
				let mem = forwardPassMem.get(micNum);

				if (mem && !mic.active && mem !== mic.actor) {
					mic.switchingFrom = mem;
				} else {
					forwardPassMem.set(micNum, mic.actor);
				}
			});
		});

		return newScenes;
	} else {
		return [];
	}
}
