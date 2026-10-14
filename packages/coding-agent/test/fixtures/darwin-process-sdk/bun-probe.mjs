import { createRequire } from "node:module";
const requireNative = createRequire(import.meta.url);
const binding = requireNative(process.argv[2]);
const errors = {};
for (const pid of [4202, 4203, 4204, 4205, 4206]) {
	try {
		binding.readProcessInfo(pid);
	} catch (error) {
		errors[pid] = error.code;
	}
}
console.log(JSON.stringify({ live: binding.readProcessInfo(4200), zombie: binding.readProcessInfo(4201), errors }));
