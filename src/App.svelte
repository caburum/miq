<script lang="ts">
	import "boxicons";
	import { onMount, tick, untrack } from "svelte";

	import DbManager from "./components/DbManager.svelte";
	import Dialog from "./components/Dialog.svelte";
	import Scene from "./components/Scene.svelte";
	import Settings from "./components/Settings.svelte";
	import Toast from "./components/Toast.svelte";

	import Dropdown from "./components/Dropdown.svelte";
	import { currentIndex, scenes, selectedConfig, selectedConfigId } from "./lib/configState.svelte";
	import { connectors } from "./lib/connections";
	import { connectionAddress, newConnection } from "./lib/connectionUtil";
	import { configs, loadExternalConfig, updateSheet } from "./lib/db";
	import { connect, disconnect, getCompleteMqttConfig, incomingMessage, mqttClient } from "./lib/mqtt";
	import {
		appConfig,
		channelOverrides,
		connectionMode,
		ConnectionStatusEnum,
		currentConnection,
		currentConnectionStatus,
		makeToast,
		mqttConfig,
		mqttStatus,
		showingDialog,
		showingPage,
		toasts,
	} from "./lib/stores";
	import { tools as globalTools } from "./lib/tools";

	onMount(() => {
		// check url for linked config
		try {
			let config = new URL(location.href).searchParams.get("config");
			if (config) {
				const linkedConfig = JSON.parse(atob(config));
				loadExternalConfig("linked", "Linked", linkedConfig);
			}
		} catch (error: any) {
			console.log(error);
			makeToast("Error loading linked config", error, "error");
		}
	});

	let previewIndex = $state(0);

	let sceneSelector: HTMLDivElement;
	$effect(() => {
		// todo: only fire on keyboard/button moves, not clicks
		sceneSelector.querySelector(`button:nth-of-type(${previewIndex + 1})`)?.scrollIntoView({
			behavior: "smooth",
			block: "center",
			inline: "center",
		});
	});

	function fire(index: number) {
		currentIndex.index = index;
		currentIndex.config = $selectedConfigId;
		if (index === previewIndex || previewIndex === -1) {
			previewIndex = index + 1;
			sceneSelector.querySelector(`button:nth-of-type(${index + 1})`)?.scrollIntoView({
				behavior: "smooth",
				block: "center",
				inline: "center",
			});
		}
		$currentConnection?.onFire($scenes[currentIndex.index]);
	}

	let initialHistoryState = $state(history.state);
	$effect(() => {
		scenes; // try to restore from history state, first time only
		if (initialHistoryState !== null) {
			tick().then(() => {
				const index = $scenes.findIndex((scene) => scene.name === initialHistoryState);
				if (index !== -1) {
					previewIndex = index;
					initialHistoryState = null;
				}
			});
		}
	});
	$effect(() => {
		if ($scenes.length && $scenes[previewIndex]?.name) {
			history.replaceState($scenes[previewIndex].name, "");
		}
	});

	// when we refresh the data, we want to keep the same scene selected
	// this will temporarily hold some old scene data until the new scenes list is regenerated as it may take a while
	let updateData = $state<{
		oldPreviewName: string;
		oldCurrentName: string;
	} | null>(null); // fixme:
	$effect(() => {
		// scenes; // trigger this effect when scenes change
		// try to keep same position when updating sheet

		let data = untrack(() => updateData);
		if (data !== null) {
			let newNames = $scenes.map((scene) => scene.name);

			function findNewIndex(
				startIndex: number,
				targetString: string,
				fallback: undefined | number = undefined,
			): number {
				if (startIndex < 0) return -1;
				let right = startIndex,
					left = startIndex;
				while (left >= 0 || right < newNames.length) {
					if (right < newNames.length && newNames[right] === targetString) return right;
					if (left >= 0 && newNames[left] === targetString) return left;
					right++;
					left--;
				}
				return fallback || startIndex;
			}

			currentIndex.index = findNewIndex(
				untrack(() => currentIndex.index), // old
				data.oldCurrentName,
				-1, // don't say we have some random thing fired
			);
			previewIndex = findNewIndex(
				untrack(() => previewIndex), // old
				data.oldPreviewName,
			);

			updateData = null;
		}
	});

	$inspect("app", {
		// selectedConfig: $selectedConfig,
		// configs: $configs,
		// selectedConfigId: $selectedConfigId,
		scenes: $scenes,
	}).with(console.trace);
	$inspect("index", {
		currentIndex,
		previewIndex,
	}).with(console.trace);

	let debouncingFire = $state(false);

	let miniMode = $state(false);
	if (localStorage.getItem("miniMode") == "1") miniMode = true;
	$effect(() => {
		localStorage.setItem("miniMode", miniMode ? "1" : "0");
		document?.body?.classList?.toggle("miniMode", miniMode);
	});

	let windowUnfocused = $state(false);

	// fixme: currently broken, should be rewritten as $state
	let channelOverrideDialogChannel = $state<number | null>(null);
	const populateChannelOverride = (number: number | null | undefined) => {
		if (typeof number === "number" && !$channelOverrides[number]) {
			$channelOverrides[number] = { disableControl: false, channelNumber: undefined }; // include form binds
		}
	};

	let tools = $derived({ ...globalTools, ...$currentConnection?.tools });

	let rxActive = $derived($mqttStatus.status === ConnectionStatusEnum.CONNECTED && $mqttConfig.mode == "rx");
	// todo: move logic to mqtt file
	$effect(() => {
		if ($incomingMessage && rxActive) {
			try {
				const data = JSON.parse($incomingMessage.payloadString);
				if (data.type === "config") {
					loadExternalConfig("mqtt", "MQTT", data.data);
					if ($mqttConfig.rx_live) previewIndex = -1; // flag reset preview index
				} else if (data.type === "index") {
					if ($mqttConfig.rx_preview) previewIndex = data.data.previewIndex;
					if ($mqttConfig.rx_live) fire(data.data.currentIndex);
				}
			} catch (error) {
				console.log(error);
			}
		}
	});
	$effect(() => {
		// console.log(selectedConfig, $mqttConfig.mode, $mqttStatus)
		$selectedConfig;

		let config = $selectedConfig;
		if (
			config &&
			$mqttStatus.status === ConnectionStatusEnum.CONNECTED &&
			$mqttConfig.mode == "tx" &&
			$mqttConfig.topic
		) {
			console.log("sending config", config);
			mqttClient.send(
				"miq/" + $mqttConfig.topic + "/config",
				JSON.stringify({ type: "config", data: config }),
				0,
				true,
			);
			//set will message to clear
		}
	});
	$effect(() => {
		if (
			$selectedConfig &&
			$mqttStatus.status === ConnectionStatusEnum.CONNECTED &&
			$mqttConfig.mode == "tx" &&
			$mqttConfig.topic
		) {
			// send current and preview index
			mqttClient.send(
				"miq/" + $mqttConfig.topic,
				JSON.stringify({ type: "index", data: { currentIndex: currentIndex.index, previewIndex } }),
				0,
				true,
			);
		}
	});
</script>

<svelte:head>
	<title>{[$selectedConfig?.name, "miq"].filter(Boolean).join(" | ")}</title>
</svelte:head>

<svelte:window
	onkeydown={(e) => {
		if (e.key === "Escape") $showingPage = null;

		if ($showingPage || $showingDialog) return; // only run on main page
		if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;

		(document.activeElement as HTMLElement | null)?.blur();

		if (e.key === "ArrowLeft" && previewIndex > 0) previewIndex--;
		else if (e.key === "ArrowRight" && previewIndex < $scenes.length - 1) previewIndex++;
		else if (e.key === "Home") previewIndex = 0;
		else if (e.key === "End") previewIndex = $scenes.length - 1;
		else if (e.key === "KeyR") fire(currentIndex.index);
		else if (!debouncingFire && e.key === " " && previewIndex < $scenes.length) {
			debouncingFire = true;
			fire(previewIndex);
			// setTimeout(() => debouncingFire = false, 1000);
		}
	}}
	onkeyup={(e) => {
		if (e.key === " ") debouncingFire = false;
	}}
	onblur={() => {
		debouncingFire = false;
		windowUnfocused = true;
	}}
	onfocus={() => (windowUnfocused = false)}
	onbeforeunload={(e) => {
		// warn when leaving while running a board
		if ($currentConnectionStatus.status === ConnectionStatusEnum.CONNECTED) {
			e.preventDefault();
			return (e.returnValue = "");
		}
	}}
/>

<main class:showingPage={$showingPage} inert={!!$showingPage} class:hideButtons={rxActive && $mqttConfig.rx_preview}>
	<div class="top">
		<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<h1
			style="font-weight: 100;"
			style:color={windowUnfocused ? "var(--red)" : "var(--text-dimmed)"}
			onclick={() => {
				if (confirm("Refresh? (connections could be lost)")) {
					location.reload();
				}
			}}
			role="button"
		>
			miq
			{windowUnfocused ? " - no focus" : ""}
		</h1>
		<div class="horiz" style="height: 100%; padding-block: 4px;">
			<button
				onclick={() => {
					if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
						if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
						else (document.documentElement as any).webkitRequestFullscreen();
					} else {
						if (document.exitFullscreen) document.exitFullscreen();
						else (document as any).webkitExitFullscreen();
					}
				}}
			>
				<!-- <span class="material-symbols-outlined"> fullscreen </span> -->
				<box-icon name="fullscreen" color="currentColor" size="1em"></box-icon>
				<br />Fullscreen
			</button>
			<button onclick={() => (miniMode = !miniMode)}>
				<box-icon name="collapse-alt" color="currentColor" size="1em"></box-icon>
				<br />Compact
			</button>
			<button onclick={() => ($showingPage = "settings")}>
				<box-icon name="cog" color="currentColor" size="1em"></box-icon>
				<br />Settings
			</button>
			<button
				onclick={() => ($mqttStatus.status === ConnectionStatusEnum.DISCONNECTED ? connect() : disconnect())}
				disabled={$mqttStatus.status === ConnectionStatusEnum.CONNECTING}
				class="connectionButton"
				style="position: relative;"
			>
				MQTT:
				<br />
				{#if $mqttConfig.host && $mqttConfig.topic}
					<span
						style:color={`var(--${
							$mqttStatus.status === ConnectionStatusEnum.CONNECTED
								? "green"
								: $mqttStatus.status === ConnectionStatusEnum.CONNECTING
									? "yellow"
									: "red"
						})`}
					>
						<div class="iconlabel">
							<box-icon
								name={$mqttStatus.status === ConnectionStatusEnum.CONNECTED
									? "wifi"
									: $mqttStatus.status === ConnectionStatusEnum.CONNECTING
										? "hourglass"
										: "wifi-off"}
								color="currentColor"
								size="1em"
							></box-icon>
							<strong>
								{getCompleteMqttConfig($mqttConfig).mode}/{getCompleteMqttConfig($mqttConfig).topic}
							</strong>
						</div>
					</span>
				{:else}
					<div class="iconlabel">
						<box-icon name="wifi-off" color="currentColor" size="1em"></box-icon>
						no host
					</div>
				{/if}
				{#if $mqttConfig.host && $mqttConfig.topic && $mqttStatus.status !== ConnectionStatusEnum.CONNECTING}
					<span class="minilabel">tap to {$mqttStatus.status ? "disconnect" : "connect"}</span>
				{/if}
			</button>
			<Dropdown
				items={Object.entries(tools || {}).map(([name, fn]) => [
					name,
					async () => {
						const output = await fn();
						if (output) {
							await navigator.clipboard.writeText(output);
							makeToast("Output copied to clipboard", output, "info");
						}
					},
				])}
			>
				<box-icon name="customize" color="currentColor" size="1em"></box-icon>
				<br />Tools
			</Dropdown>
			<button
				onclick={() => ($currentConnectionStatus.status > 0 ? $currentConnection?.close() : newConnection())}
				class="connectionButton"
				style="position: relative;"
				style:display={rxActive ? "none" : null}
			>
				{connectors[$connectionMode].name}:
				<br />
				<span
					style:color={`var(--${
						$currentConnectionStatus.status === ConnectionStatusEnum.CONNECTED
							? "green"
							: $currentConnectionStatus.status === ConnectionStatusEnum.CONNECTING
								? "yellow"
								: "red"
					})`}
				>
					<div class="iconlabel">
						<box-icon
							name={$currentConnectionStatus.status === ConnectionStatusEnum.CONNECTED
								? "wifi"
								: $currentConnectionStatus.status === ConnectionStatusEnum.CONNECTING
									? "hourglass"
									: "wifi-off"}
							color="currentColor"
							size="1em"
						></box-icon>
						<strong>{$connectionAddress}</strong>
					</div>
				</span>
				<span class="minilabel"
					>tap to {$currentConnectionStatus.status === ConnectionStatusEnum.CONNECTED
						? "disconnect"
						: $currentConnectionStatus.status === ConnectionStatusEnum.CONNECTING
							? "stop connecting"
							: "connect"}</span
				>
			</button>
			{#if $selectedConfig && $selectedConfig.sheetId && !rxActive}
				<button
					onclick={() => {
						updateData = {
							oldPreviewName: $scenes[previewIndex]?.name,
							oldCurrentName: $scenes[currentIndex.index]?.name,
						};
						updateSheet($selectedConfig.id);
					}}
				>
					<box-icon name="refresh" color="currentColor" size="1em"></box-icon>
					<br />Update
				</button>
			{/if}
			<button
				onclick={() => ($showingPage = "dbConfig")}
				disabled={rxActive}
				style="white-space: nowrap; text-overflow: ellipses;"
			>
				<div class="iconlabel" style="font-size: 0.8em">
					<box-icon name="data" color="currentColor" size="1em"></box-icon>Database
				</div>
				<br />
				<strong style="font-size: 1.1em; ">
					{$configs.find((item) => item.id === $selectedConfigId)?.name || "--"}
				</strong>
			</button>
		</div>
	</div>
	<div class="middle">
		<div
			class="sceneselector"
			bind:this={sceneSelector}
			onwheel={(e) => {
				if (!e.deltaY || e.shiftKey) return;
				e.preventDefault(); // stop scrolling in another direction
				e.currentTarget.scrollLeft += (e.deltaY + e.deltaX) * 0.6;
				// sceneSelector.scrollBy({
				// 	left: (e.deltaY + e.deltaX) * 3,
				// 	behavior: "smooth",
				// });
			}}
		>
			<div class="sceneProgress">
				<span style:--progress={Math.max(((currentIndex.index + 1) / $scenes.length) * 100, 0) + "%"}>
					<strong>{currentIndex.index + 1}</strong>/{$scenes.length}
				</span>
			</div>
			{#each $scenes as scene, i}
				<button
					onclick={() => (previewIndex = i)}
					class:green={i === previewIndex && i !== currentIndex.index}
					class:red={i === currentIndex.index}
				>
					{scene.name}
				</button>
			{/each}
			<!-- todo: make look not like a cue -->
			<button onclick={() => (previewIndex = 0)}>&lt;&lt; START</button>
		</div>
		<div class="sceneview" class:reversed={$appConfig?.flipSceneOrder || false}>
			<Scene scene={$scenes[previewIndex]} bind:channelOverrideDialogChannel />
			<Scene scene={$scenes[currentIndex.index]} live bind:channelOverrideDialogChannel />
		</div>
	</div>
	<div class="buttons">
		{#if !(rxActive && $mqttConfig.rx_preview)}
			<button disabled={previewIndex < 1} onclick={() => previewIndex--}>Preview backwards</button>
			<button disabled={previewIndex > $scenes.length - 1} onclick={() => previewIndex++}>Preview forwards</button>
			<button disabled={previewIndex === currentIndex.index + 1} onclick={() => (previewIndex = currentIndex.index + 1)}
				>Preview reset</button
			>
		{/if}
		{#if !rxActive}
			<button disabled={previewIndex > $scenes.length - 1} class="red" onclick={() => fire(previewIndex)}
				>Fire next</button
			>
		{/if}
	</div>
</main>

<Dialog
	show={channelOverrideDialogChannel !== null}
	onclose={() => {
		channelOverrideDialogChannel = null;
		$channelOverrides = { ...$channelOverrides }; // todo: trigger reactivity, but should rewrite as sv5 state
	}}
>
	{#await new Promise<void>((resolve) => {
		channelOverrideDialogChannel && populateChannelOverride(channelOverrideDialogChannel);
		resolve();
	}) then}
		{#if channelOverrideDialogChannel}
			<h2>Channel {channelOverrideDialogChannel} overrides</h2>
			<div>
				<label for="disableControl">Disable control?:</label>
				<input
					id="disableControl"
					type="checkbox"
					bind:checked={$channelOverrides[channelOverrideDialogChannel].disableControl}
				/>
			</div>
			<div>
				<label for="channelNumber">Channel number:</label>
				<input
					id="channelNumber"
					type="number"
					min="1"
					value={$channelOverrides[channelOverrideDialogChannel].channelNumber}
					onchange={(e) => {
						if (channelOverrideDialogChannel === null) return;
						const oldChannelNumber = $channelOverrides[channelOverrideDialogChannel].channelNumber;
						if (oldChannelNumber) {
							populateChannelOverride(oldChannelNumber);
							$channelOverrides[oldChannelNumber].disableControl = false;
						}

						const newChannelNumber = parseInt(e.currentTarget.value);
						if (!Number.isNaN(newChannelNumber)) {
							populateChannelOverride(newChannelNumber);
							$channelOverrides[newChannelNumber].disableControl = true;
						}
						$channelOverrides[channelOverrideDialogChannel].channelNumber = newChannelNumber;

						console.log(oldChannelNumber, newChannelNumber);
					}}
				/>
				<button
					onclick={(e) => {
						e.preventDefault();
						if (channelOverrideDialogChannel === null) return;
						const oldChannelNumber = $channelOverrides[channelOverrideDialogChannel].channelNumber;
						if (oldChannelNumber) {
							populateChannelOverride(oldChannelNumber);
							$channelOverrides[oldChannelNumber].disableControl = false;
						}
						$channelOverrides[channelOverrideDialogChannel].channelNumber = undefined;
					}}
					title="*will also remove a manually set channel disable on target">clear</button
				>
			</div>
		{/if}
	{:catch}
		invalid state
	{/await}
</Dialog>

<DbManager />
<Settings />

<div class="toasts">
	{#each $toasts as toastMessage}
		<Toast {toastMessage} />
	{/each}
</div>

<style lang="scss">
	main {
		display: grid;
		grid-template-rows: auto 1fr auto;
		gap: var(--spacing);
		height: 100%;
		width: 100%;
		box-sizing: border-box;
		padding: var(--spacing);
		transition: var(--page-transition);
		&.showingPage {
			// transform: scale(0.8);
			opacity: 0.2;
			filter: blur(20px);
		}
		&.hideButtons {
			grid-template-rows: 3em 1fr;
		}
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--top-height);
		gap: var(--spacing);
		.horiz > :global(*) {
			font-size: 0.8em;
			font-weight: 300;
			height: 100%;
			text-align: left;

			:global(summary) {
				height: 100%;
				font-size: inherit;
			}
		}
		strong {
			font-weight: 900;
		}
		.connectionButton {
			min-width: 130px;
		}
	}
	.buttons {
		display: flex;
		align-items: stretch;
		gap: var(--spacing);
		height: 4em;
		width: 100%;
		> * {
			flex: 1;
			font-size: 1.2em;
			:global(.miniMode) & {
				font-size: 1em;
			}
			font-weight: bold;
		}
		.hideButtons & {
			display: none;
		}
		:global(.miniMode) & {
			height: 3em;
		}
	}
	.middle {
		display: grid;
		align-items: stretch;
		gap: var(--spacing);
		grid-template-rows: auto 1fr;
		overflow: hidden;
	}
	.sceneselector {
		display: flex;
		flex-direction: row;
		// align-items: center;
		gap: min(6px, var(--spacing));
		overflow-y: hidden;
		overflow-x: auto;
		// width: 100%;
		padding-bottom: min(6px, var(--spacing));

		max-height: 3em; // ios 12 temporary fix

		> * {
			flex: 0 0 auto;
			height: 100%;
			padding: 0.5em 0.75em;
			font-weight: bold;
			transition: 120ms;

			// todo: fix ios 12 text wrapping
			display: inline-block;
			white-space: nowrap;
			flex-shrink: 0;
			width: auto;
			min-width: max-content;
			max-width: none;
		}
		&::-webkit-scrollbar {
			width: 6px;
			height: 6px;
		}
		&::-webkit-scrollbar-thumb {
			background: var(--fg);
			border-radius: min(6px, var(--rounding));
		}
		.sceneProgress {
			padding: 0 12px;
			padding-right: 24px;
			background: linear-gradient(to left, transparent 0%, var(--bg) 12px, var(--bg) 100%);
			height: 100%;
			display: flex;
			align-items: center;
			// position: -webkit-sticky;
			position: sticky;
			left: 0;
			font-weight: 200;
			font-size: 1.5em;

			@supports (-webkit-background-clip: text) or (background-clip: text) {
				span {
					background-image: linear-gradient(to right, var(--text) var(--progress), var(--text-dimmed) var(--progress));
					-webkit-background-clip: text;
					background-clip: text;
					-webkit-text-fill-color: transparent;
				}
			}
		}
	}
	.sceneview {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: var(--spacing);
		overflow: auto;
		&.reversed {
			flex-direction: column-reverse;
		}
	}
	.toasts {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 1000;
	}
</style>
