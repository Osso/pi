import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoDeployScript = fileURLToPath(new URL("../../../deploy.sh", import.meta.url));

describe("deploy.sh", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { force: true, recursive: true });
			tempDir = undefined;
		}
	});

	it("installs a PATH wrapper that runs pi from the source checkout", () => {
		const fixture = createDeployFixture();

		const result = runDeploy(fixture);

		expect(result).toMatchObject({ status: 0 });
		expect(result.stdout).toContain("0.79.10");
		const wrapper = readFileSync(join(fixture.installDir, "pi"), "utf8");
		expect(wrapper).toContain(`"PI_EXECUTABLE_NAME=pi-dev"`);
		expect(wrapper).toContain(`env "\${env_args[@]}" "${fixture.repoDir}/pi-test.sh" "$@"`);
		expect(readFileSync(join(fixture.repoDir, "npm-args.log"), "utf8")).toBe("run check\n");
		expect(readlinkSync(join(fixture.binDir, "pi-dev"))).toBe(join(fixture.installDir, "pi"));
	});

	it("replaces an existing install atomically", () => {
		const fixture = createDeployFixture();
		mkdirSync(fixture.installDir, { recursive: true });
		writeFileSync(join(fixture.installDir, "pi"), "old wrapper");

		const result = runDeploy(fixture);

		expect(result).toMatchObject({ status: 0 });
		expect(readFileSync(join(fixture.installDir, "pi"), "utf8")).toContain(`"PI_EXECUTABLE_NAME=pi-dev"`);
		expect(existsSync(`${fixture.installDir}.old`)).toBe(false);
		expect(existsSync(`${fixture.installDir}.tmp`)).toBe(false);
	});

	it("restores the previous install when the deployed binary fails validation", () => {
		const fixture = createDeployFixture({ piVersionExitCode: 2 });
		mkdirSync(fixture.installDir, { recursive: true });
		writeExecutable(
			join(fixture.installDir, "pi"),
			`#!/usr/bin/env bash
set -euo pipefail
printf 'old install\\n'
`,
		);

		const result = runDeploy(fixture);

		expect(result.status).toBe(2);
		expect(readFileSync(join(fixture.installDir, "pi"), "utf8")).toContain("old install");
		expect(existsSync(`${fixture.installDir}.old`)).toBe(false);
		expect(existsSync(`${fixture.installDir}.tmp`)).toBe(false);
	});

	it("rejects relative install directories before running checks", () => {
		const fixture = createDeployFixture();

		const result = runDeploy(fixture, { PI_DEV_INSTALL_DIR: "relative/pi" });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("PI_DEV_INSTALL_DIR must be an absolute path");
		expect(existsSync(join(fixture.repoDir, "npm-args.log"))).toBe(false);
	});

	it("rejects broad absolute install directories before running checks", () => {
		const fixture = createDeployFixture();

		const result = runDeploy(fixture, { PI_DEV_INSTALL_DIR: fixture.repoDir });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("PI_DEV_INSTALL_DIR is too broad to replace");
		expect(existsSync(join(fixture.repoDir, "npm-args.log"))).toBe(false);
	});

	function createDeployFixture(options: { piVersionExitCode?: number } = {}) {
		tempDir = mkdtempSync(join(tmpdir(), "pi-deploy-test-"));
		const repoDir = join(tempDir, "repo");
		const fakeBinDir = join(tempDir, "fake-bin");
		const installDir = join(tempDir, "install", "pi");
		const binDir = join(tempDir, "bin");

		mkdirSync(fakeBinDir, { recursive: true });
		mkdirSync(join(repoDir, "scripts"), { recursive: true });
		writeExecutable(
			join(fakeBinDir, "npm"),
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${repoDir}/npm-args.log"
`,
		);
		writeExecutable(
			join(repoDir, "pi-test.sh"),
			`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--version" ]]; then
  printf '0.79.10\\n'
  exit ${options.piVersionExitCode ?? 0}
fi
exit 2
`,
		);
		writeExecutable(
			join(repoDir, "scripts", "build-binaries.sh"),
			`#!/usr/bin/env bash
set -euo pipefail
platform=""
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      platform="$2"
      shift 2
      ;;
    --out)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$out/$platform"
cat > "$out/$platform/pi" <<'EOF'
#!/usr/bin/env bash
exec "${repoDir}/pi-test.sh" "$@"
EOF
chmod +x "$out/$platform/pi"
`,
		);
		writeFileSync(join(repoDir, "deploy.sh"), readFileSync(repoDeployScript));

		return { binDir, fakeBinDir, installDir, repoDir };
	}

	function runDeploy(fixture: ReturnType<typeof createDeployFixture>, envOverrides: Record<string, string> = {}) {
		return spawnSync("bash", [join(fixture.repoDir, "deploy.sh")], {
			cwd: fixture.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${fixture.fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
				PI_DEV_BIN_DIR: fixture.binDir,
				PI_DEV_INSTALL_DIR: fixture.installDir,
				...envOverrides,
			},
		});
	}
});

function writeExecutable(path: string, content: string) {
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}
