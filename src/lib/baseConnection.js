import {
	currentConnection,
	currentConnectionStatus,
	ConnectionStatusEnum,
	channelOverrides,
	makeToast,
} from "../lib/stores";
import { get } from "svelte/store";

/**
 * @typedef BaseColor
 * @type {"RED" | "CYAN" | "MAGENTA"}
 * these
 */

export class BaseConnection {
	static name = null;

	constructor() {
		// reset status but keep reconnecting indicator if set
		currentConnectionStatus.set({ status: ConnectionStatusEnum.CONNECTING, address: null });
	}

	onFire(scene) {
		if (scene?.mics) {
			const overrides = get(channelOverrides);

			const sendNum = Math.round(Math.min(Math.max(this.constructor.getCompleteConfig().resendNum || 0, 0), 4)) + 1;
			console.log("sending", sendNum, "times");

			let overrideToast = "";

			for (let sends = 0; sends < sendNum; sends++) {
				Object.keys(scene.mics).forEach((channel) => {
					let mic = scene.mics[channel];
					if (mic) {
						let channelNum = parseInt(channel);

						let overrideDisableControl = overrides?.[channelNum]?.disableControl;
						if (overrideDisableControl) {
							console.log(`channel ${channelNum} is disabled`);
							return; // don't mess with this channel as another could be swapped to it and then overwrite
						}

						let newChannelNum = null;
						if (overrides?.[channelNum]?.channelNumber > 0) newChannelNum = overrides[channelNum].channelNumber;
						if (mic.active && newChannelNum && newChannelNum != channelNum)
							overrideToast += `fired #${channelNum} as #${newChannelNum}\n`;

						// todo: allow combining multiple starting codes (?, #)
						let sheetDisableControl = mic.character.startsWith("?"); // intended to be disabled

						this._fireChannel(
							newChannelNum ?? channelNum,
							sheetDisableControl ? null : mic.active,
							mic.character.startsWith("#") ? mic.actor : mic.character || mic.actor,
							sheetDisableControl ? "MAGENTA" : mic.active ? "CYAN" : "RED"
						);
					}
				});
			}

			if (overrideToast) makeToast("overrides active", overrideToast, "info");
		}
	}

	/**
	 * triggered for each channel to update it on fire
	 * @param {number} channel channel number
	 * @param {boolean | null} active should be unmuted, null if control disabled
	 * @param {string} name channel strip name
	 * @param {BaseColor} color base color id
	 */
	_fireChannel(channel, active, name, color) {}

	/** @returns {import('./types').BaseConnectionConfig} */
	static getCompleteConfig() {
		return {
			// placeholder values for anything handled in this file across connection types
			resendNum: 0,
			autoReconnect: false,
			liveMetersEnabled: false,
		};
	}

	/** gracefully close, for when the user wants to close it */
	close(ungraceful = false) {
		// don't do this for something ungraceful
		if (ungraceful !== true) {
			currentConnection.set(null); // unregister self for handling fires
			currentConnectionStatus.set({ status: ConnectionStatusEnum.DISCONNECTED, address: null }); // clear state
		}
	}

	_onSocketClose() {
		// try autoreconnecting if we shouldn't have been disconnected
		if (get(currentConnection) === this) {
			const willAutoReconnect = this.constructor.getCompleteConfig().autoReconnect;
			makeToast(
				"Mixer disconnected unexpectedly",
				willAutoReconnect ? "Auto Reconnect is enabled" : "Auto Reconnect is disabled",
				willAutoReconnect ? "warn" : "error"
			);
			currentConnectionStatus.set({
				status: willAutoReconnect ? ConnectionStatusEnum.CONNECTING : ConnectionStatusEnum.DISCONNECTED,
				address: null,
			});
			if (willAutoReconnect)
				setTimeout(() => {
					// recheck incase config changed between now and then
					if (get(currentConnection) === this) {
						currentConnection.set(new this.constructor());
						// makeToast("Mixer Reconnecting", "", "warn"); // don't need to remind every time as light turns yellow and a new disconnect warning appears
					}
					// delay to not ddos in case something goes horrifically wrong
				}, 1000);
		}
		// else we've closed as a new connection has taken over, let it do its thing
	}
}
