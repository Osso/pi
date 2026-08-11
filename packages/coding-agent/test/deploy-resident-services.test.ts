import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const deployScript = fileURLToPath(new URL("../../../deploy.sh", import.meta.url));
const residentServicesScript = fileURLToPath(
	new URL("../../../scripts/configure-resident-services.sh", import.meta.url),
);

interface DeployFixture {
	binDir: string;
	buildDir: string;
	configureLog: string;
	deployRoot: string;
	installDir: string;
	stubBinDir: string;
}

interface DeployRunOptions {
	configureResidentServices?: string;
	machine?: string;
	system?: string;
}

interface ResidentServiceFixture {
	configHome: string;
	fakeBinDir: string;
	supervisorUnit: string;
	systemctlLog: string;
	systemctlState: string;
	systemdUserDir: string;
}

const NOOP_STUB = `#!/usr/bin/env bash
set -euo pipefail
`;
const UNAME_STUB = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
	-s) printf '%s\\n' "$PI_TEST_UNAME_SYSTEM" ;;
	-m) printf '%s\\n' "$PI_TEST_UNAME_MACHINE" ;;
	*) exit 1 ;;
esac
`;
const BUILD_BINARIES_STUB = `#!/usr/bin/env bash
set -euo pipefail
platform=""
out=""
while (($# > 0)); do
	case "$1" in
		--platform) platform="$2"; shift 2 ;;
		--out) out="$2"; shift 2 ;;
		*) shift ;;
	esac
done
mkdir -p "$out/$platform"
printf '%s\\n' '#!/usr/bin/env bash' 'if [[ "\${1:-}" == "--version" ]]; then printf "%s\\n" "0.80.3"; fi' > "$out/$platform/pi"
chmod 755 "$out/$platform/pi"
`;
const CONFIGURE_RESIDENT_SERVICES_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' "$1" "$2" >> "$PI_DEPLOY_CONFIGURE_LOG"
`;
const SYSTEMCTL_STUB = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const command = args[1];
const unit = args.find((arg) => arg.endsWith(".service"));
const statePath = process.env.PI_TEST_SYSTEMCTL_STATE;
const disabledUnits = new Set(existsSync(statePath) ? readFileSync(statePath, "utf8").split("\\n").filter(Boolean) : []);
const saveState = () => writeFileSync(statePath, [...disabledUnits].join("\\n"));
appendFileSync(process.env.PI_TEST_SYSTEMCTL_LOG, args.join(" ") + "\\n");
if (command === "cat" && unit === "pi-architect.service") process.exit(0);
if (command === "cat" && unit === "pi-supervisor.service") {
  process.stdout.write("# " + process.env.PI_TEST_SUPERVISOR_UNIT + "\\n" + readFileSync(process.env.PI_TEST_SUPERVISOR_UNIT, "utf8"));
  process.exit(0);
}
if (command === "disable" && unit) {
  disabledUnits.add(unit);
  saveState();
  process.exit(0);
}
if ((command === "is-active" || command === "is-enabled") && unit) process.exit(disabledUnits.has(unit) ? 1 : 0);
process.exit(0);
`;

function writeExecutable(path: string, contents: string): void {
	writeFileSync(path, contents, { mode: 0o755 });
	chmodSync(path, 0o755);
}

function createDeployFixture(parentDir: string): DeployFixture {
	const deployRoot = join(parentDir, "deploy-root");
	const scriptsDir = join(deployRoot, "scripts");
	const stubBinDir = join(parentDir, "stub-bin");
	const fixture = {
		binDir: join(parentDir, "bin"),
		buildDir: join(parentDir, "build"),
		configureLog: join(parentDir, "configure.log"),
		deployRoot,
		installDir: join(parentDir, "install"),
		stubBinDir,
	};
	mkdirSync(scriptsDir, { recursive: true });
	mkdirSync(stubBinDir, { recursive: true });
	writeFileSync(fixture.configureLog, "");
	copyFileSync(deployScript, join(deployRoot, "deploy.sh"));
	chmodSync(join(deployRoot, "deploy.sh"), 0o755);
	writeExecutable(join(stubBinDir, "node"), NOOP_STUB);
	writeExecutable(join(stubBinDir, "npm"), NOOP_STUB);
	writeExecutable(join(stubBinDir, "uname"), UNAME_STUB);
	writeExecutable(join(scriptsDir, "build-binaries.sh"), BUILD_BINARIES_STUB);
	writeExecutable(join(scriptsDir, "configure-resident-services.sh"), CONFIGURE_RESIDENT_SERVICES_STUB);
	writeFileSync(join(scriptsDir, "validate-systemd-exec-path.mjs"), "");
	return fixture;
}

function runDeploy(fixture: DeployFixture, options: DeployRunOptions = {}) {
	const homeDir = join(fixture.deployRoot, "home");
	mkdirSync(homeDir, { recursive: true });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: homeDir,
		PATH: `${fixture.stubBinDir}:${process.env.PATH ?? ""}`,
		PI_DEPLOY_BIN_DIR: fixture.binDir,
		PI_DEPLOY_BUILD_DIR: fixture.buildDir,
		PI_DEPLOY_INSTALL_DIR: fixture.installDir,
		PI_DEPLOY_CONFIGURE_LOG: fixture.configureLog,
		PI_TEST_UNAME_MACHINE: options.machine ?? "x86_64",
		PI_TEST_UNAME_SYSTEM: options.system ?? "Linux",
	};
	if (options.configureResidentServices === undefined) delete env.PI_DEPLOY_CONFIGURE_RESIDENT_SERVICES;
	else env.PI_DEPLOY_CONFIGURE_RESIDENT_SERVICES = options.configureResidentServices;
	return spawnSync("bash", [join(fixture.deployRoot, "deploy.sh")], {
		cwd: fixture.deployRoot,
		env,
		encoding: "utf8",
	});
}

function createResidentServiceFixture(parentDir: string): ResidentServiceFixture {
	const configHome = join(parentDir, "config");
	const systemdUserDir = join(configHome, "systemd", "user");
	const fakeBinDir = join(parentDir, "systemctl-bin");
	const fixture = {
		configHome,
		fakeBinDir,
		supervisorUnit: join(systemdUserDir, "pi-supervisor.service"),
		systemctlLog: join(parentDir, "systemctl.log"),
		systemctlState: join(parentDir, "systemctl-state"),
		systemdUserDir,
	};
	mkdirSync(fakeBinDir, { recursive: true });
	mkdirSync(systemdUserDir, { recursive: true });
	writeFileSync(join(systemdUserDir, "pi-architect.service"), "previous architect unit");
	writeFileSync(fixture.supervisorUnit, "previous supervisor unit");
	writeExecutable(join(fakeBinDir, "systemctl"), SYSTEMCTL_STUB);
	return fixture;
}

describe("resident service deployment", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-resident-deploy-"));
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("deploys with lazy Supervisor autostart ownership by default", () => {
		const fixture = createDeployFixture(tempDir);
		const result = runDeploy(fixture);

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(readFileSync(fixture.configureLog, "utf8")).toBe(`${join(fixture.binDir, "pi")}\tautostart\n`);
	});

	it("skips Linux resident-service configuration on macOS", () => {
		const fixture = createDeployFixture(tempDir);
		const result = runDeploy(fixture, { machine: "arm64", system: "Darwin" });

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(readFileSync(fixture.configureLog, "utf8")).toBe("");
	});

	it("configures a systemd-owned Supervisor only when explicitly enabled", () => {
		const fixture = createDeployFixture(tempDir);
		const result = runDeploy(fixture, { configureResidentServices: "1" });

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(readFileSync(fixture.configureLog, "utf8")).toBe(`${join(fixture.binDir, "pi")}\tsystemd\n`);
	});

	it("rejects invalid resident-service configuration before invoking it", () => {
		const fixture = createDeployFixture(tempDir);
		const result = runDeploy(fixture, { configureResidentServices: "enabled" });

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("PI_DEPLOY_CONFIGURE_RESIDENT_SERVICES");
		expect(readFileSync(fixture.configureLog, "utf8")).toBe("");
	});

	it("autostart mode disables every resident systemd unit without starting Supervisor", () => {
		const fixture = createResidentServiceFixture(tempDir);
		const result = spawnSync(residentServicesScript, ["/home/osso/.local/bin/pi", "autostart"], {
			encoding: "utf8",
			env: {
				...process.env,
				HOME: join(tempDir, "home"),
				PATH: `${fixture.fakeBinDir}:${process.env.PATH ?? ""}`,
				PI_TEST_SUPERVISOR_UNIT: fixture.supervisorUnit,
				PI_TEST_SYSTEMCTL_LOG: fixture.systemctlLog,
				PI_TEST_SYSTEMCTL_STATE: fixture.systemctlState,
				XDG_CONFIG_HOME: fixture.configHome,
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(join(fixture.systemdUserDir, "pi-architect.service"))).toBe(false);
		expect(existsSync(fixture.supervisorUnit)).toBe(false);
		expect(readFileSync(fixture.systemctlState, "utf8").trim().split("\n").sort()).toEqual([
			"pi-architect.service",
			"pi-supervisor.service",
		]);
		expect(readFileSync(fixture.systemctlLog, "utf8").trim().split("\n")).toEqual([
			"--user cat pi-architect.service",
			"--user disable --now pi-architect.service",
			"--user cat pi-supervisor.service --no-pager",
			"--user disable --now pi-supervisor.service",
			"--user daemon-reload",
			"--user is-active --quiet pi-architect.service",
			"--user is-enabled --quiet pi-architect.service",
			"--user is-active --quiet pi-supervisor.service",
			"--user is-enabled --quiet pi-supervisor.service",
		]);
	});
});
