/**
 * Child-process probe for `vib ultragoal --help`: renders the command help
 * with an isolated HOME/VIB_CONFIG_DIR so tests can assert that a read-only
 * help request performs NO workflow-settings migration.
 */
import Ultragoal from "../../src/commands/ultragoal";

const cmd = new Ultragoal(["--help"], {
	bin: "vib",
	version: "test",
	commands: new Map([["ultragoal", Ultragoal]]),
});
await cmd.run();
