import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Whether a git package checkout declares a dependency that is missing from its node_modules,
 * e.g. after an update moved HEAD but its dependency install failed (port of upstream b06dc76fd).
 */
export function hasMissingGitDependencies(targetDir: string): boolean {
	const packageJsonPath = join(targetDir, "package.json");
	if (!existsSync(packageJsonPath)) return false;
	let dependencies: unknown;
	try {
		dependencies = (JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { dependencies?: unknown }).dependencies;
	} catch {
		// An unreadable manifest fails the install itself; there is nothing to compare here.
		return false;
	}
	if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return false;
	const nodeModulesDir = resolve(targetDir, "node_modules");
	return Object.keys(dependencies).some((name) => {
		const dependencyPath = resolve(nodeModulesDir, name);
		return dependencyPath.startsWith(`${nodeModulesDir}${sep}`) && !existsSync(dependencyPath);
	});
}
