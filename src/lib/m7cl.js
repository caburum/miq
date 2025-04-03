import { get, writable } from "svelte/store";
import { channelMeters, makeToast, m7clConfig, currentConnectionStatus, ConnectionStatusEnum } from "./stores";
import { BaseConnection } from "./baseConnection";

export class M7CLConnection extends BaseConnection {
	static name = "M7CL (MIDI)";

	/** @type {MIDIOutput | undefined} */ output;
	/** @type {MIDIInput | undefined} */ input;
	/** @type {ReturnType<typeof setInterval>} */ liveRequestInterval;
	/** @type {import('./types').M7CLConfig} */ config;

	constructor() {
		super();

		this.config = M7CLConnection.getCompleteConfig();

		if (!navigator.requestMIDIAccess) {
			makeToast("WebMIDI unsupported", "", "error");
			return;
		}

		navigator.requestMIDIAccess({ sysex: true }).then(
			(access) => {
				this.access = access;
				this.output = this._chooseDevice(access.outputs, this.config.host);

				if (!this.output) {
					currentConnectionStatus.set({
						status: ConnectionStatusEnum.DISCONNECTED,
					});
					return;
				}

				this.output.addEventListener("statechange", this._onstatechange.bind(this));

				if (this.config.liveMetersEnabled) {
					this.input = this._chooseDevice(access.inputs, this.config.inputHost);
					if (this.input) {
						this.input.addEventListener("midimessage", this._onmidimessage.bind(this));

						this.liveRequestInterval = setInterval(this._requestMetering.bind(this), 10_000);
						this._requestMetering();
					} else {
						makeToast("No input device found for live metering", "", "warn");
					}
				}

				currentConnectionStatus.set({
					status: ConnectionStatusEnum.CONNECTED,
					address: this.output.id + (this.input ? `/${this.input.id}` : ""),
				});

				window.output = this.output; // for debugging
				window.input = this.input; // for debugging
			},
			() => {
				makeToast("MIDI access request error", "", "error");
			}
		);
	}

	/**
	 * @function
	 * @template {MIDIOutput | MIDIInput} T
	 * @param {ReadonlyMap<string, T>} map
	 * @param {string} defaultHost
	 * @returns {T | null}
	 */
	_chooseDevice(map, defaultHost) {
		let device = map.get(defaultHost);

		if (!device) {
			chosen: {
				for (let d of map.values()) {
					let name = `${d.type} '${d.id}' (name: ${d.name}, manufacturer: ${d.manufacturer}, version: ${d.version})`;
					console.log(name);

					// todo: better implement picker
					if (map.size == 1 || confirm(`Use ${name}?`)) {
						device = d;
						break chosen;
					}
				}

				return null;
			}
		}

		return device;
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
			makeToast(`MIDI ${port.type} disconnected`, "", "error");
			// if (port.type === "output") this.close(true);
		}
	}

	// prettier-ignore
	static meterToLevel = [-95, -94, -93, -92, -91.5, -91, -90.5, -90, -89, -88, -87, -86, -85.5, -85, -84.5, -84, -83, -82, -81, -80, -79.5, -79, -78.5, -78, -77, -76, -75, -74, -73.5, -73, -72.5, -72, -71, -70, -69, -68, -67.6, -67, -66.5, -66, -65, -64, -63, -62, -61.5, -61, -60.5, -60, -59, -58, -57, -56, -55.5, -55, -54.5, -54, -53, -52, -51, -50, -49.5, -49, -49.5, -48, -47, -46, -45, -44, -43.5, -43, -42.5, -42, -41, -40, -39, -38, -37.5, -37, -36.5, -36, -35, -34, -33, -32, -31.5, -31, -30.5, -30, -29, -28, -27, -26, -25.5, -25, -24.5, -24, -23, -22, -21, -20, -19.5, -19, -18.5, -18, -17, -16, -15, -14, -13.5, -13, -12.5, -12, -11, -10, -9, -8, -7.5, -7, -6.5, -6, -5, -4, -3, -2, -1.5, -1, 0, 0];

	_onmidimessage(/** @type {MIDIMessageEvent} */ { data }) {
		// then receive
		let format = [
			0xf0, // system exclusive
			0x43, // manufacturer id
			0x10, // midi channel 0
			0x3e, // digital mixer
			0x11, // M7CL
			0x21, // remote level meter
			// category
			// metering point
			// start channel
			// ...level, 1 per channel
			0xf7,
		];
		if (data[0] !== 0xf0 || data[1] !== 0x43 || data[3] !== 0x3e || data[4] !== 0x11 || data[5] !== 0x21) return;

		let levels = new Float32Array(data.slice(9, -1));
		for (let i = 0; i < levels.length; i++) {
			// levels[i] =
			// 	(10 ** (M7CLConnection.meterToLevel[levels[i]] / 10) - 10 ** (-95 / 10)) / (10 ** (0 / 10) - 10 ** (-95 / 10));

			levels[i] = Math.pow(1 - M7CLConnection.meterToLevel[levels[i]] / -95, 2);
		}

		channelMeters.set(levels);
	}

	_requestMetering() {
		this.output.send([
			0xf0, // system exclusive
			0x43, // manufacturer id
			0x30, // midi channel 0
			0x3e, // digital mixer
			0x11, // M7CL
			0x21, // remote level meter
			0x00, // category
			this.config.liveMeterPoint, // metering point
			0x00, // start channel
			0x00, // count H
			56, // count L
			0xf7,
		]);
	}

	/** @enum {number} */
	static MeterPointEnum = /** @type {const} */ ({
		PRE_HPF: 0x00,
		PRE_ATT: 0x01,
		POST_EQ: 0x02,
		POST_DYN1: 0x03,
		POST_DYN2: 0x04,
		POST_ON: 0x05,
		PRE_FADER: 0x06,
		DYN1_GAIN_REDUCTION: 0x07,
		DYN2_GAIN_REDUCTION: 0x08,
	});

	static getCompleteConfig() {
		const config = get(m7clConfig);
		return {
			...BaseConnection.getCompleteConfig(),
			...config,
			host: config.host || null,
			inputHost: config.inputHost || null,
			liveMetersEnabled: config.liveMetersEnabled ?? false,
			liveMeterPoint: config.liveMeterPoint ?? this.MeterPointEnum.PRE_FADER,
		};
	}

	close(ungraceful = false) {
		super.close(ungraceful);
		this.output?.removeEventListener("statechange", this._onstatechange);
		this.output?.close();
		this.input?.removeEventListener("midimessage", this._onmidimessage);
		this.input?.close();
		clearInterval(this.liveRequestInterval);
	}
}
