import { Command } from "@vib-rato/utils/cli";
import { runNativeStateCommand } from "../vib-runtime/state-runtime";

export default class State extends Command {
	static description =
		"Read or update current-session Vibrato workflow state receipts under .vib/_session-{sessionid}/state";
	static strict = false;
	static examples = [
		'$ vib state read --input \'{"mode":"deep-interview"}\' --json',
		'$ vib state write --input \'{"state":{"interview_id":"abc"}}\' --mode deep-interview --json',
		"$ vib state clear --mode deep-interview",
		"$ vib state deep-interview read --json",
		'$ vib state ralplan write --input \'{"phase":"planner","active":true}\' --json',
		"$ vib state autoresearch contract",
		"$ vib state deep-interview handoff --to ralplan --json",
		"$ vib state doctor --skill ralplan --json",
	];

	async run(): Promise<void> {
		const result = await runNativeStateCommand(this.argv);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
