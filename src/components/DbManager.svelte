<script lang="ts">
	import Papa from "papaparse";
	import { selectedConfigId } from "../lib/configState.svelte";
	import { configs, db, ddp, externalConfigs, storedConfigs, updateSheet, type Config, type DbConfig } from "../lib/db";
	import Page from "./Page.svelte";

	import "boxicons";
	import { makeToast } from "../lib/stores";

	type Edit = Partial<Config & { id: number }>;

	let editing: Partial<Edit> | undefined = $state();
	$inspect("editing", editing);

	async function addNew() {
		const newOne = await db.configs.add({} as DbConfig);
		console.log(newOne);
		editing = { id: newOne, ...ddp };
	}

	async function deleteCurrent() {
		if (editing?.id) {
			await db.configs.delete(editing.id);
			editing = {};
		}
	}

	$effect(() => {
		if (editing && editing.id) {
			db.configs.update(editing.id, $state.snapshot(editing));
		}
	});

	let exportedLink = $derived.by(() => {
		if (editing) {
			// export config as link with base64 encoded json
			try {
				let config = $storedConfigs.find((item) => item.id === editing?.id);

				let newConfig = { ...(config as Partial<DbConfig>) };

				delete newConfig.id;
				delete newConfig.table;
				delete newConfig.lastFetched;

				delete newConfig.fileHandle;

				const link = new URL(window.location.href);
				link.searchParams.set("config", btoa(JSON.stringify(newConfig)));
				return link.href;
			} catch (error) {
				console.error("error generating link", error);
			}
		}
		return "";
	});

	async function importLinkedConfig() {
		const linkedConfig: Partial<Config> = { ...$externalConfigs?.["linked"] };
		if (!linkedConfig) return;

		const sheetId = linkedConfig?.sheetId;
		if (!sheetId) return;

		delete linkedConfig.id;
		if (linkedConfig.table) delete linkedConfig.table;

		linkedConfig.name = linkedConfig.name?.replace(/^Linked: /, "");

		// @ts-expect-error
		const dbId = await db.configs.add({ ...linkedConfig });
		await new Promise<void>((resolve) => {
			Papa.parse<string[]>(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`, {
				download: true,
				header: false,
				complete: async function (results) {
					console.log(results);
					let data = results.data;
					db.configs.update(dbId, { table: data, lastFetched: new Date() });
					$selectedConfigId = dbId;
					resolve();
				},
			});
		});
	}
</script>

<Page id="dbConfig">
	{#snippet children({ closePage })}
		<h1>Config Manager</h1>
		<div>
			<button onclick={addNew}>Add New</button>
			{#if $configs.find((item) => item.id === "linked")}
				<button onclick={importLinkedConfig}>import Linked Config</button>
			{/if}
		</div>
		<div class="horiz" style="width: 100%; height: 600px">
			<div
				class="verti itemList"
				onkeydown={(e) => {
					if (e.key === "Delete") deleteCurrent();
				}}
				role="listbox"
				tabindex="0"
			>
				{#each $storedConfigs || [] as item}
					<button
						class="item"
						class:untitled={!item.name}
						class:selected={editing?.id === item.id}
						onclick={() => {
							console.log(item);
							editing = { ...item };
						}}
						ondblclick={() => {
							$selectedConfigId = item.id;
							closePage();
						}}
					>
						{item.name || "Untitled"}
					</button>
				{/each}
			</div>
			<div class="itemConfig verti">
				{#if editing && editing.id}
					<p>
						Name: <input type="text" bind:value={editing.name} />
						<button
							class="white"
							onclick={() => {
								$selectedConfigId = editing?.id || null;
								closePage();
							}}>Open Config</button
						>
					</p>
					<p>
						Source: <select bind:value={editing.source}>
							<option value="google-sheets">Google Sheets</option>
							<option value="file">Local File</option>
						</select>
					</p>
					{#if editing.source == "file"}
						<p>
							<button
								onclick={async (e) => {
									try {
										// todo: add support for other browsers
										const [fileHandle] = await (window as any).showOpenFilePicker({
											multiple: false,
											types: [
												{
													description: "CSV Files",
													accept: { "text/csv": [".csv"] },
												},
											],
										});

										if (fileHandle.kind !== "file") return;
										editing!.fileHandle = fileHandle;
										// file read through update mechanism
									} catch (e) {
										makeToast("Failed to access filesystem", "Check browser support", "error");
									}
								}}>Select File</button
							>
							{#if editing.fileHandle}{editing.fileHandle?.name}{/if}
						</p>
					{:else}
						<p>
							Google Sheets ID: <input type="text" placeholder="44 characters" bind:value={editing.sheetId} />
						</p>
					{/if}
					<p>
						Last fetched: {editing.lastFetched || "Never"}
						<button
							onclick={async () => {
								if (editing?.id) {
									let record = await updateSheet<DbConfig>(editing.id);
									editing = { ...record };
								}
							}}>Fetch Now</button
						>
					</p>
					<p>
						Notes Row: <input type="number" bind:value={editing.notesRow} />
					</p>
					<p>
						Scene Names Row: <input type="number" bind:value={editing.namesRow} />
					</p>
					<p>
						Flags Row: <input type="number" bind:value={editing.flagsRow} />
					</p>
					<p>
						Mics Start Row: <input type="number" bind:value={editing.micsStartRow} />
					</p>
					<p>
						Actor Names Column: <input type="number" bind:value={editing.actorNamesCol} />
					</p>
					<p>
						Scenes Start Column: <input type="number" bind:value={editing.scenesStartCol} />
					</p>
					{#if editing.table}
						<div style="width: 100%; display: flex; overflow: auto; min-height: 200px;">
							<table style="flex: 1; width: 100%; overflow: auto;">
								<tbody>
									{#each editing.table as row}
										<tr>
											{#each row as cell}
												<td>{cell}</td>
											{/each}
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				{/if}
				{#if editing && editing.id && exportedLink}
					<details>
						<summary>Export as link</summary>
						<a href={exportedLink} style="word-wrap: break-word;">{exportedLink}</a>
					</details>
				{/if}
				{#if editing && editing.id}
					<div style="margin-top: 24px;">
						<button class="red" onclick={deleteCurrent}>Delete Entry</button>
					</div>
				{/if}
			</div>
		</div>
	{/snippet}
</Page>

<style lang="scss">
	.itemList {
		width: 200px;
		height: 100%;
		overflow-y: auto;
		gap: 0;
		> button {
			padding: 4px;
			padding-block: 8px;
			border-radius: 0;
			border: none;
			text-align: left;
			&.selected {
				background-color: var(--accent);
				color: var(--accent-text);
			}
			&.untitled {
				color: #fff6;
				color: var(--text-dimmed);
				font-style: italic;
			}
		}
		border: 2px solid var(--fg);
		border-radius: calc(var(--rounding) * 1 / 3);
	}
	.itemConfig {
		// width: 500px;
		flex: 1;
		height: 100%;
		width: 100%;
		overflow-y: auto;
		gap: 8px;
	}
	table {
		border-collapse: collapse;
		td {
			white-space: nowrap;
			max-width: 100px;
			overflow: hidden;
			text-overflow: ellipsis;
			border: 1px solid var(--fg);
		}
	}
</style>
