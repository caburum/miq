import { writable, get } from "svelte/store";

/** @type {import("svelte/store").Writable<"settings" | "dbConfig" | null>} */
export const showingModal = writable(null);

/**
 * @template T
 * @param {string} key
 * @param {T} defaultValue
 * @returns {import("svelte/store").Writable<T>}
 */
function localStorageWritable(key, defaultValue) {
	const store = writable(JSON.parse(localStorage.getItem(key)) || defaultValue);
	store.subscribe((value) => localStorage.setItem(key, JSON.stringify(value)));
	return store;
}

export const selectedConfigId = localStorageWritable("selectedConfig", null);

export const mqttConfig = localStorageWritable("mqttConfig", {
	mode: "tx",
	rx_preview: true,
	rx_live: false,
});
export const mqttStatus = writable({ connected: false, address: null });

/** @type {import("svelte/store").Writable<keyof typeof import("./connectionUtil").connectors>} */
export const connectionMode = localStorageWritable("connectionMode", "osc");
/** @type {import("svelte/store").Writable<import("./types").OSCConfig>} */
export const oscConfig = localStorageWritable("oscConfig", {});
/** @type {import("svelte/store").Writable<import("./types").MixingStationConfig>} */
export const msConfig = localStorageWritable("msConfig", {});
/** @type {import("svelte/store").Writable<import("./types").M7CLConfig>} */
export const m7clConfig = localStorageWritable("m7clConfig", {});

/** @type {import("svelte/store").Writable<{ flipSceneOrder: boolean }>} */
export const appConfig = localStorageWritable("appConfig", {});

/** @type {import("svelte/store").Writable<import("./baseConnection").BaseConnection>} */
export const currentConnection = writable(null);

/** @enum {number} */
export const ConnectionStatusEnum = /** @type {const} */ ({
	DISCONNECTED: 0,
	// truthy values are not disconnected
	CONNECTED: 1,
	CONNECTING: 2,
});
/** @type {import("svelte/store").Writable<{status: typeof ConnectionStatusEnum[keyof typeof ConnectionStatusEnum], address: string | null}>} */
export const currentConnectionStatus = writable({ status: ConnectionStatusEnum.DISCONNECTED, address: null });

// disconnect when switching modes
let lastConnectionMode = null;
connectionMode.subscribe((mode) => {
	if (mode !== lastConnectionMode) {
		lastConnectionMode = mode;
		get(currentConnection)?.close();
	}
});

/** @type {import("svelte/store").Writable<{ [key: number]: { disableControl?: boolean, channelNumber?: number } }>} */
export const channelOverrides = writable({});

/** @type {import("svelte/store").Writable<Float32Array>} */
export const channelMeters = writable([]);

/** @type {import("svelte/store").Writable<{ title: string, message: string, type: "info" | "warn" | "error", id: number }>} */
export const toasts = writable([]);
/** @param {"info" | "warn" | "error"} type */
export function makeToast(title, message, type = "info") {
	toasts.update((toasts) => {
		toasts.push({ title, message, type, id: Date.now() });
		return toasts;
	});
}

if (window) window.makeToast = makeToast;
