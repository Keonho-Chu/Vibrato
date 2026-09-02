import { Command, renderCommandHelp } from "@vib-rato/utils/cli";
import { ensureWorkflowSettingsMigrated } from "../config/settings";
import {
	isUltragoalCreateGoalsInvocation,
	readUltragoalVibObjective,
	VIB_SESSION_FILE_ENV,
	VIB_SESSION_ID_ENV,
	writeCurrentSessionGoalModeState,
	writePendingGoalModeRequest,
} from "../vib-runtime/goal-mode-request";
import { runNativeUltragoalCommand } from "../vib-runtime/ultragoal-runtime";

export default class Ultragoal extends Command {
	static description = "Run native Vibrato Ultragoal workflow commands";
	static strict = false;
	static examples = ["$ vib ultragoal status --json"];
	static delegateHelp = true;

	async run(): Promise<void> {
		// A read-only help request must not perform the workflow-settings
		// migration (which can create/drain agent.db, write config.yml, and
		// retire legacy settings.json): render help before the trigger.
		if (this.argv.includes("--help") || this.argv.includes("-h")) {
			renderCommandHelp("vib", "ultragoal", Ultragoal);
			return;
		}
		await ensureWorkflowSettingsMigrated(process.cwd());
		const isReviewStart = this.argv.includes("review") && this.argv.includes("review-start");
		const shouldActivateGoalMode = isUltragoalCreateGoalsInvocation(this.argv);
		const result = await runNativeUltragoalCommand(this.argv);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
		if (result.status !== 0 || (!shouldActivateGoalMode && !isReviewStart)) return;
		if (isReviewStart && !result.createdReviewPlan && (result.reviewBlockerGoalIds?.length ?? 0) === 0) return;

		const cwd = process.cwd();
		const { objective, goalsPath, provenance } = await readUltragoalVibObjective(cwd);

		await writeCurrentSessionGoalModeState({
			sessionFile: process.env[VIB_SESSION_FILE_ENV],
			objective,
			provenance,
		});
		await writePendingGoalModeRequest({
			cwd,
			objective,
			goalsPath,
			provenance,
			sessionId: process.env[VIB_SESSION_ID_ENV],
		});
	}
}
