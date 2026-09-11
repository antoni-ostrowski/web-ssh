// Pure OSC52 clipboard parser, no DOM. Bundle-safe and unit-testable with bun.
//
// Servers (tmux with `set-clipboard on`, neovim, etc.) emit:
//   ESC ] 52 ; Pc ; <base64> ST
// where ST is BEL (\x07) or ESC \ (\x1b\x5c).
// We only act on Pc == "c" (system clipboard); anything else passes through.
//
// Usage:
//   const strip = createOSC52Stripper((text) => { /* decoded clipboard text */ });
//   const clean = strip(chunk: Uint8Array) // -> Uint8Array without OSC52 sequences
//
// Sequences split across WebSocket frames are held internally until the
// terminator arrives, so normal output is never delayed.

const ESC = 0x1b;
const BEL = 0x07;

function concat(a, b) {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

// Longest suffix of `buf` (scanned region) that is a strict prefix of the
// introducer `ESC ] 5 2 ;`. Used to hold a split introducer for next chunk.
const INTRO = [ESC, 0x5d, 0x35, 0x32, 0x3b]; // ESC ] 5 2 ;
function partialIntroLen(buf, from) {
	const max = Math.min(INTRO.length - 1, buf.length - from);
	for (let len = max; len > 0; len--) {
		let ok = true;
		for (let k = 0; k < len; k++) {
			if (buf[buf.length - len + k] !== INTRO[k]) {
				ok = false;
				break;
			}
		}
		if (ok) return len;
	}
	return 0;
}

export function decodeOSC52Payload(b64) {
	const clean = b64.replace(/\s/g, "");
	if (!clean || clean === "?") return null; // empty or query, nothing to copy
	const bin = atob(clean);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

export function createOSC52Stripper(onText) {
	let hold = new Uint8Array(0); // incomplete OSC52 bytes carried across chunks
	const MAX_HOLD = 1 << 20; // 1 MiB cap: drop runaway sequences, never leak

	return function strip(chunk) {
		let input = hold.length ? concat(hold, chunk) : chunk;
		hold = new Uint8Array(0);
		const out = [];
		let i = 0;

		while (i < input.length) {
			// Find next introducer.
			let k = -1;
			for (let j = i; j + INTRO.length <= input.length; j++) {
				if (
					input[j] === ESC &&
					input[j + 1] === 0x5d &&
					input[j + 2] === 0x35 &&
					input[j + 3] === 0x32 &&
					input[j + 4] === 0x3b
				) {
					k = j;
					break;
				}
			}
			if (k === -1) {
				// No full introducer left; hold a possible split tail.
				const tail = partialIntroLen(input, i);
				const end = input.length - tail;
				for (let j = i; j < end; j++) out.push(input[j]);
				if (tail > 0) hold = input.slice(input.length - tail);
				break;
			}
			for (let j = i; j < k; j++) out.push(input[j]);

			// Pc runs until the next ';'. Incomplete -> hold from k.
			let semi = -1;
			for (let j = k + 5; j < input.length; j++) {
				if (input[j] === 0x3b) {
					semi = j;
					break;
				}
				// Pc is short ascii; BEL/ESC before ';' means not OSC52.
				if (input[j] === BEL || input[j] === ESC) break;
			}
			if (semi === -1) {
				hold = input.slice(k);
				break;
			}
			const pc = String.fromCharCode(...input.slice(k + 5, semi));
			if (pc !== "c") {
				// Not the system clipboard: pass through untouched.
				for (let j = k; j <= semi; j++) out.push(input[j]);
				i = semi + 1;
				continue;
			}
			// Find ST (BEL or ESC \) after the payload. Missing -> hold from k.
			let termStart = -1;
			let termEnd = -1;
			for (let j = semi + 1; j < input.length; j++) {
				if (input[j] === BEL) {
					termStart = j;
					termEnd = j + 1;
					break;
				}
				if (input[j] === ESC) {
					if (j + 1 >= input.length) {
						termStart = -2; // split terminator, wait for more
						break;
					}
					if (input[j + 1] === 0x5c) {
						termStart = j;
						termEnd = j + 2;
						break;
					}
					// ESC followed by something else: not our terminator,
					// keep scanning (payload is base64 so this shouldn't happen).
				}
			}
			if (termStart === -1 || termStart === -2) {
				hold = input.slice(k);
				break;
			}
			const b64 = new TextDecoder().decode(input.slice(semi + 1, termStart));
			try {
				const text = decodeOSC52Payload(b64);
				if (text) {
					try {
						const r = onText(text);
						if (r && typeof r.catch === "function") r.catch(() => {});
					} catch {}
				}
			} catch {}
			i = termEnd;
		}

		if (hold.length > MAX_HOLD) hold = new Uint8Array(0); // drop runaway
		return new Uint8Array(out);
	};
}
