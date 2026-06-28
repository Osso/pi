import { DynamicBorder as TuiDynamicBorder } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export class DynamicBorder extends TuiDynamicBorder {
	constructor(color: (line: string) => string = (line) => theme.fg("border", line)) {
		super(color);
	}
}
