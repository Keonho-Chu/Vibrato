/** @type {import('tailwindcss').Config} */
import * as path from "node:path";
export default {
	content: [path.join(import.meta.dir, "src", "client", "**/*.{js,jsx,ts,tsx}")],
	darkMode: "class",
	theme: {
		extend: {
			colors: {
				page: "var(--bg-page)",
				surface: "var(--bg-surface)",
				elevated: "var(--bg-elevated)",
				"border-subtle": "var(--border-subtle)",
				"border-default": "var(--border-default)",
				"text-primary": "var(--text-primary)",
				"text-secondary": "var(--text-secondary)",
				"text-muted": "var(--text-muted)",
				pink: "var(--accent-pink)",
				cyan: "var(--accent-cyan)",
				violet: "var(--accent-violet)",
				brand: "var(--brand-blue)",
				brandGray: "var(--brand-gray)",
			},
			fontFamily: {
				sans: [
					'"KoPubDotum"',
					'"KoPub Dotum"',
					'"KoPubWorldDotum"',
					'"Nanum Gothic"',
					"-apple-system",
					'"Apple SD Gothic Neo"',
					'"Malgun Gothic"',
					'"Segoe UI"',
					"sans-serif",
				],
				display: [
					'"NanumSquare"',
					'"NanumSquareRound"',
					'"Nanum Gothic"',
					"-apple-system",
					'"Apple SD Gothic Neo"',
					'"Malgun Gothic"',
					'"Segoe UI"',
					"sans-serif",
				],
			},
			borderRadius: {
				sm: "var(--radius-sm)",
				md: "var(--radius-md)",
				lg: "var(--radius-lg)",
			},
		},
	},
	plugins: [],
};
