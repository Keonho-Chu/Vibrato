import type { PresetDef, StatusLinePreset } from "./types";

export const STATUS_LINE_PRESETS: Record<StatusLinePreset, PresetDef> = {
	default: {
		// Every informational segment is on by default. Each one hides itself when
		// it has no value, so a self-hosted model with no per-token price simply
		// shows its token counts and omits the cost.
		//
		// `usage` is scoped to `gateway` here, which is what separates this preset
		// from `default-usage`. A budget a usage gateway reports about your own key
		// is a limit you are about to hit, and it arrives free: it rides on the
		// responses the session already receives, so showing it costs no request
		// and needs no account. The subscription windows in the same segment are
		// the opposite — they exist only because the client polls a provider usage
		// endpoint — so they stay behind the explicit `default-usage` opt-in and
		// the poll stays off here. See `#usageWindows` in `tool-status-header.ts`.
		leftSegments: ["model", "mode", "git", "pr", "path"],
		rightSegments: ["session_name", "jobs", "token_in", "token_out", "token_rate", "cache_read", "usage", "cost"],
		separator: "slash",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 32, stripWorkPrefix: true },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
			usage: { windows: "gateway" },
		},
	},

	"default-usage": {
		// The default layout with the `usage` segment widened to every window:
		// the observed gateway budget plus the polled OAuth/subscription windows.
		leftSegments: ["model", "mode", "git", "pr", "path"],
		rightSegments: ["session_name", "jobs", "token_in", "token_out", "token_rate", "cache_read", "usage", "cost"],
		separator: "slash",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 32, stripWorkPrefix: true },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
			usage: { windows: "all" },
		},
	},

	minimal: {
		leftSegments: ["path", "git"],
		rightSegments: ["session_name", "jobs", "mode", "context_pct"],
		separator: "slash",
		segmentOptions: {
			path: { abbreviate: true, maxLength: 30 },
			git: { showBranch: true, showStaged: false, showUnstaged: false, showUntracked: false },
		},
	},

	compact: {
		leftSegments: ["model", "mode", "git", "pr"],
		rightSegments: ["session_name", "jobs", "cost"],
		separator: "slash",
		segmentOptions: {
			model: { showThinkingLevel: false },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: false },
		},
	},

	full: {
		leftSegments: ["vibrato", "hostname", "model", "mode", "path", "git", "pr", "subagents"],
		rightSegments: [
			"session_name",
			"jobs",
			"token_in",
			"token_out",
			"token_rate",
			"cache_read",
			"cost",
			"time_spent",
			"time",
		],
		separator: "powerline",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 50 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
			time: { format: "24h", showSeconds: false },
		},
	},

	nerd: {
		// Full preset with all Nerd Font icons
		leftSegments: ["vibrato", "hostname", "model", "mode", "path", "git", "pr", "session", "subagents"],
		rightSegments: [
			"session_name",
			"jobs",
			"token_in",
			"token_out",
			"cache_read",
			"cache_write",
			"token_rate",
			"cost",
			"context_total",
			"time_spent",
			"time",
		],
		separator: "powerline",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 60 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
			time: { format: "24h", showSeconds: true },
		},
	},

	ascii: {
		// No Nerd Font dependencies
		leftSegments: ["model", "mode", "path", "git", "pr"],
		rightSegments: ["session_name", "jobs", "token_total", "cost"],
		separator: "ascii",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 40 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
		},
	},

	custom: {
		// User-defined - these are just defaults that get overridden
		leftSegments: ["model", "mode", "path", "git", "pr"],
		rightSegments: ["session_name", "jobs", "token_total", "cost"],
		separator: "slash",
		segmentOptions: {},
	},
};

export function getPreset(name: StatusLinePreset): PresetDef {
	return STATUS_LINE_PRESETS[name] ?? STATUS_LINE_PRESETS.default;
}
