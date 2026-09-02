/** Manage stored OAuth accounts without exposing credential payloads. */
import { Args, Command, Flags, renderCommandHelp } from "@vib-rato/utils/cli";
import {
	ACCOUNTS_ACTIONS,
	type AccountsAction,
	type AccountsCommandArgs,
	runAccountsCommand,
} from "../cli/accounts-cli";

export default class Accounts extends Command {
	static description = "List, check, pin, and remove stored OAuth accounts";
	static strict = true;

	static args = {
		action: Args.string({
			description: "Account action",
			required: false,
			options: [...ACCOUNTS_ACTIONS],
		}),
		provider: Args.string({
			description: "Provider id",
			required: false,
		}),
		selector: Args.string({
			description: "Account selector (bare email, id:, email:, or account:)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output safe machine-readable JSON" }),
		persistent: Flags.boolean({ description: "Required for persistent pin changes" }),
		clear: Flags.boolean({ description: "Clear the persistent pin" }),
		account: Flags.string({ description: "Logout one account by row id or email" }),
		all: Flags.boolean({ description: "Logout every OAuth account for the provider" }),
	};

	static examples = [
		"vib accounts list",
		"vib accounts list --json",
		"vib accounts check",
		"vib accounts check anthropic --json",
		"vib accounts pin anthropic me@example.com --persistent",
		"vib accounts pin anthropic id:42 --persistent",
		"vib accounts pin anthropic --clear --persistent",
		"vib accounts logout anthropic --account me@example.com",
		"vib accounts logout anthropic --all",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Accounts);
		if (!args.action) {
			renderCommandHelp("vib", "accounts", Accounts);
			return;
		}
		const action = args.action as AccountsAction;
		const cmd: AccountsCommandArgs = {
			action,
			provider: args.provider,
			selector: args.selector,
			flags: {
				json: flags.json,
				persistent: flags.persistent,
				clear: flags.clear,
				account: flags.account,
				all: flags.all,
			},
		};
		await runAccountsCommand(cmd);
	}
}
