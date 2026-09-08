import * as path from "node:path";
import {
	EXECUTION_SHOWCASE_STATES,
	EXECUTION_SHOWCASE_VIEWPORTS,
	renderExecutionShowcase,
} from "../test/fixtures/tui/execution-status-showcase";
import { ansiToHtml } from "./capture-sticky-viewport-showcase";

const SOURCES = [
	"packages/coding-agent/src/modes/execution-status.ts",
	"packages/coding-agent/src/modes/components/execution-status.ts",
	"packages/coding-agent/src/modes/components/tool-status-header.ts",
	"packages/coding-agent/src/modes/interactive-mode.ts",
	"packages/coding-agent/src/modes/controllers/event-controller.ts",
	"packages/coding-agent/src/modes/controllers/extension-ui-controller.ts",
	"packages/coding-agent/src/modes/DESIGN.md",
	"packages/coding-agent/test/fixtures/tui/execution-status-showcase.ts",
	"packages/coding-agent/scripts/capture-execution-status-showcase.ts",
] as const;
const hash = (data: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(data).digest("hex");

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length !== 2 || args[0] !== "--out")
		throw new Error(
			"Usage: bun packages/coding-agent/scripts/capture-execution-status-showcase.ts --out <directory>",
		);
	const root = path.resolve(args[1]!);
	const repositoryRoot = path.resolve(import.meta.dir, "../../..");
	const sources: Record<string, string> = {};
	for (const source of SOURCES)
		sources[source] = hash(new Uint8Array(await Bun.file(path.join(repositoryRoot, source)).arrayBuffer()));
	const entries: Array<{ key: string; artifacts: Record<string, string> }> = [];
	for (const state of EXECUTION_SHOWCASE_STATES) {
		for (const viewport of EXECUTION_SHOWCASE_VIEWPORTS) {
			const frames = await renderExecutionShowcase(state, viewport);
			for (const frame of frames) {
				if (!frame.focusedComposer || !frame.pinnedStatus)
					throw new Error(`Lost composer/pin: ${state}/${frame.position}`);
				for (const row of frame.summaryRows) {
					if (Bun.stringWidth(row) > viewport.columns)
						throw new Error(`Summary overflow: ${state}/${viewport.columns}`);
					if (row && !frame.terminalText.includes(row))
						throw new Error(`Summary hidden: ${state}/${frame.position}: ${row}`);
				}
				const key = `${state}/${viewport.columns}x${viewport.rows}/${frame.position}`;
				const payloads: Record<string, string> = {
					"terminal.txt": frame.terminalText,
					"terminal-ansi.txt": frame.terminalAnsi,
					"terminal.html": ansiToHtml(frame.terminalAnsi)
						.replaceAll("ui-monospace,monospace", "'DejaVu Sans Mono','Liberation Mono',monospace")
						.replace("<title>Sticky viewport showcase</title>", `<title>Execution status: ${key}</title>`),
					"metadata.json": `${JSON.stringify(
						{
							key,
							viewport,
							state,
							position: frame.position,
							capturedAt: new Date().toISOString(),
							command:
								"bun packages/coding-agent/scripts/capture-execution-status-showcase.ts --out <directory>",
							tool: { name: "Bun + VirtualTerminal (@xterm/headless)", version: Bun.version },
							mode: "fixture",
							livePty: false,
							network: false,
							source:
								"Deterministic presentation snapshots through production InteractiveMode and StatusLineComponent; event lifecycle tested separately",
							font: "DejaVu Sans Mono, Liberation Mono, monospace; browser CJK fallback is font-dependent; terminal-cell geometry is measured by xterm. HTML defaults #ffe7dc on #110b0b with explicit SGR styles preserved",
							wrapping:
								"ANSI-aware terminal cells; optional summary chunks omitted whole; detail truncated rather than wrapped",
							focusedComposer: frame.focusedComposer,
							pinnedStatus: frame.pinnedStatus,
							summaryRows: frame.summaryRows,
						},
						null,
						2,
					)}\n`,
				};
				const artifacts: Record<string, string> = {};
				for (const [name, content] of Object.entries(payloads)) {
					await Bun.write(path.join(root, key, name), content);
					artifacts[name] = hash(content);
				}
				entries.push({ key, artifacts });
			}
		}
	}
	await Bun.write(
		path.join(root, "manifest.json"),
		`${JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), sources, entries }, null, 2)}\n`,
	);
	process.stdout.write(`Captured ${entries.length} execution-status frames to ${root}\n`);
}

if (import.meta.main) await main();
