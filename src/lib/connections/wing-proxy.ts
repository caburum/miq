import OSC from "osc-js";
import { get } from "svelte/store";
import { getTrackedMics } from "../configState.svelte";
import { ConnectionStatusEnum, currentConnectionStatus, makeToast, wingConfig } from "../stores";
import type { BaseColor, Scene } from "../types";
import { BaseConnection } from "./baseConnection";

// https://wing-docs.com/article/osc
// https://drive.google.com/file/d/1-iptgd2Uxw4qPEbmegG2Sqccf8AbRRfk/view
// https://sites.google.com/site/patrickmaillot/wing
// https://github.com/dannydulai/libwing/blob/main/src/console.rs

export class WingConnection extends BaseConnection {
	static name = "wing-proxy";
	static fullName = "Behringer Wing (OSC)";

	client: OSC;
	liveRequestInterval: ReturnType<typeof setInterval> | undefined;

	static readonly colors = {
		CYAN: 2,
		RED: 9,
		MAGENTA: 11,
	} as const;

	constructor() {
		super();

		const config = WingConnection.getCompleteConfig();

		this.client = new OSC({
			plugin: new OSC.WebsocketClientPlugin({
				host: config.host,
				port: config.port,
				secure: false,
			}),
		});

		if (window) (window as any).oscClient = this.client;

		// this.client.on("/meters/*", (message: OSCMessage) => {
		// 	console.log(message.address, message.args);
		// 	if (message.address === "/meters/6") {
		// 		let meters = new Float32Array(message.args[0].buffer.slice(16));
		// 		console.log(meters[0]);
		// 	} else if (message.address === "/meters/1") {
		// 		let meters = new Float32Array(message.args[0].buffer.slice(24));
		// 		let levels = meters.slice(0, 32);
		// 		for (let i = 0; i < levels.length; i++) {
		// 			levels[i] = Math.pow(levels[i], 0.5);
		// 		}
		// 		channelMeters.set(levels);
		// 	}
		// });

		this.client.on("open", () => {
			currentConnectionStatus.set({
				status: ConnectionStatusEnum.CONNECTED,
				address: config.host + ":" + config.port,
			});
			// const liveRequestFunction = () => {
			// 	if (config.liveMetersEnabled) {
			// 		this.client.send(new OSC.Message("/meters", "/meters/1"));
			// 	}
			// };
			// liveRequestFunction();
			// this.liveRequestInterval = setInterval(liveRequestFunction, 5000);
		});
		this.client.on("close", () => {
			this._onSocketClose();
			clearInterval(this.liveRequestInterval);
		});
		this.client.on("error", (e: Event & { target: WebSocket }) => {
			console.error("OSC Error", e);
			// let onclose handle close
			if (e?.target?.readyState !== 3) {
				makeToast("OSC Error", "", "error");
				clearInterval(this.liveRequestInterval);
			}
		});
		this.client.open();
		// try {
		// } catch (error) {
		// 	makeToast("Error opening OSC", error, "error");
		// }
	}

	_sanitizeString = (str: string, maxLen: number) =>
		str.replaceAll("\\", "/").replaceAll("'", "\\'").substring(0, maxLen);

	override _fireChannel(channel: number, active: boolean | null, name: string, color: BaseColor): void {
		let cmnd = `name='${this._sanitizeString(name, 16)}'` + `,col=${WingConnection.colors[color]}`;
		if (active !== null) cmnd += `,mute=${active ? 0 : 1}`;

		const message = new OSC.Message(`/ch/${channel}`, cmnd);
		// console.log("Sending message:", message);

		this.client.send(message);
	}

	override _fireDCAs(channel: number, dcas: NonNullable<Scene["dcas"]>) {
		const tags = Array.from(dcas.entries())
			.filter(([_, { mics }]) => mics.has(channel))
			.map(([dcaNum]) => `#D${dcaNum}`);

		const message = new OSC.Message(`/ch/${channel}/tags`, tags.join(","));

		this.client.send(message);
	}

	override _nameDCA(dca: number, name: string): void {
		this.client.send(new OSC.Message(`/dca/${dca}/name`, this._sanitizeString(name, 8)));
	}

	message: {
		(address: string): Promise<OSC.Message>;
		(address: string, ...args: any[]): Promise<null>;
	} = (address, ...args): any =>
		new Promise((resolve) => {
			this.client.send(new OSC.Message(address, ...args));
			if (args.length === 0) {
				const subscriptionId = this.client.on("*", (message: OSC.Message) => {
					if (!message || message.address !== address) return;
					console.log(message);
					resolve(message);
					this.client.off(address, subscriptionId);
				});
			} else {
				resolve(null);
			}
		});

	tools = {
		snapshot: () =>
			new Promise<string>((resolve) => {
				let active = new Map<number, boolean>();

				let mics = getTrackedMics(); // todo: include current actors and store in more useful format
				if (!mics || mics.length === 0) return;

				const subscriptionId = this.client.on("/ch/*", (message: OSC.Message) => {
					if (message.address.startsWith("/ch/")) {
						console.log(message);
						const channel = parseInt(message.address.split("/")[2]);
						const args = message.args;
						active.set(channel, args[0] === 0 ? true : false);

						if (active.size === mics.length) {
							this.client.off("/ch/*", subscriptionId);

							let snapshot = "";
							for (let i of mics) {
								const isActive = active.get(i);
								snapshot += `ch${i}=${isActive ? "on" : "off"}; `;
							}
							resolve(snapshot);
						}
					}
				});

				for (let i of mics) {
					this.client.send(new OSC.Message(`/ch/${i}/mute`));
				}
			}),

		resetFaders: (level = "-5") => {
			for (let i of getTrackedMics()) {
				this.client.send(new OSC.Message(`/ch/${i}/fdr`, level));
			}
		},

		setDisplayDay: () => {
			this.message("/$ctl/cfg/lights/btns", 100);
			this.message("/$ctl/cfg/lights/leds", 100);
			this.message("/$ctl/cfg/lights/rgbleds", 35);
			this.message("/$ctl/cfg/lights/chlcds", 40);
			this.message("/$ctl/cfg/lights/chlcdctr", 50);
			this.message("/$ctl/cfg/lights/chedit", 65);
			this.message("/$ctl/cfg/lights/main", 100);
			this.message("/$ctl/cfg/lights/glow", 100);
		},

		setDisplayNight: () => {
			this.message("/$ctl/cfg/lights/btns", 50);
			this.message("/$ctl/cfg/lights/leds", 50);
			this.message("/$ctl/cfg/lights/rgbleds", 15);
			this.message("/$ctl/cfg/lights/chlcds", 40);
			this.message("/$ctl/cfg/lights/chlcdctr", 50);
			this.message("/$ctl/cfg/lights/chedit", 65);
			this.message("/$ctl/cfg/lights/main", 30);
			this.message("/$ctl/cfg/lights/glow", 50);
		},
	};

	static getCompleteConfig() {
		const config = get(wingConfig);
		return {
			...BaseConnection.getCompleteConfig(),
			...config,
			host: config.host || "localhost",
			port: config.port || 8080,
			liveMetersEnabled: false, // todo: implement live metering api // config.liveMetersEnabled ?? false,
		};
	}

	close(ungraceful = false) {
		super.close(ungraceful);
		this.client.close();
		if (this.liveRequestInterval) clearInterval(this.liveRequestInterval);
	}
}
