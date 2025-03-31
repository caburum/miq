import { get, writable } from "svelte/store";
import { connectionMode, currentConnection, currentConnectionStatus, oscConfig, msConfig, m7clConfig } from "./stores";
import { OSCConnection } from "./osc";
import { MixingStationConnection } from "./mixing-station";
import { M7CLConnection } from "./m7cl";

export const connectors = {
	osc: OSCConnection,
	ms: MixingStationConnection,
	m7cl: M7CLConnection,
};

const updateAddress = () => {
	const currentAddress = get(currentConnectionStatus).address;
	if (currentAddress) return connectionAddress.set(currentAddress);

	const mode = get(connectionMode);
	const config = connectors[mode]?.getCompleteConfig() || null;

	return connectionAddress.set((config?.host || "") + (config?.port ? `:${config?.port}` : ""));
};
export const connectionAddress = writable(null);

// update the probable next address anytime any connection stuff changes
currentConnectionStatus.subscribe(updateAddress);
connectionMode.subscribe(updateAddress);
oscConfig.subscribe(updateAddress);
msConfig.subscribe(updateAddress);
m7clConfig.subscribe(updateAddress);

export function newConnection() {
	const mode = get(connectionMode);
	currentConnection.set(connectors[mode] ? new connectors[mode]() : null);
}
