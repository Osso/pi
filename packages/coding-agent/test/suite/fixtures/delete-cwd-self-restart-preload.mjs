import { rmSync } from "node:fs";

const cwd = process.cwd();
rmSync(cwd, { recursive: true, force: true });
process.env.PI_SELF_RESTART_REQUEST = "1";
process.env.PI_SELF_RESTART_SESSION = process.env.PI_TEST_RESTART_SESSION;
process.env.PI_SELF_RESTART_PROMPT = "Restarted after cwd deletion.";
process.env.PI_SELF_RESTART_OLD_PID = process.pid.toString();
