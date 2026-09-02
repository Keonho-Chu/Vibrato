/**
 * `vib customize` — customization inspection commands.
 *
 * Currently exposes a single subcommand: `doctor`, a read-only provenance and
 * status report over everything Vibrato discovers (MCP servers, skills, hooks,
 * tools, extensions, slash commands, plugin bundles).
 */
import { getProjectDir } from "@vib-rato/utils";
import { Args, Command, Flags, renderCommandHelp } from "@vib-rato/utils/cli";
import { runCustomizeDoctorCommand } from "../cli/customize-doctor";

const ACTIONS = ["doctor"] as const;

export default class Customize extends Command {
	static description = "Inspect discovered customizations (MCP, skills, hooks, tools, extensions, commands, plugins)";
	static delegateHelp = true;

	static examples = ["vib customize doctor", "vib customize doctor --json"];

	static args = {
		action: Args.string({
			description: "Customize action",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		json: Flags.boolean({
			char: "j",
			description: "Emit machine-readable JSON with secrets redacted",
			default: false,
		}),
	};

	async run(): Promise<void> {
		if (this.argv.includes("--help") || this.argv.includes("-h")) {
			this.#printHelp();
			return;
		}

		const { args, flags } = await this.parse(Customize);
		const action = (args.action ?? "doctor") as (typeof ACTIONS)[number];
		if (action !== "doctor") {
			renderCommandHelp("vib", "customize", Customize);
			return;
		}

		await runCustomizeDoctorCommand({ json: flags.json, cwd: getProjectDir() });
	}

	#printHelp(): void {
		process.stdout.write(`Inspect discovered customizations and their runtime status

USAGE
  $ vib customize doctor [FLAGS]

COMMANDS
  doctor  Provenance and status report for MCP servers, skills, hooks, tools,
          extensions, slash commands, and plugin bundles

FLAGS
  -j, --json  Emit machine-readable JSON with secrets redacted

EXAMPLES
  $ vib customize doctor
  $ vib customize doctor --json

WHAT IT REPORTS
  For every discovered item: source convention and scope (vib, Claude project,
  Codex project, plugin, explicit config), effective precedence and shadowing,
  runtime status (loaded/disabled/shadowed/rejected/quarantined/stored-only),
  a bounded reason code, remediation commands, trust requirements, and whether
  a new session is required for changes to take effect.

SAFETY
  This command is read-only. It never executes hooks, never connects MCP
  servers, and never prints credentials, endpoint tokens, auth headers, env
  values, or raw config dumps. MCP env variable names (not values) and
  redacted endpoints may appear; everything secret-shaped is replaced with
  <redacted>.
`);
	}
}
