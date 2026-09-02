import { Command } from "@vib-rato/utils/cli";
import { runVibNativeSkillHookCli } from "../hooks/native-skill-hook";

export default class CodexNativeHook extends Command {
	static description = "Run Vibrato native UserPromptSubmit/Stop skill-state hook";
	static strict = false;

	async run(): Promise<void> {
		await runVibNativeSkillHookCli();
	}
}
