import { writable, get } from "svelte/store";

/** @type {import("svelte/store").Writable<"settings" | "dbConfig" | null>} */
export const showingModal = writable(null);

window?.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		showingModal.set(null);
	}
});

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
export const oscConfig = localStorageWritable("oscConfig", {});
export const msConfig = localStorageWritable("msConfig", {});
export const m7clConfig = localStorageWritable("m7clConfig", {});

/** @type {import("svelte/store").Writable<{ flipSceneOrder: boolean }>} */
export const appConfig = localStorageWritable("appConfig", {});

/** @type {import("svelte/store").Writable<import("./connection").BaseConnection>} */
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

export const toasts = writable([]);
/** @param {"info"|"warn"|"error"} type */
export function makeToast(title, message, type = "info") {
	toasts.update((toasts) => {
		toasts.push({ title, message, type, id: Date.now() });
		return toasts;
	});
}

if (window) window.makeToast = makeToast;
