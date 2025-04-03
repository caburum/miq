<script>
	import { onMount, setContext, tick } from "svelte";
	import "boxicons";

	import Scene from "./components/scene.svelte";
	import DbManager from "./components/dbManager.svelte";
	import Settings from "./components/settings.svelte";
	import Toast from "./components/toast.svelte";
	import Dialog from "./components/dialog.svelte";

	import {
		appConfig,
		showingModal,
		selectedConfigId,
		mqttStatus,
		mqttConfig,
		toasts,
		makeToast,
		currentConnection,
		currentConnectionStatus,
		connectionMode,
		ConnectionStatusEnum,
		channelOverrides,
	} from "./lib/stores";
	import { newConnection, connectionAddress, connectors } from "./lib/connectionUtil";
	import { configs, sheets, ddp, loadExternalConfig, updateSheet } from "./lib/db";
	import { connect, disconnect, getCompleteMqttConfig, incomingMessage, mqttClient } from "./lib/mqtt";

	let loading = ["Loading..."];

	let miniMode = false;
	if (localStorage.getItem("miniMode") == 1) miniMode = true;
	$: localStorage.setItem("miniMode", miniMode ? 1 : 0);

	$: document?.body?.classList?.toggle("miniMode", miniMode);

	/** @type {HTMLDivElement} */
	let sceneSelector;

	let selectedConfig = null;
	$: selectedConfig = ($configs || []).find((config) => config.id === $selectedConfigId) || {};

	/** current sheet contents */
	let data = [];
	$: data =
		selectedConfig?.table ||
		(selectedConfig.sheetId ? $sheets.find((sheet) => sheet.id === selectedConfig.sheetId)?.table : []);

	$: console.log({
		data,
		selectedConfig,
		configs: $configs,
		sheets: $sheets,
		selectedConfigId: $selectedConfigId,
	});

	let scenes = [];
	let historyState = history.state;
	$: if (scenes.length && scenes[previewIndex]?.name) {
		history.replaceState(scenes[previewIndex].name, "");
	}

	function regenerateScenes(selectedConfig, data) {
		console.log("regenerating scenes");
		const config = {
			notesRow: parseInt(selectedConfig.notesRow ?? ddp.notesRow),
			namesRow: parseInt(selectedConfig.namesRow ?? ddp.namesRow),
			flagsRow: parseInt(selectedConfig.flagsRow ?? ddp.flagsRow),
			micsStartRow: parseInt(selectedConfig.micsStartRow ?? ddp.micsStartRow),
			micNumsCol: parseInt(selectedConfig.micNumsCol ?? ddp.micNumsCol),
			actorNamesCol: parseInt(selectedConfig.actorNamesCol ?? ddp.actorNamesCol),
			scenesStartCol: parseInt(selectedConfig.scenesStartCol ?? ddp.scenesStartCol),
		};
		if (data && data.length > 0 && data[0]?.length > 0) {
			let newScenes = [];
			let actorMicPairs = {};
			function generateActorMicPairs(col) {
				for (let j = config.micsStartRow; j < data.length; j++) {
					const micNum = parseInt(data[j][col]);
					if (micNum !== NaN && micNum > 0) {
						actorMicPairs[micNum] = {
							row: j,
							actor: data[j][config.actorNamesCol],
						};
					}
				}
			}
			generateActorMicPairs(config.micNumsCol);
			for (let i = config.scenesStartCol; i < data[0].length; i++) {
				if (data[config.flagsRow][i].includes("MIC_CHANGE")) {
					generateActorMicPairs(i);
					continue;
				}
				let mics = {};
				Object.keys(actorMicPairs).forEach((micNum) => {
					const pair = actorMicPairs[micNum];
					const j = pair.row;
					mics[micNum] = {
						actor: pair.actor,
						character: data[j][i],
						active: data[j][i].trim() !== "" && data[j][i].trim().slice(0, 2) !== "//",
					};
				});
				newScenes.push({
					notes: data[config.notesRow][i],
					name: data[config.namesRow][i],
					mics,
				});
			}
			// backward pass
			let passMem = {};
			newScenes.reverse();
			newScenes.forEach((scene) => {
				Object.keys(scene.mics).forEach((micNum) => {
					if (passMem[micNum]?.actor && !scene.mics[micNum].active) {
						scene.mics[micNum].actor = passMem[micNum].actor;
					} else {
						passMem[micNum] = scene.mics[micNum];
					}
				});
			});
			// forward pass
			passMem = {};
			newScenes.reverse();
			newScenes.forEach((scene) => {
				Object.keys(scene.mics).forEach((micNum) => {
					if (
						passMem[micNum]?.switchingFrom &&
						!scene.mics[micNum].active &&
						passMem[micNum]?.switchingFrom !== scene.mics[micNum].actor
					) {
						scene.mics[micNum].switchingFrom = passMem[micNum].switchingFrom;
					} else {
						passMem[micNum] = { switchingFrom: scene.mics[micNum].actor };
					}
				});
			});
			scenes = newScenes;
			window.scenes = scenes;

			// try to restore from history state, first time only
			if (historyState !== null) {
				tick().then(() => {
					const index = scenes.findIndex((scene) => scene.name === historyState);
					if (index !== -1) previewIndex = index;
					historyState = null;
				});
			}

			// try to keep same position when updating sheet
			if (updateData !== null) {
				let newNames = scenes.map((scene) => scene.name);

				/** @param {number} startIndex @param {string} targetString @param {undefined|number} fallback @returns {number} index */
				function findNewIndex(startIndex, targetString, fallback = undefined) {
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

				currentIndex = findNewIndex(
					currentIndex, // old
					updateData.oldCurrentName,
					-1, // don't say we have some random thing fired
				);
				previewIndex = findNewIndex(
					previewIndex, // old
					updateData.oldPreviewName,
				);

				updateData = null;
			}
		} else {
			scenes = [];
		}
	}

	/** @type {number | null} */
	let channelOverrideDialogChannel = null;
	const populateChannelOverride = (number) => {
		if (!$channelOverrides[number]) {
			$channelOverrides[number] = { disableControl: false, channelNumber: null }; // include form binds
		}
	};

	// only want to regenerate when these specific parameters change
	$: regenerateScenes(selectedConfig, data);

	// when we refresh the data, we want to keep the same scene selected
	// this will temporarily hold some old scene data until the new scenes list is regenerated as it may take a while
	let updateData = null;

	let previewIndex = 0;
	let currentIndex = -1;
	let currentIndexConfigId = null;

	function fire(index) {
		currentIndex = index;
		currentIndexConfigId = $selectedConfigId;
		if (index === previewIndex) {
			previewIndex = index + 1;
			sceneSelector?.querySelectorAll("button")[index]?.scrollIntoView({
				behavior: "smooth",
				block: "center",
				inline: "center",
			});
		}
		$currentConnection?.onFire(scenes[currentIndex]);
	}

	$: sceneSelector?.querySelectorAll("button")[previewIndex]?.scrollIntoView({
		behavior: "smooth",
		block: "center",
		inline: "center",
	});

	$: if ($selectedConfigId !== currentIndexConfigId) {
		currentIndex = -1;
		currentIndexConfigId = null;
	}

	function toggleFullscreen() {
		if (!document.fullscreenElement && !document.webkitFullscreenElement) {
			if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
			else document.documentElement.webkitRequestFullscreen();
		} else if (document.exitFullscreen) {
			if (document.fullscreenElement) document.exitFullscreen();
			else document.webkitExitFullscreen();
		}
	}

	$: {
		// console.log(selectedConfig, $mqttConfig.mode, $mqttStatus.connected)
		if (selectedConfig && $mqttStatus.connected && $mqttConfig.mode == "tx" && $mqttConfig.topic) {
			let config = $configs?.find((item) => item.id === selectedConfig.id);
			const sheetId = $sheets?.find((item) => item.id === config.sheetId)?.sheetId;
			if (sheetId) config = { ...config, sheetId };
			if (config.table) config = { ...config, table: undefined };
			console.log("sending config", config);
			mqttClient.publish(
				"miq/" + $mqttConfig.topic + "/config",
				JSON.stringify({ type: "config", data: config }),
				0,
				true,
			);
			//set will message to clear
		}
	}

	$: {
		if (selectedConfig && $mqttStatus.connected && $mqttConfig.mode == "tx" && $mqttConfig.topic) {
			// send current and preview index
			mqttClient.publish(
				"miq/" + $mqttConfig.topic,
				JSON.stringify({ type: "index", data: { currentIndex, previewIndex } }),
				0,
				true,
			);
		}
	}

	let rxActive = false;
	$: rxActive = $mqttStatus.connected && $mqttConfig.mode == "rx";

	$: {
		if ($incomingMessage && $mqttStatus.connected && $mqttConfig.mode == "rx") {
			try {
				const data = JSON.parse($incomingMessage.payloadString);
				if (data.type === "config") {
					loadExternalConfig("mqtt", "MQTT", data.data);
					// $selectedConfigId = "mqtt";
				} else if (data.type === "index") {
					if ($mqttConfig.rx_preview) previewIndex = data.data.previewIndex;
					if ($mqttConfig.rx_live && data.data.currentIndex !== currentIndex) {
						fire(data.data.currentIndex);
					}
				}
			} catch (error) {
				console.log(error);
			}
		}
	}

	onMount((_) => {
		loading = loading.filter((item) => item !== "Loading...");
		// check url for linked config
		try {
			if (!new URL(window.location).searchParams.has("config")) return;
			const linkedConfig = JSON.parse(atob(new URL(window.location).searchParams.get("config")));
			loadExternalConfig("linked", "Linked", linkedConfig);
		} catch (error) {
			console.log(error);
			makeToast("Error loading linked config", error, "error");
		}
	});

	let debouncingFire = false;
</script>

<svelte:head>
	<title>{selectedConfig?.name || "miq"}</title>
</svelte:head>

<svelte:window
	on:keydown={(e) => {
		if (e.key === "Escape") $showingModal = null;
		if ($showingModal || channelOverrideDialogChannel !== null) return; // only run on main page
		if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
		document.activeElement.blur();
		if (e.key === "ArrowLeft" && previewIndex > 0) previewIndex--;
		else if (e.key === "ArrowRight" && previewIndex < scenes.length - 1) previewIndex++;
		else if (e.key === "Home") previewIndex = 0;
		else if (e.key === "End") previewIndex = scenes.length - 1;
		else if (!debouncingFire && e.key === " " && previewIndex < scenes.length) {
			debouncingFire = true;
			fire(previewIndex);
			// setTimeout(() => debouncingFire = false, 1000);
		}
	}}
	on:keyup={(e) => {
		if (e.key === " ") debouncingFire = false;
	}}
	on:blur={() => (debouncingFire = false)}
/>

<main class:showingModal={$showingModal} inert={$showingModal} class:hideButtons={rxActive && $mqttConfig.rx_preview}>
	<div class="top">
		<!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<h1
			style="font-weight: 100; opacity: 0.5;"
			on:click={() => {
				if (confirm("Refresh? (connections could be lost)")) {
					window.location.reload();
				}
			}}
			role="button"
		>
			{loading[0] || "miq"}
		</h1>
		<div class="horiz" style="height: 100%; padding-block: 4px;">
			<button on:click={toggleFullscreen}>
				<!-- <span class="material-symbols-outlined"> fullscreen </span> -->
				<box-icon name="fullscreen" color="currentColor" size="1em" />
				<br />Fullscreen
			</button>
			<button on:click={() => (miniMode = !miniMode)}>
				<box-icon name="collapse-alt" color="currentColor" size="1em" />
				<br />Compact
			</button>
			<button on:click={(_) => ($showingModal = "settings")}>
				<box-icon name="cog" color="currentColor" size="1em" />
				<br />Settings
			</button>
			<button
				on:click={$mqttStatus.connected ? disconnect() : connect()}
				class="connectionButton"
				style="position: relative;"
			>
				MQTT:
				<br />
				{#if $mqttConfig.host && $mqttConfig.topic}
					<span style:color={$mqttStatus.connected ? "var(--green)" : "var(--red)"}>
						<div class="iconlabel">
							<box-icon name={$mqttStatus.connected ? "wifi" : "wifi-off"} color="currentColor" size="1em" />
							<strong>
								{getCompleteMqttConfig($mqttConfig).mode}/{getCompleteMqttConfig($mqttConfig).topic}
							</strong>
						</div>
					</span>
				{:else}
					<div class="iconlabel">
						<box-icon name="wifi-off" color="currentColor" size="1em" />
						no host
					</div>
				{/if}
				{#if $mqttConfig.host && $mqttConfig.topic}
					<span class="minilabel">tap to {$mqttStatus.connected ? "disconnect" : "connect"}</span>
				{/if}
			</button>
			<button
				on:click={$currentConnectionStatus.status > 0 ? $currentConnection.close() : newConnection()}
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
						/>
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
			{#if selectedConfig.sheetId && !selectedConfig.table && !rxActive}
				<button
					on:click={() => {
						updateData = {
							oldPreviewName: scenes[previewIndex]?.name,
							oldCurrentName: scenes[currentIndex]?.name,
						};
						updateSheet(selectedConfig.sheetId);
					}}
				>
					<box-icon name="refresh" color="currentColor" size="1em" />
					<br />Update
				</button>
			{/if}
			<button
				on:click={(_) => ($showingModal = "dbConfig")}
				disabled={rxActive}
				style="white-space: nowrap; text-overflow: ellipses;"
			>
				<div class="iconlabel" style="font-size: 0.8em">
					<box-icon name="data" color="currentColor" size="1em" />Database
				</div>
				<br />
				<strong style="font-size: 1.1em; ">
					{$configs.find((item) => item.id === $selectedConfigId)?.name || "--"}
				</strong>
			</button>
			<!-- <select
				style="font-weight: 900;"
				bind:value={$selectedConfigId}
				disabled={rxActive}
			>
				{#each $configs || [] as item}
					<option value={item.id}>{item.name || "Untitled"}</option>
				{/each}
			</select> -->
		</div>
	</div>
	<div class="middle">
		<div
			class="sceneselector"
			bind:this={sceneSelector}
			on:mousewheel={(e) => {
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
				<strong>{currentIndex + 1}</strong>/{scenes.length}
				<!-- ({parseInt((previewIndex+1)/scenes.length*100)}%) -->
			</div>
			{#each scenes as scene, i}
				<button
					on:click={() => (previewIndex = i)}
					class:green={i === previewIndex && i !== currentIndex}
					class:red={i === currentIndex}
				>
					{scene.name}
				</button>
			{/each}
			<!-- todo: make look not like a cue -->
			<button on:click={() => (previewIndex = 0)}>&lt;&lt; START</button>
		</div>
		<div class="sceneview" class:reversed={$appConfig?.flipSceneOrder || false}>
			<Scene scene={scenes[previewIndex]} bind:channelOverrideDialogChannel />
			<Scene scene={scenes[currentIndex]} live bind:channelOverrideDialogChannel />
		</div>
	</div>
	<div class="buttons">
		{#if !(rxActive && $mqttConfig.rx_preview)}
			<button disabled={previewIndex < 1} on:click={(_) => previewIndex--}>Preview backwards</button>
			<button disabled={previewIndex > scenes.length - 1} on:click={(_) => previewIndex++}>Preview forwards</button>
			<button disabled={previewIndex === currentIndex + 1} on:click={(_) => (previewIndex = currentIndex + 1)}
				>Preview reset</button
			>
		{/if}
		{#if !rxActive}
			<button disabled={previewIndex > scenes.length - 1} class="red" on:click={(_) => fire(previewIndex)}
				>Fire next</button
			>
		{/if}
	</div>
</main>

<Dialog
	show={channelOverrideDialogChannel !== null}
	on:close={() => {
		channelOverrideDialogChannel = null;
	}}
>
	{#if channelOverrideDialogChannel}
		{#await new Promise((resolve) => {
			populateChannelOverride(channelOverrideDialogChannel);
			resolve();
		}) then}
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
					on:change={(e) => {
						const oldChannelNumber = $channelOverrides[channelOverrideDialogChannel].channelNumber;
						populateChannelOverride(oldChannelNumber);
						$channelOverrides[oldChannelNumber].disableControl = false;

						const newChannelNumber = parseInt(e.target.value);
						if (newChannelNumber !== NaN) {
							populateChannelOverride(newChannelNumber);
							$channelOverrides[newChannelNumber].disableControl = true;
						}
						$channelOverrides[channelOverrideDialogChannel].channelNumber = newChannelNumber;

						console.log(oldChannelNumber, newChannelNumber);
					}}
				/>
				<button
					on:click|preventDefault={() => {
						const oldChannelNumber = $channelOverrides[channelOverrideDialogChannel].channelNumber;
						populateChannelOverride(oldChannelNumber);
						$channelOverrides[oldChannelNumber].disableControl = false;
						$channelOverrides[channelOverrideDialogChannel].channelNumber = null;
					}}
					title="*will also remove a manually set channel disable on target">clear</button
				>
			</div>
		{:catch}
			invalid state
		{/await}
	{/if}
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
		transition: var(--modal-transition);
		&.showingModal {
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
		button,
		select {
			height: 100%;
			font-size: 1.1em;
			font-size: 0.83em;
			font-weight: 300;
			text-align: left;
			strong {
				font-weight: 900;
			}
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
		> * {
			flex: 0 0 auto;
			height: 3em;
			padding: 0.5em 0.75em;
			font-weight: bold;
			transition: 120ms;
		}
		&::-webkit-scrollbar {
			width: 6px;
			height: 6px;
		}
		padding-bottom: min(6px, var(--spacing));
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
