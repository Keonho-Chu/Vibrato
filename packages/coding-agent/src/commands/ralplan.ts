import { Command } from "@vib-rato/utils/cli";
import { ensureWorkflowSettingsMigrated } from "../config/settings";
import {
	assertExplicitTargetVibNotSymlinked,
	type RalplanCommandResult,
	resolveRalplanTargetRoot,
	runNativeRalplanCommand,
} from "../vib-runtime/ralplan-runtime";
import { CommandError } from "../vib-runtime/workflow-cli-common";

/** Public CLI path: validate --worktree-root before any settings migration, then dispatch. */
export async function runRalplanCliCommand(args: string[], cwd: string): Promise<RalplanCommandResult> {
	try {
		const target = await resolveRalplanTargetRoot(args, cwd);
		if (target.explicit) await assertExplicitTargetVibNotSymlinked(target.root);
		await ensureWorkflowSettingsMigrated(target.root);
	} catch (error) {
		if (error instanceof CommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		throw error;
	}
	return await runNativeRalplanCommand(args, cwd);
}

export default class Ralplan extends Command {
	static description = "Run native Vibrato RALPLAN consensus planning workflow";
	static strict = false;
	static examples = [
		'$ vib ralplan "<task description>"',
		'$ vib ralplan --interactive --deliberate "<task description>"',
		'$ vib ralplan --write --stage planner --stage_n 1 --artifact "<markdown or path>"',
		"$ vib ralplan --write --stage critic --stage_n 1 --artifact-env VIB_RALPLAN_ARTIFACT",
		'$ vib ralplan --worktree-root /abs/path/to/target-worktree "<task description>"',
		"$ vib ralplan --write --worktree-root /abs/path/to/target-worktree --session-id <owner> --run-id <run> --stage critic --stage_n 1 --artifact-env VIB_RALPLAN_ARTIFACT",
	];

	async run(): Promise<void> {
		const result = await runRalplanCliCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
