import { get } from "svelte/store";
import {
	ConnectionStatusEnum,
	channelOverrides,
	currentConnection,
	currentConnectionStatus,
	makeToast,
} from "../stores";
import type { BaseColor, BaseConnectionConfig, Scene } from "../types";

export abstract class BaseConnection {
	static name: string;
	static fullName: string;
	private lastFiredDcas: Scene["dcas"] | undefined;

	constructor() {
		// reset status but keep reconnecting indicator if set
		currentConnectionStatus.set({ status: ConnectionStatusEnum.CONNECTING, address: null });
	}

	onFire(scene: Scene): void {
		const start = performance.now();
		if (scene?.mics) {
			const overrides = get(channelOverrides);

			const sendNum =
				Math.round(
					Math.min(Math.max((this.constructor as typeof BaseConnection).getCompleteConfig().resendNum || 0, 0), 4)
				) + 1;
			console.log("sending", sendNum, "times");

			let overrideToast = "";

			for (let sends = 0; sends < sendNum; sends++) {
				let sentDCANames = false;
				scene.mics.forEach((mic, channelNum) => {
					if (mic) {
						if (channelNum < 1) {
							console.warn(`channel ${channelNum} is not a valid channel number`);
							return;
						}

						let overrideDisableControl = overrides?.[channelNum]?.disableControl;
						if (overrideDisableControl) {
							console.log(`channel ${channelNum} is disabled`);
							return; // don't mess with this channel as another could be swapped to it and then overwrite
						}
						let newChannelNum: number | null = null;
						if (overrides?.[channelNum]?.channelNumber && overrides[channelNum].channelNumber > 0) {
							newChannelNum = overrides[channelNum].channelNumber;
						}
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

						if (scene.dcas && scene.dcas.size > 0) {
							if (scene.dcas !== this.lastFiredDcas) {
								for (const [dca, { mics, name }] of scene.dcas) {
									// even if channel is not in dca, we must make sure the dca is clear
									// todo: only fire CHANGED dcas, not all
									this._fireDCA(channelNum, dca, mics.has(channelNum));

									// only send DCA names on first iteration
									if (!sentDCANames) this._nameDCA(dca, name);
								}
							} else console.log("DCAs not refiring, same as last scene");
							sentDCANames = true;
						}
					}
				});
				this._flush();
			}

			this.lastFiredDcas = scene.dcas;

			if (overrideToast) makeToast("overrides active", overrideToast, "info");
		}
		const end = performance.now();
		console.log(`fire took ${end - start} ms`);
	}

	/**
	 * triggered for each channel to update it on fire
	 * @param channel channel number
	 * @param active should be unmuted, null if control disabled
	 * @param name channel strip name
	 * @param color base color id
	 */
	protected _fireChannel(channel: number, active: boolean | null, name: string, color: BaseColor): void {
		console.warn("BaseConnection._fireChannel not implemented, please override in subclass");
	}

	protected _fireDCA(channel: number, dca: number, include: boolean): void {
		console.warn("assigning DCAs not implemented");
	}

	protected _nameDCA(dca: number, name: string): void {
		console.warn("naming DCAs not implemented");
	}

	/** for connections that pool data, ensures any queued data is sent */
	protected _flush(): void {}

	tools: Record<string, () => void | Promise<any>> = {};

	/** returns the complete configuration for this connection type */
	static getCompleteConfig(): BaseConnectionConfig {
		return {
			// placeholder values for anything handled in this file across connection types
			resendNum: 0,
			autoReconnect: false,
			liveMetersEnabled: false,
		};
	}

	/** gracefully close, for when the user wants to close it */
	close(ungraceful: boolean = false): void {
		if (ungraceful !== true) {
			currentConnection.set(null); // unregister self for handling fires
			currentConnectionStatus.set({ status: ConnectionStatusEnum.DISCONNECTED, address: null }); // clear state
		}
	}

	protected _onSocketClose(): void {
		// try autoreconnecting if we shouldn't have been disconnected
		if (get(currentConnection) === this) {
			const willAutoReconnect = (this.constructor as typeof BaseConnection).getCompleteConfig().autoReconnect;
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
						currentConnection.set(new (this.constructor as new () => BaseConnection)());
						// makeToast("Mixer Reconnecting", "", "warn"); // don't need to remind every time as light turns yellow and a new disconnect warning appears
					}
					// delay to not ddos in case something goes horrifically wrong
				}, 1000);
		}
		// else we've closed as a new connection has taken over, let it do its thing
	}
}
