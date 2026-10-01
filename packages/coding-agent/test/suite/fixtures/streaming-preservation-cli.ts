import { join } from "node:path";

if (!process.execve) throw new Error("Streaming preservation launcher requires process.execve");
const binary = process.env.PI_STREAMING_REGRESSION_BINARY;
const cliPath = join(import.meta.dirname, "../../../src/cli.ts");
const providerPath = join(import.meta.dirname, "streaming-preservation-provider.ts");
const args = [...process.argv.slice(2), "--extension", providerPath];
const executable = binary ?? process.execPath;
const argv = binary ? [binary, ...args] : [process.execPath, "--experimental-strip-types", cliPath, ...args];
process.execve(executable, argv, process.env);
