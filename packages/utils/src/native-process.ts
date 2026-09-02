/**
 * Lazy synchronous binding for @vib-rato/natives process control.
 *
 * The natives package entry loads the compiled addon at import time, so a
 * static import anywhere in the `@vib-rato/utils` root barrel graph would
 * materialize the addon for every barrel consumer. The W5b S1/idle
 * module-trace gate requires that merely importing the barrel never loads
 * @vib-rato/natives; process-control callers bind at first real use instead.
 */
type NativeProcessBindings = Pick<typeof import("@vib-rato/natives"), "Process" | "ProcessStatus">;

let bindings: NativeProcessBindings | undefined;

export function nativeProcessBindings(): NativeProcessBindings {
	if (!bindings) {
		bindings = require("@vib-rato/natives") as NativeProcessBindings;
	}
	return bindings;
}
