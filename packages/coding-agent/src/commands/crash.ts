/**
 * `vib crash` — inspect local crash signatures and file an assisted, fully
 * consented bug report. `vib crash report` requires an explicit,
 * digest-confirmed confirmation for that exact invocation; `vib crash relay`
 * uses separately configured standing consent.
 */
import { Args, Command, Flags } from "@vib-rato/utils/cli";
import { runCrashListCommand, runCrashRelayCommand, runCrashReportCommand } from "../cli/crash-cli";
import { Settings } from "../config/settings";

export default class Crash extends Command {
	static description = "Inspect crash signatures and file an assisted bug report";
	static args = {
		action: Args.string({ description: "list | report | relay", required: false }),
	};
	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON (list only)", default: false }),
	};

	static examples = ["vib crash list", "vib crash list --json", "vib crash report", "vib crash relay"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Crash);
		const action = args.action ?? "list";
		if (action === "list") {
			await runCrashListCommand(flags.json === true);
			return;
		}
		if (action === "relay") {
			await runCrashRelayCommand(await Settings.loadReadonly({ cwd: process.cwd() }));
			return;
		}
		if (action !== "report") {
			process.stderr.write(`Unknown action "${action}". Expected: list, report, relay.\n`);
			process.exitCode = 1;
			return;
		}
		const outcome = await runCrashReportCommand();
		if (outcome.status === "refused" || outcome.status === "unmatchable") process.exitCode = 1;
	}
}
