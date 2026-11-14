/**
 * Armin says hi! A fun easter egg with animated XBM art.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// XBM image: 31x36 pixels, LSB first, 1=background, 0=foreground
const WIDTH = 31;
const HEIGHT = 36;
const BITS = [
	0xff, 0xff, 0xff, 0x7f, 0xff, 0xf0, 0xff, 0x7f, 0xff, 0xed, 0xff, 0x7f, 0xff, 0xdb, 0xff, 0x7f, 0xff, 0xb7, 0xff,
	0x7f, 0xff, 0x77, 0xfe, 0x7f, 0x3f, 0xf8, 0xfe, 0x7f, 0xdf, 0xff, 0xfe, 0x7f, 0xdf, 0x3f, 0xfc, 0x7f, 0x9f, 0xc3,
	0xfb, 0x7f, 0x6f, 0xfc, 0xf4, 0x7f, 0xf7, 0x0f, 0xf7, 0x7f, 0xf7, 0xff, 0xf7, 0x7f, 0xf7, 0xff, 0xe3, 0x7f, 0xf7,
	0x07, 0xe8, 0x7f, 0xef, 0xf8, 0x67, 0x70, 0x0f, 0xff, 0xbb, 0x6f, 0xf1, 0x00, 0xd0, 0x5b, 0xfd, 0x3f, 0xec, 0x53,
	0xc1, 0xff, 0xef, 0x57, 0x9f, 0xfd, 0xee, 0x5f, 0x9f, 0xfc, 0xae, 0x5f, 0x1f, 0x78, 0xac, 0x5f, 0x3f, 0x00, 0x50,
	0x6c, 0x7f, 0x00, 0xdc, 0x77, 0xff, 0xc0, 0x3f, 0x78, 0xff, 0x01, 0xf8, 0x7f, 0xff, 0x03, 0x9c, 0x78, 0xff, 0x07,
	0x8c, 0x7c, 0xff, 0x0f, 0xce, 0x78, 0xff, 0xff, 0xcf, 0x7f, 0xff, 0xff, 0xcf, 0x78, 0xff, 0xff, 0xdf, 0x78, 0xff,
	0xff, 0xdf, 0x7d, 0xff, 0xff, 0x3f, 0x7e, 0xff, 0xff, 0xff, 0x7f,
];

const BYTES_PER_ROW = Math.ceil(WIDTH / 8);
const DISPLAY_HEIGHT = Math.ceil(HEIGHT / 2); // Half-block rendering

type Effect = "typewriter" | "scanline" | "rain" | "fade" | "crt" | "glitch" | "dissolve";

const EFFECTS: Effect[] = ["typewriter", "scanline", "rain", "fade", "crt", "glitch", "dissolve"];

// Get pixel at (x, y): true = foreground, false = background
function getPixel(x: number, y: number): boolean {
	if (y >= HEIGHT) return false;
	const byteIndex = y * BYTES_PER_ROW + Math.floor(x / 8);
	const bitIndex = x % 8;
	const byte = BITS[byteIndex];
	if (byte === undefined) throw new Error(`Missing image byte at index ${byteIndex}`);
	return ((byte >> bitIndex) & 1) === 0;
}

// Get the character for a cell (2 vertical pixels packed)
function getChar(x: number, row: number): string {
	const upper = getPixel(x, row * 2);
	const lower = getPixel(x, row * 2 + 1);
	if (upper && lower) return "█";
	if (upper) return "▀";
	if (lower) return "▄";
	return " ";
}

// Build the final image grid
function buildFinalGrid(): string[][] {
	const grid: string[][] = [];
	for (let row = 0; row < DISPLAY_HEIGHT; row++) {
		const line: string[] = [];
		for (let x = 0; x < WIDTH; x++) {
			line.push(getChar(x, row));
		}
		grid.push(line);
	}
	return grid;
}

export class ArminComponent implements Component {
	private ui: TUI;
	private interval: ReturnType<typeof setInterval> | null = null;
	private effect: Effect;
	private finalGrid: string[][];
	private currentGrid: string[][];
	private effectState: Record<string, unknown> = {};
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private gridVersion = 0;
	private cachedVersion = -1;

	constructor(ui: TUI) {
		this.ui = ui;
		const effect = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
		if (effect === undefined) throw new Error("Missing animation effect");
		this.effect = effect;
		this.finalGrid = buildFinalGrid();
		this.currentGrid = this.createEmptyGrid();

		this.initEffect();
		this.startAnimation();
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.gridVersion) {
			return this.cachedLines;
		}

		const padding = 1;
		const availableWidth = width - padding;

		this.cachedLines = this.currentGrid.map((row) => {
			// Clip row to available width before applying color
			const clipped = row.slice(0, availableWidth).join("");
			const padRight = Math.max(0, width - padding - clipped.length);
			return ` ${theme.fg("accent", clipped)}${" ".repeat(padRight)}`;
		});

		// Add "ARMIN SAYS HI" at the end
		const message = "ARMIN SAYS HI";
		const msgPadRight = Math.max(0, width - padding - message.length);
		this.cachedLines.push(` ${theme.fg("accent", message)}${" ".repeat(msgPadRight)}`);

		this.cachedWidth = width;
		this.cachedVersion = this.gridVersion;

		return this.cachedLines;
	}

	private createEmptyGrid(): string[][] {
		return Array.from({ length: DISPLAY_HEIGHT }, () => Array(WIDTH).fill(" "));
	}

	private initEffect(): void {
		switch (this.effect) {
			case "typewriter":
				this.effectState = { pos: 0 };
				break;
			case "scanline":
				this.effectState = { row: 0 };
				break;
			case "rain":
				// Track falling position for each column
				this.effectState = {
					drops: Array.from({ length: WIDTH }, () => ({
						y: -Math.floor(Math.random() * DISPLAY_HEIGHT * 2),
						settled: 0,
					})),
				};
				break;
			case "fade": {
				// Shuffle all pixel positions
				const positions: [number, number][] = [];
				for (let row = 0; row < DISPLAY_HEIGHT; row++) {
					for (let x = 0; x < WIDTH; x++) {
						positions.push([row, x]);
					}
				}
				// Fisher-Yates shuffle
				for (let i = positions.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					const current = positions[i];
					const target = positions[j];
					if (current === undefined || target === undefined)
						throw new Error(`Missing fade position at index ${i}`);
					[positions[i], positions[j]] = [target, current];
				}
				this.effectState = { positions, idx: 0 };
				break;
			}
			case "crt":
				this.effectState = { expansion: 0 };
				break;
			case "glitch":
				this.effectState = { phase: 0, glitchFrames: 8 };
				break;
			case "dissolve": {
				// Start with random noise
				this.currentGrid = Array.from({ length: DISPLAY_HEIGHT }, () =>
					Array.from({ length: WIDTH }, () => {
						const chars = [" ", "░", "▒", "▓", "█", "▀", "▄"];
						const char = chars[Math.floor(Math.random() * chars.length)];
						if (char === undefined) throw new Error("Missing dissolve character");
						return char;
					}),
				);
				// Shuffle positions for gradual resolve
				const dissolvePositions: [number, number][] = [];
				for (let row = 0; row < DISPLAY_HEIGHT; row++) {
					for (let x = 0; x < WIDTH; x++) {
						dissolvePositions.push([row, x]);
					}
				}
				for (let i = dissolvePositions.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					const current = dissolvePositions[i];
					const target = dissolvePositions[j];
					if (current === undefined || target === undefined)
						throw new Error(`Missing dissolve position at index ${i}`);
					[dissolvePositions[i], dissolvePositions[j]] = [target, current];
				}
				this.effectState = { positions: dissolvePositions, idx: 0 };
				break;
			}
		}
	}

	private startAnimation(): void {
		const fps = this.effect === "glitch" ? 60 : 30;
		this.interval = setInterval(() => {
			const done = this.tickEffect();
			this.updateDisplay();
			this.ui.requestRender();
			if (done) {
				this.stopAnimation();
			}
		}, 1000 / fps);
	}

	private stopAnimation(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private tickEffect(): boolean {
		switch (this.effect) {
			case "typewriter":
				return this.tickTypewriter();
			case "scanline":
				return this.tickScanline();
			case "rain":
				return this.tickRain();
			case "fade":
				return this.tickFade();
			case "crt":
				return this.tickCrt();
			case "glitch":
				return this.tickGlitch();
			case "dissolve":
				return this.tickDissolve();
			default:
				return true;
		}
	}

	private tickTypewriter(): boolean {
		const state = this.effectState as { pos: number };
		const pixelsPerFrame = 3;

		for (let i = 0; i < pixelsPerFrame; i++) {
			const row = Math.floor(state.pos / WIDTH);
			const x = state.pos % WIDTH;
			if (row >= DISPLAY_HEIGHT) return true;
			const currentRow = this.currentGrid[row];
			const pixel = this.finalGrid[row]?.[x];
			if (currentRow === undefined || pixel === undefined)
				throw new Error(`Missing typewriter pixel at ${row},${x}`);
			currentRow[x] = pixel;
			state.pos++;
		}
		return false;
	}

	private tickScanline(): boolean {
		const state = this.effectState as { row: number };
		if (state.row >= DISPLAY_HEIGHT) return true;

		// Copy row
		const currentRow = this.currentGrid[state.row];
		const finalRow = this.finalGrid[state.row];
		if (currentRow === undefined || finalRow === undefined) throw new Error(`Missing scanline row ${state.row}`);
		for (let x = 0; x < WIDTH; x++) {
			const pixel = finalRow[x];
			if (pixel === undefined) throw new Error(`Missing scanline pixel at ${state.row},${x}`);
			currentRow[x] = pixel;
		}
		state.row++;
		return false;
	}

	private tickRain(): boolean {
		const state = this.effectState as {
			drops: { y: number; settled: number }[];
		};

		let allSettled = true;
		this.currentGrid = this.createEmptyGrid();

		for (const [x, drop] of state.drops.entries()) {
			// Draw settled pixels
			for (let row = DISPLAY_HEIGHT - 1; row >= DISPLAY_HEIGHT - drop.settled; row--) {
				if (row >= 0) {
					const currentRow = this.currentGrid[row];
					const finalPixel = this.finalGrid[row]?.[x];
					if (currentRow === undefined || finalPixel === undefined) {
						throw new Error(`Missing settled rain pixel at ${row},${x}`);
					}
					currentRow[x] = finalPixel;
				}
			}

			// Check if this column is done
			if (drop.settled >= DISPLAY_HEIGHT) continue;

			allSettled = false;

			// Find the target row for this column (lowest non-space pixel)
			let targetRow = -1;
			for (let row = DISPLAY_HEIGHT - 1 - drop.settled; row >= 0; row--) {
				const pixel = this.finalGrid[row]?.[x];
				if (pixel === undefined) throw new Error(`Missing rain target pixel at ${row},${x}`);
				if (pixel !== " ") {
					targetRow = row;
					break;
				}
			}

			// Move drop down
			drop.y++;

			// Draw falling drop
			if (drop.y >= 0 && drop.y < DISPLAY_HEIGHT) {
				if (targetRow >= 0 && drop.y >= targetRow) {
					// Settle
					drop.settled = DISPLAY_HEIGHT - targetRow;
					drop.y = -Math.floor(Math.random() * 5) - 1;
				} else {
					// Still falling
					const currentRow = this.currentGrid[drop.y];
					if (currentRow === undefined) throw new Error(`Missing falling rain row ${drop.y}`);
					currentRow[x] = "▓";
				}
			}
		}

		return allSettled;
	}

	private tickFade(): boolean {
		const state = this.effectState as { positions: [number, number][]; idx: number };
		const pixelsPerFrame = 15;

		for (let i = 0; i < pixelsPerFrame; i++) {
			if (state.idx >= state.positions.length) return true;
			const position = state.positions[state.idx];
			if (position === undefined) throw new Error(`Missing fade position at index ${state.idx}`);
			const [row, x] = position;
			const currentRow = this.currentGrid[row];
			const finalPixel = this.finalGrid[row]?.[x];
			if (currentRow === undefined || finalPixel === undefined) throw new Error(`Missing fade pixel at ${row},${x}`);
			currentRow[x] = finalPixel;
			state.idx++;
		}
		return false;
	}

	private tickCrt(): boolean {
		const state = this.effectState as { expansion: number };
		const midRow = Math.floor(DISPLAY_HEIGHT / 2);

		this.currentGrid = this.createEmptyGrid();

		// Draw from middle expanding outward
		const top = midRow - state.expansion;
		const bottom = midRow + state.expansion;

		for (let row = Math.max(0, top); row <= Math.min(DISPLAY_HEIGHT - 1, bottom); row++) {
			const currentRow = this.currentGrid[row];
			const finalRow = this.finalGrid[row];
			if (currentRow === undefined || finalRow === undefined) throw new Error(`Missing CRT row ${row}`);
			for (let x = 0; x < WIDTH; x++) {
				const pixel = finalRow[x];
				if (pixel === undefined) throw new Error(`Missing CRT pixel at ${row},${x}`);
				currentRow[x] = pixel;
			}
		}

		state.expansion++;
		return state.expansion > DISPLAY_HEIGHT;
	}

	private tickGlitch(): boolean {
		const state = this.effectState as { phase: number; glitchFrames: number };

		if (state.phase < state.glitchFrames) {
			// Glitch phase: show corrupted version
			this.currentGrid = this.finalGrid.map((row) => {
				const offset = Math.floor(Math.random() * 7) - 3;
				const glitchRow = [...row];

				// Random horizontal offset
				if (Math.random() < 0.3) {
					const shifted = glitchRow.slice(offset).concat(glitchRow.slice(0, offset));
					return shifted.slice(0, WIDTH);
				}

				// Random vertical swap
				if (Math.random() < 0.2) {
					const swapRow = Math.floor(Math.random() * DISPLAY_HEIGHT);
					const row = this.finalGrid[swapRow];
					if (row === undefined) throw new Error(`Missing glitch row ${swapRow}`);
					return [...row];
				}

				return glitchRow;
			});
			state.phase++;
			return false;
		}

		// Final frame: show clean image
		this.currentGrid = this.finalGrid.map((row) => [...row]);
		return true;
	}

	private tickDissolve(): boolean {
		const state = this.effectState as { positions: [number, number][]; idx: number };
		const pixelsPerFrame = 20;

		for (let i = 0; i < pixelsPerFrame; i++) {
			if (state.idx >= state.positions.length) return true;
			const position = state.positions[state.idx];
			if (position === undefined) throw new Error(`Missing dissolve position at index ${state.idx}`);
			const [row, x] = position;
			const currentRow = this.currentGrid[row];
			const finalPixel = this.finalGrid[row]?.[x];
			if (currentRow === undefined || finalPixel === undefined)
				throw new Error(`Missing dissolve pixel at ${row},${x}`);
			currentRow[x] = finalPixel;
			state.idx++;
		}
		return false;
	}

	private updateDisplay(): void {
		this.gridVersion++;
	}

	dispose(): void {
		this.stopAnimation();
	}
}
