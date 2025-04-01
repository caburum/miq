import { get, writable } from "svelte/store";
import { makeToast, m7clConfig, currentConnectionStatus, ConnectionStatusEnum } from "./stores";
import { BaseConnection } from "./baseConnection";

export class M7CLConnection extends BaseConnection {
	static name = "M7CL (MIDI)";

	/** @type {MIDIOutput | undefined} */ output;

	constructor() {
		super();

		const config = M7CLConnection.getCompleteConfig();

		if (!navigator.requestMIDIAccess) {
			makeToast("WebMIDI unsupported", "", "error");
			return;
		}

		navigator.requestMIDIAccess().then(
			(access) => {
				this.access = access;

				this.output = access.outputs.get(config.host);

				if (!this.output) {
					chosen: {
						for (let output of access.outputs.values()) {
							let device = `'${output.id}' (name: ${output.name}, manufacturer: ${output.manufacturer}, version: ${output.version})`;
							console.log(device);

							// todo: better implement picker
							if (access.outputs.size == 1 || confirm(`Use device ${device}?`)) {
								this.output = output;
								break chosen;
							}
						}

						currentConnectionStatus.set({
							status: ConnectionStatusEnum.DISCONNECTED,
						});
						return;
					}
				}

				currentConnectionStatus.set({
					status: ConnectionStatusEnum.CONNECTED,
					address: this.output.id,
				});

				this.output.addEventListener("statechange", this._onstatechange);
			},
			() => {
				makeToast("MIDI access request error", "", "error");
			}
		);
	}

	_fireChannel(channel, active, name, color) {
		// https://jp.yamaha.com/files/download/other_assets/7/323187/m7clv3_en_om_i0.pdf p274,282
		// M7CL has 48 mono input channels and 8 channels of stereo inputs
		// 0 is channel 1, 55 is ST INPUT 4R
		let address = 0x05b6 + channel - 1;
		if (address >= 0x05ed) {
			makeToast("Channel out of range", channel, "error");
			return;
		}

		if (active !== null)
			this.output.send([
				// NRPN LSB (lower 7 bits)
				0xb0,
				0x62,
				address & 0x7f,

				// NRPN MSB (upper 7 bits)
				0xb0,
				0x63,
				(address >> 7) & 0x7f,

				// data MSB
				0xb0,
				0x06,
				active ? 127 : 0,

				// data LSB (ON)
				0xb0,
				0x26,
				active ? 127 : 0,
			]);
	}

	_onstatechange(/** @type {MIDIConnectionEvent} */ { port }) {
		if (port.state === "disconnected") {
			makeToast("MIDI device disconnected", "", "error");
			this.close(true);
		}
	}

	static getCompleteConfig() {
		const config = get(m7clConfig);
		return {
			...BaseConnection.getCompleteConfig(),
			...config,
			host: config.host || null,
		};
	}

	close(ungraceful = false) {
		super.close(ungraceful);
		this.output?.removeEventListener("statechange", this._onstatechange);
		this.output?.close();
	}
}
