<script lang="ts">
	import { channelOverrides } from "../lib/stores";
	import type { Scene } from "../lib/types";
	import MeterCanvas from "./MeterCanvas.svelte";

	let {
		scene,
		live = false,
		channelOverrideDialogChannel = $bindable(null),
	}: { scene: Scene; live?: boolean; channelOverrideDialogChannel?: any } = $props();
</script>

<div class="scene" class:live>
	<div class="mics">
		<h2 class="horiz">
			{#if live}
				<span class="liveBadge">Live</span>
			{/if}
			<span>{scene ? scene.name : "--"}</span>
		</h2>
		<div class="channels">
			{#each scene?.mics as [i, mic]}
				{@const disableControl = $channelOverrides?.[i]?.disableControl}
				{@const overrideChannelNumber = $channelOverrides?.[i]?.channelNumber}
				<div
					class="channel"
					style:order={i}
					class:accent={mic?.active}
					class:dne={!mic}
					class:disabled={disableControl || mic?.character?.startsWith("?")}
				>
					<MeterCanvas channel={i} />
					<h3 style="font-weight: 400; text-overflow: clip;">
						<span style:text-decoration={overrideChannelNumber || disableControl ? "line-through" : null}>{i}</span>
						{overrideChannelNumber || ""}
					</h3>
					<!-- fixme: reenable once fixed -->
					<!-- <div
						class="menu"
						onclick={() => (channelOverrideDialogChannel = i)}
						onkeypress={() => (channelOverrideDialogChannel = i)}
						role="button"
						tabindex="0"
					>
						<box-icon name="dots-vertical-rounded" color="currentColor" size="1.25em"></box-icon>
					</div> -->
					<div>
						<p
							class="actorLabel"
							class:bigLabel={mic?.character?.startsWith("#")}
							class:actorChanging={mic?.switchingFrom}
							style="z-index: 10;"
						>
							<span>
								{#if mic?.switchingFrom}
									{mic?.switchingFrom || ""}
									<br /> <strong>&rarr; {mic?.actor || ""}</strong>
								{:else}
									{mic?.actor || ""}
								{/if}
							</span>
						</p>
						<p class={mic?.character?.startsWith("#") ? "smallLabel" : "bigLabel"}>
							{mic?.character || ""}
						</p>
					</div>
				</div>
			{/each}
		</div>
	</div>
	<div style="overflow: auto; position: relative;">
		<div class="notes">
			<h3>Notes</h3>
			<p style="overflow: auto; white-space: pre-line;">
				{scene?.notes || ""}
			</p>
			{#if scene?.dcas}
				{@const dcas = [...scene?.dcas].filter(([_, { mics }]) => mics.size).sort(([a], [b]) => a - b)}
				{#if dcas.length}
					<h3>DCAs</h3>
					<ul>
						{#each dcas as [dca, { name }]}
							<li>{dca}: {name}</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</div>
	</div>
</div>

<style lang="scss">
	@use "sass:color";

	.scene {
		display: grid;
		grid-template-columns: 4fr 1fr;
		gap: var(--spacing-required);
		padding: var(--spacing);
		border-radius: var(--rounding);
		border: 2px solid var(--green);
		opacity: var(--opacity);
		// :global(.miniMode) & {
		// 	height: unset;
		// 	max-height: 10em;
		// }
	}
	.mics {
		display: flex;
		flex-direction: column;
		gap: var(--spacing);
	}
	.scene.live {
		border-color: var(--red);
	}
	.channels {
		display: grid;
		gap: var(--spacing);
		grid-template-columns: repeat(8, 1fr);
		grid-auto-rows: 1fr;
		:global(.miniMode) & {
			grid-auto-rows: unset;
		}
	}
	.channel {
		height: 4em;
		border-radius: calc(var(--rounding) * 0.8);
		padding: calc(var(--spacing) * 0.8);
		border: 2px solid var(--fg);
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		min-width: 0;
		overflow: hidden;
		transition: 120ms;
		position: relative;
		> h3,
		p {
			white-space: nowrap;
			text-overflow: ellipsis;
			overflow: hidden;
		}
		:global(.miniMode) & {
			height: unset;
		}
		* {
			z-index: 30;
		}
	}

	.actorLabel {
		border: 4px solid transparent;
		border-radius: calc(var(--rounding) * 1 / 3);
		position: relative;
		top: 4px;
		right: 4px;
		width: 100%;
		> * {
			z-index: 30;
		}
		&.actorChanging {
			transition: 360ms;
			transition-delay: 120ms;
			background: #fe0;
			color: #000;
		}
	}

	// .meteringEnabled .actorLabel.actorChanging {
	// 	background: #ff04;
	// 	color: white;
	// }

	.bigLabel {
		font-size: 0.9em;
		font-weight: 600;
	}
	.smallLabel,
	.actorLabel:not(.bigLabel) {
		font-size: 0.8em;
		font-weight: 200;
	}

	.accent {
		border-color: transparent;
	}

	.disabled {
		background: #333;
		border-color: transparent;
	}
	.disabled.accent {
		background: color.change($color: #17e, $saturation: 20%);
	}

	.dne {
		opacity: 0.2;
	}
	.notes {
		// overflow: auto;
		position: absolute;
		top: 0;
		left: 0;
		min-width: 0;
		// max-height: 100%;
		// white-space: pre-line;

		h3 {
			margin-block: 0.2em;
		}
		ul {
			list-style: none;
			padding: 0;
		}
	}
	.liveBadge {
		background: var(--red);
		color: var(--red-text);
		font-weight: 600;
		text-transform: uppercase;
		font-size: 0.75em;
		padding: 0.1em 0.2em;
		border-radius: min(0.2em, var(--rounding));
		vertical-align: text-bottom;
	}

	.menu {
		position: absolute;
		top: 0.1em;
		right: 0.1em;
		cursor: pointer;
	}
</style>
