import { get } from "svelte/store";
import { channelMeters, ConnectionStatusEnum, currentConnectionStatus, m7clConfig, makeToast } from "../stores";
import type { BaseColor, M7CLConfig } from "../types";
import { BaseConnection } from "./baseConnection";

export class M7CLConnection extends BaseConnection {
	static name = "M7CL (MIDI)";
	static fullName = "Yamaha M7CL (MIDI)";

	output: MIDIOutput | null = null;
	input: MIDIInput | null = null;
	liveRequestInterval: ReturnType<typeof setInterval> | undefined;
	config: M7CLConfig;
	access: MIDIAccess | undefined;

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
						address: null,
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
					address: this.output.id.slice(0, 10) + (this.input ? `/${this.input.id.slice(0, 10)}` : ""),
				});

				(window as any).output = this.output; // for debugging
				(window as any).input = this.input; // for debugging
			},
			() => {
				makeToast("MIDI access request error", "", "error");
			}
		);
	}

	public getAddresses() {
		return {
			output: this.output?.id,
			input: this.input?.id,
		};
	}

	private _chooseDevice<T extends MIDIOutput | MIDIInput>(map: ReadonlyMap<string, T>, defaultHost: string): T | null {
		let device = map.get(defaultHost);

		if (!device) {
			chosen: {
				for (let d of map.values()) {
					let name = `${d.type} '${d.id}' (name: ${d.name}, manufacturer: ${d.manufacturer}, version: ${d.version})`;
					console.log(d, name);

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

	/** sanitize & map string to byte array */
	private stringToBytes(string: string) {
		return string
			.replace(/[^\x20-\x7e]/g, " ")
			.substring(0, 8)
			.padEnd(8, " ")
			.split("")
			.map((c) => c.charCodeAt(0));
	}

	override _fireChannel(channel: number, active: boolean | null, name: string, color: BaseColor): void {
		// https://jp.yamaha.com/files/download/other_assets/7/323187/m7clv3_en_om_i0.pdf p274,282
		// M7CL has 48 mono input channels and 8 channels of stereo inputs
		// 0 is channel 1, 55 is ST INPUT 4R
		channel -= 1;
		let onAddress = 0x05b6 + channel;
		if (onAddress >= 0x05ed) {
			makeToast("Channel out of range", channel.toString(), "error");
			return;
		}

		if (active !== null && this.output) {
			this.midiQueue.push(
				// NRPN LSB (lower 7 bits)
				0xb0,
				0x62,
				onAddress & 0x7f,

				// NRPN MSB (upper 7 bits)
				0xb0,
				0x63,
				(onAddress >> 7) & 0x7f,

				// data MSB
				0xb0,
				0x06,
				active ? 127 : 0,

				// data LSB (ON)
				0xb0,
				0x26,
				active ? 127 : 0
			);

			let nameBytes = this.stringToBytes(name);

			this.midiQueue.push(
				0xf0, // system exclusive
				0x43, // manufacturer id
				0x10, // paramater change, midi channel 0
				0x3e, // digital mixer
				0x11, // M7CL
				0x01, // data category
				0x01, // kNameInputChannel
				0x13, // kNameInputChannel
				0x00, // kNameShort1
				0x00, // kNameShort1
				0x00, // CH TABLE #01
				channel, // CH TABLE #01

				// pack 8-bit ascii into 7-bit midi bytes
				nameBytes[0] >> 4,
				((nameBytes[0] & 0x0f) << 3) | (nameBytes[1] >> 5),
				((nameBytes[1] & 0x1f) << 2) | (nameBytes[2] >> 6),
				((nameBytes[2] & 0x3f) << 1) | (nameBytes[3] >> 7),
				nameBytes[3] & 0x7f,

				0xf7,

				0xf0, // system exclusive
				0x43, // manufacturer id
				0x10, // paramater change, midi channel 0
				0x3e, // digital mixer
				0x11, // M7CL
				0x01, // data category
				0x01, // kNameInputChannel
				0x13, // kNameInputChannel
				0x00, // kNameShort2
				0x01, // kNameShort2
				0x00, // CH TABLE #01
				channel, // CH TABLE #01

				// pack 8-bit ascii into 7-bit midi bytes
				nameBytes[4] >> 4,
				((nameBytes[4] & 0x0f) << 3) | (nameBytes[5] >> 5),
				((nameBytes[5] & 0x1f) << 2) | (nameBytes[6] >> 6),
				((nameBytes[6] & 0x3f) << 1) | (nameBytes[7] >> 7),
				nameBytes[7] & 0x7f,

				0xf7
			);
		}
	}

	// for bulk sending of sysex messages, write to a queue before flushing to the board
	// todo: auto flush when full?
	private midiQueue: number[] = [];

	protected _fireDCA(channel: number, dca: number, include: boolean): void {
		if (!this.output) return;

		dca -= 1;
		if (dca < 0 || dca > 7) return;
		channel -= 1;
		if (channel < 0 || channel > 55) return;

		this.midiQueue.push(
			0xf0, // system exclusive
			0x43, // manufacturer id
			0x10, // paramater change, midi channel 0
			0x3e, // digital mixer
			0x11, // M7CL
			0x01, // data category
			0x00, // kInputDCA
			0x3f, // kInputDCA
			0x00, // kDCAAssign
			dca, // kDCAAssign
			0x00, // CH TABLE #01
			channel, // CH TABLE #01

			0x00,
			0x00,
			0x00,
			0x00,
			include ? 0x01 : 0x00,

			0xf7
		);
	}

	protected _nameDCA(dca: number, name: string): void {
		if (!this.output) return;

		dca -= 1;
		if (dca < 0 || dca > 7) return;

		let nameBytes = this.stringToBytes(name);

		this.midiQueue.push(
			0xf0, // system exclusive
			0x43, // manufacturer id
			0x10, // paramater change, midi channel 0
			0x3e, // digital mixer
			0x11, // M7CL
			0x01, // data category
			0x00, // kDCAName
			0x7b, // kDCAName
			0x00, // kNameShort1
			0x00, // kNameShort1
			0x00, // CH TABLE #07
			dca, // CH TABLE #07

			// pack 8-bit ascii into 7-bit midi bytes
			nameBytes[0] >> 4,
			((nameBytes[0] & 0x0f) << 3) | (nameBytes[1] >> 5),
			((nameBytes[1] & 0x1f) << 2) | (nameBytes[2] >> 6),
			((nameBytes[2] & 0x3f) << 1) | (nameBytes[3] >> 7),
			nameBytes[3] & 0x7f,

			0xf7,

			0xf0, // system exclusive
			0x43, // manufacturer id
			0x10, // paramater change, midi channel 0
			0x3e, // digital mixer
			0x11, // M7CL
			0x01, // data category
			0x00, // kDCAName
			0x7b, // kDCAName
			0x00, // kNameShort2
			0x01, // kNameShort2
			0x00, // CH TABLE #07
			dca, // CH TABLE #07

			// pack 8-bit ascii into 7-bit midi bytes
			nameBytes[4] >> 4,
			((nameBytes[4] & 0x0f) << 3) | (nameBytes[5] >> 5),
			((nameBytes[5] & 0x1f) << 2) | (nameBytes[6] >> 6),
			((nameBytes[6] & 0x3f) << 1) | (nameBytes[7] >> 7),
			nameBytes[7] & 0x7f,

			0xf7
		);
	}

	protected _flush(): void {
		if (!this.output || this.midiQueue.length === 0) return;
		console.log(`sending ${this.midiQueue.length} MIDI bytes`);
		this.output.send(this.midiQueue);
		this.midiQueue.length = 0; // purge queue
	}

	private _onstatechange(event: MIDIConnectionEvent): void {
		const { port } = event;
		if (port && port.state === "disconnected") {
			makeToast(`MIDI ${port.type} disconnected`, "", "error");
			this.midiQueue.length = 0; // purge queue
			// if (port.type === "output") this.close(true);
			// this._onSocketClose();
		}
	}

	// prettier-ignore
	private static meterToLevel = [-95, -94, -93, -92, -91.5, -91, -90.5, -90, -89, -88, -87, -86, -85.5, -85, -84.5, -84, -83, -82, -81, -80, -79.5, -79, -78.5, -78, -77, -76, -75, -74, -73.5, -73, -72.5, -72, -71, -70, -69, -68, -67.6, -67, -66.5, -66, -65, -64, -63, -62, -61.5, -61, -60.5, -60, -59, -58, -57, -56, -55.5, -55, -54.5, -54, -53, -52, -51, -50, -49.5, -49, -49.5, -48, -47, -46, -45, -44, -43.5, -43, -42.5, -42, -41, -40, -39, -38, -37.5, -37, -36.5, -36, -35, -34, -33, -32, -31.5, -31, -30.5, -30, -29, -28, -27, -26, -25.5, -25, -24.5, -24, -23, -22, -21, -20, -19.5, -19, -18.5, -18, -17, -16, -15, -14, -13.5, -13, -12.5, -12, -11, -10, -9, -8, -7.5, -7, -6.5, -6, -5, -4, -3, -2, -1.5, -1, 0, 0];
	private _onmidimessage(event: MIDIMessageEvent): void {
		const { data } = event;
		if (!data) return;

		// then receive
		// let format = [
		// 	0xf0, // system exclusive
		// 	0x43, // manufacturer id
		// 	0x10, // paramater change, midi channel 0
		// 	0x3e, // digital mixer
		// 	0x11, // M7CL
		// 	0x21, // remote level meter
		// 	// category
		// 	// metering point
		// 	// start channel
		// 	// ...level, 1 per channel
		// 	0xf7,
		// ];
		if (data[0] !== 0xf0 || data[1] !== 0x43 || data[3] !== 0x3e || data[4] !== 0x11 || data[5] !== 0x21) return;

		let levels = new Float32Array(data.slice(9, -1));
		for (let i = 0; i < levels.length; i++) {
			// levels[i] = Math.pow(M7CLConnection.meterToLevel[levels[i]] / 40, 10);
			levels[i] = Math.pow(1 - M7CLConnection.meterToLevel[levels[i]] / -95, 2);
		}

		channelMeters.set(levels);
	}

	private _requestMetering(): void {
		this.output?.send([
			0xf0, // system exclusive
			0x43, // manufacturer id
			0x30, // parameter request, midi channel 0
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

	static readonly MeterPointEnum = {
		PRE_HPF: 0x00,
		PRE_ATT: 0x01,
		POST_EQ: 0x02,
		POST_DYN1: 0x03,
		POST_DYN2: 0x04,
		POST_ON: 0x05,
		PRE_FADER: 0x06,
		DYN1_GAIN_REDUCTION: 0x07,
		DYN2_GAIN_REDUCTION: 0x08,
	} as const;

	static getCompleteConfig(): M7CLConfig {
		const config = get(m7clConfig);
		return {
			...BaseConnection.getCompleteConfig(),
			...config,
			host: config.host || "",
			inputHost: config.inputHost || "",
			liveMetersEnabled: config.liveMetersEnabled ?? false,
			liveMeterPoint: config.liveMeterPoint ?? this.MeterPointEnum.PRE_FADER,
		};
	}

	close(ungraceful = false): void {
		super.close(ungraceful);
		this.output?.removeEventListener("statechange", this._onstatechange);
		this.output?.close();
		this.input?.removeEventListener("midimessage", this._onmidimessage);
		this.input?.close();
		this.midiQueue.length = 0; // purge queue
		if (this.liveRequestInterval) {
			clearInterval(this.liveRequestInterval);
		}
	}
}
