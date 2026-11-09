import { posix } from "node:path";

export function canonicalOutputPathForDependency(sourcePath, workspaceOutputPaths) {
	if (sourcePath.startsWith("node_modules/")) {
		return sourcePath;
	}

	for (const [workspacePath, outputPath] of workspaceOutputPaths) {
		if (sourcePath.startsWith(`${workspacePath}/`)) {
			const remainder = sourcePath.slice(workspacePath.length + 1);
			return [outputPath, remainder].filter(Boolean).join("/");
		}
	}
}

export function findOutputPath(name, outputFrom, sourcePath, outputPackages, emittedOrigins) {
	let directory = outputFrom;

	while (directory) {
		const candidate = `${directory}/node_modules/${name}`;
		if (!outputPackages[candidate] || emittedOrigins.get(candidate) === sourcePath) {
			return candidate;
		}

		directory = posix.dirname(directory);
		if (directory === ".") {
			directory = "";
		}
	}

	const rootCandidate = `node_modules/${name}`;
	if (!outputPackages[rootCandidate] || emittedOrigins.get(rootCandidate) === sourcePath) {
		return rootCandidate;
	}
	throw new Error(`Conflicting output package ${rootCandidate}: ${emittedOrigins.get(rootCandidate)} and ${sourcePath}`);
}

export function resolveOutputDependency(packages, packageName, fromPath) {
	let current = fromPath;
	while (current) {
		const candidate = `${current}/node_modules/${packageName}`;
		const entry = packages[candidate];
		if (entry && !entry.link) {
			return candidate;
		}

		current = posix.dirname(current);
		if (current === ".") {
			current = "";
		}
	}

	const rootCandidate = `node_modules/${packageName}`;
	if (packages[rootCandidate] && !packages[rootCandidate].link) {
		return rootCandidate;
	}
	throw new Error(`Cannot resolve ${packageName} from ${fromPath || "root"}`);
}

export function outputPathForDependency(name, outputFrom, sourcePath, outputPackages, emittedOrigins, workspaceOutputPaths) {
	const canonicalPath = canonicalOutputPathForDependency(sourcePath, workspaceOutputPaths);
	if (canonicalPath && (!outputPackages[canonicalPath] || emittedOrigins.get(canonicalPath) === sourcePath)) {
		return canonicalPath;
	}

	return findOutputPath(name, outputFrom, sourcePath, outputPackages, emittedOrigins);
}
