/**
 * ANSI escape code to HTML converter.
 *
 * Converts terminal ANSI color/style codes to HTML with inline styles.
 * Supports:
 * - Standard foreground colors (30-37) and bright variants (90-97)
 * - Standard background colors (40-47) and bright variants (100-107)
 * - 256-color palette (38;5;N and 48;5;N)
 * - RGB true color (38;2;R;G;B and 48;2;R;G;B)
 * - Text styles: bold (1), dim (2), italic (3), underline (4)
 * - Reset (0)
 * - OSC 8 hyperlinks to http, https and mailto URLs; other CSI, OSC and APC sequences and stray ESC are dropped
 */

// Standard ANSI color palette (0-15)
const ANSI_COLORS = [
	"#000000", // 0: black
	"#800000", // 1: red
	"#008000", // 2: green
	"#808000", // 3: yellow
	"#000080", // 4: blue
	"#800080", // 5: magenta
	"#008080", // 6: cyan
	"#c0c0c0", // 7: white
	"#808080", // 8: bright black
	"#ff0000", // 9: bright red
	"#00ff00", // 10: bright green
	"#ffff00", // 11: bright yellow
	"#0000ff", // 12: bright blue
	"#ff00ff", // 13: bright magenta
	"#00ffff", // 14: bright cyan
	"#ffffff", // 15: bright white
];

/**
 * Convert 256-color index to hex.
 */
function color256ToHex(index: number): string {
	// Standard colors (0-15)
	if (index < 16) {
		const color = ANSI_COLORS[index];
		if (color === undefined) throw new Error(`ANSI color ${index} is missing`);
		return color;
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toComponent = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		const toHex = (n: number) => toComponent(n).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

interface TextStyle {
	fg: string | null;
	bg: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

function createEmptyStyle(): TextStyle {
	return {
		fg: null,
		bg: null,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
	};
}

function styleToInlineCSS(style: TextStyle): string {
	const parts: string[] = [];
	if (style.fg) parts.push(`color:${style.fg}`);
	if (style.bg) parts.push(`background-color:${style.bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");
	return parts.join(";");
}

function hasStyle(style: TextStyle): boolean {
	return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}

/**
 * Parse ANSI SGR (Select Graphic Rendition) codes and update style.
 */
function applySgrCode(params: number[], style: TextStyle): void {
	let i = 0;
	while (i < params.length) {
		const code = params[i];
		if (code === undefined) {
			i++;
			continue;
		}

		if (code === 0) {
			// Reset all
			style.fg = null;
			style.bg = null;
			style.bold = false;
			style.dim = false;
			style.italic = false;
			style.underline = false;
		} else if (code === 1) {
			style.bold = true;
		} else if (code === 2) {
			style.dim = true;
		} else if (code === 3) {
			style.italic = true;
		} else if (code === 4) {
			style.underline = true;
		} else if (code === 22) {
			// Reset bold/dim
			style.bold = false;
			style.dim = false;
		} else if (code === 23) {
			style.italic = false;
		} else if (code === 24) {
			style.underline = false;
		} else if (code >= 30 && code <= 37) {
			// Standard foreground colors
			const color = ANSI_COLORS[code - 30];
			if (color === undefined) throw new Error(`ANSI foreground color ${code} is missing`);
			style.fg = color;
		} else if (code === 38) {
			// Extended foreground color
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256-color: 38;5;N
				const index = params[i + 2];
				if (index === undefined) throw new Error("ANSI foreground color index is missing");
				style.fg = color256ToHex(index);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB: 38;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				if (r === undefined || g === undefined || b === undefined)
					throw new Error("ANSI foreground RGB value is missing");
				style.fg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 39) {
			// Default foreground
			style.fg = null;
		} else if (code >= 40 && code <= 47) {
			// Standard background colors
			const color = ANSI_COLORS[code - 40];
			if (color === undefined) throw new Error(`ANSI background color ${code} is missing`);
			style.bg = color;
		} else if (code === 48) {
			// Extended background color
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256-color: 48;5;N
				const index = params[i + 2];
				if (index === undefined) throw new Error("ANSI background color index is missing");
				style.bg = color256ToHex(index);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB: 48;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				if (r === undefined || g === undefined || b === undefined)
					throw new Error("ANSI background RGB value is missing");
				style.bg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 49) {
			// Default background
			style.bg = null;
		} else if (code >= 90 && code <= 97) {
			// Bright foreground colors
			const color = ANSI_COLORS[code - 90 + 8];
			if (color === undefined) throw new Error(`ANSI bright foreground color ${code} is missing`);
			style.fg = color;
		} else if (code >= 100 && code <= 107) {
			// Bright background colors
			const color = ANSI_COLORS[code - 100 + 8];
			if (color === undefined) throw new Error(`ANSI bright background color ${code} is missing`);
			style.bg = color;
		}
		// Ignore unrecognized codes

		i++;
	}
}

// SGR (ESC[...m), other CSI, OSC and APC sequences; OSC and APC end with BEL or ST.
const ANSI_REGEX =
	/\x1b\[([\d;]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
// OSC 8 hyperlink payload: "8;params;url"
const OSC8_REGEX = /^8;[^;]*;(.*)$/s;
const SAFE_LINK_REGEX = /^(?:https?:|mailto:)/i;

/** Remove every escape sequence the converter knows, plus stray ESC characters. */
export function stripAnsiEscapes(text: string): string {
	return text.replace(ANSI_REGEX, "").replace(/\x1b/g, "");
}

function escapeVisibleText(text: string): string {
	return escapeHtml(text.replace(/\x1b/g, ""));
}

/** The link an OSC 8 payload opens: "" closes the link or drops an unsafe URL; undefined is not OSC 8. */
function readHyperlinkTarget(payload: string | undefined): string | undefined {
	const rawUrl = payload === undefined ? undefined : OSC8_REGEX.exec(payload)?.[1];
	if (rawUrl === undefined) return undefined;
	// Browsers strip C0 controls from URLs, so strip them before checking the scheme.
	const url = rawUrl.trim().replace(/[\x00-\x1f\x7f]/g, "");
	return SAFE_LINK_REGEX.test(url) ? url : "";
}

/**
 * Convert ANSI-escaped text to HTML with inline styles.
 */
export function ansiToHtml(text: string): string {
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let inSpan = false;
	let inLink = false;
	// Spans stay nested inside links: style and link changes close and reopen the current span.
	const reopenSpanAround = (change: () => void) => {
		if (inSpan) result += "</span>";
		change();
		inSpan = hasStyle(style);
		if (inSpan) result += `<span style="${styleToInlineCSS(style)}">`;
	};

	for (const match of text.matchAll(ANSI_REGEX)) {
		result += escapeVisibleText(text.slice(lastIndex, match.index));
		lastIndex = match.index + match[0].length;
		const sgr = match[1];
		const target = readHyperlinkTarget(match[2]);
		if (sgr !== undefined) {
			reopenSpanAround(() => applySgrCode(sgr ? sgr.split(";").map((p) => parseInt(p, 10) || 0) : [0], style));
		} else if (target !== undefined) {
			reopenSpanAround(() => {
				if (inLink) result += "</a>";
				inLink = target !== "";
				if (inLink) result += `<a href="${escapeHtml(target)}">`;
			});
		}
		// Other CSI, OSC and APC sequences are dropped.
	}

	result += escapeVisibleText(text.slice(lastIndex));
	if (inSpan) result += "</span>";
	if (inLink) result += "</a>";
	return result;
}

/**
 * Convert array of ANSI-escaped lines to HTML.
 * Each line is wrapped in a div element.
 */
export function ansiLinesToHtml(lines: string[]): string {
	return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("");
}
