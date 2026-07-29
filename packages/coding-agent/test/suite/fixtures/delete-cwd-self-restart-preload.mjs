import { rmSync } from "node:fs";
import { dirname } from "node:path";

const execve = process.execve;
if (typeof execve !== "function") {
	throw new Error("delete-cwd self-restart fixture requires process.execve");
}

process.execve = (file, args, env) => {
	const deletedCwd = process.cwd();
	rmSync(deletedCwd, { recursive: true, force: true });
	process.chdir(dirname(deletedCwd));
	execve(file, args, env);
};
