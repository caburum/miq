import { derived, get } from "svelte/store";
import { configs, type Config } from "./db";
import { regenerateScenes } from "./scenes";
import { selectedConfigId } from "./stores";

type ConfigId = Config["id"] | null;

export { selectedConfigId };

export const selectedConfig = derived(
	[configs, selectedConfigId],
	([$configs, $selectedConfigId]) => ($configs || []).find((config) => config.id === $selectedConfigId) || null
);

// export const table = derived([selectedConfig], ([$selectedConfig]) => $selectedConfig?.table || []);

export const scenes = derived(
	[selectedConfig],
	([$selectedConfig]) => ($selectedConfig && regenerateScenes($selectedConfig)) || []
);

export let currentIndex = $state({
	index: -1,
	config: null as ConfigId,
});

selectedConfigId.subscribe((id) => {
	if (id !== currentIndex.config) {
		currentIndex.index = -1;
		currentIndex.config = id;
	}
});

export function getCurrentScene() {
	if (currentIndex.index < 0) return null;
	return get(scenes)[currentIndex.index] || null;
}

export function getTrackedMics() {
	// todo: store in metadata when loading all scenes?
	return Array.from(get(scenes)?.[0]?.mics?.keys() || []);
}
