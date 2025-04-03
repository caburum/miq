import type { M7CLConnection } from "./m7cl.js";

export interface BaseConnectionConfig {
	resendNum: number;
	autoReconnect: boolean;
	liveMetersEnabled: boolean;
}

export interface OSCConfig extends BaseConnectionConfig {
	host: string;
	port: number;
	secure: boolean;
}

export interface MixingStationConfig extends BaseConnectionConfig {
	host: string;
	port: number;
	secure: boolean;
}

export interface M7CLConfig extends BaseConnectionConfig {
	host: string;
	inputHost: string;
	liveMeterPoint: number;
}
