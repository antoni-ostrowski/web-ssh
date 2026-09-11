import { init, Terminal, FitAddon, Ghostty } from "ghostty-web";
import { createOSC52Stripper } from "./osc52.js";

const name = location.pathname.split("/").pop();
const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/connect/${name}`;

const termElement = document.getElementById("terminal");

const statusEl = document.createElement("div");
statusEl.id = "status";
statusEl.textContent = "connecting";
termElement.parentNode.insertBefore(statusEl, termElement);

const btnCopy = document.getElementById("btn-copy");
const btnPaste = document.getElementById("btn-paste");
const btnSelect = document.getElementById("btn-select");
const pasteSheet = document.getElementById("paste-sheet");
const pasteArea = document.getElementById("paste-area");
const pasteInsert = document.getElementById("paste-insert");
const pasteCancel = document.getElementById("paste-cancel");

let term;
let fitAddon;
let ws;
let retries = 0;
let lastDims = "";
let flashTimer = null;
// OSC52 copy that the browser refused without a user gesture (iPad Safari).
// Tapping Copy completes it.
let pendingOSC52 = "";

const send = (frame) => {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(frame);
	}
};

const flash = (msg, ms = 2500) => {
	statusEl.textContent = msg;
	clearTimeout(flashTimer);
	flashTimer = setTimeout(() => {
		statusEl.textContent = lastDims || "connected";
	}, ms);
};

// Best-effort clipboard write. Returns true on success.
// Falls back to a hidden textarea + execCommand for older browsers.
const writeClipboardText = async (text) => {
	if (!text) return false;
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch (err) {
		console.warn("[clipboard] async write failed, trying fallback", err);
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		ta.setSelectionRange(0, text.length);
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch (err) {
		console.warn("[clipboard] fallback copy failed", err);
		return false;
	}
};

// OSC52 (tmux yank, neovim, `printf '\e]52;c;...'`) -> system clipboard.
// Runs without a user gesture, so iPad Safari may refuse: stash and let the
// next Copy tap finish the write.
const stripOSC52 = createOSC52Stripper(async (text) => {
	const ok = await writeClipboardText(text);
	if (ok) {
		flash(`copied ${text.length} chars`);
	} else {
		pendingOSC52 = text;
		btnCopy?.classList.add("pending");
		flash("tap Copy to finish clipboard copy");
	}
});

// Strip OSC52, then hand the clean bytes to the terminal.
// Accepts whatever ws.onmessage gives us and always returns bytes to write
// (empty array = nothing visible).
const toCleanBytes = (data) => {
	if (data instanceof ArrayBuffer) return stripOSC52(new Uint8Array(data));
	if (data instanceof Uint8Array) return stripOSC52(data);
	if (typeof data === "string") return stripOSC52(new TextEncoder().encode(data));
	return null; // Blob, handled async by caller
};

const sendResize = (cols, rows) => {
	const frame = new Uint8Array(5);
	frame[0] = 0x72; // 'r' resize opcode
	new DataView(frame.buffer).setUint16(1, cols, true);
	new DataView(frame.buffer).setUint16(3, rows, true);
	send(frame);
};

const sendData = (str) => {
	const payload = new TextEncoder().encode(str);
	const frame = new Uint8Array(payload.length + 1);
	frame[0] = 0x64; // 'd' data opcode
	frame.set(payload, 1);
	send(frame);
};

let resizeTimeout = null;
const fit = () => {
	if (!term || !fitAddon) return;
	try {
		const parent = termElement.parentElement;
		if (parent && parent.offsetHeight === 0) return;
		fitAddon.fit();
	} catch (err) {
		// container hidden/zero-size; retry on next event
	}
	if (term.cols && term.rows) {
		sendResize(term.cols, term.rows);
	}
};

const connectWs = () => {
	ws = new WebSocket(wsUrl);
	ws.binaryType = "arraybuffer";

	ws.onopen = () => {
		retries = 0;
		statusEl.textContent = "connected";
		if (term) {
			term.reset();
			// fit after reset, give renderer a frame to settle
			requestAnimationFrame(() => setTimeout(fit, 50));
		}
	};

	ws.onclose = () => {
		statusEl.textContent = "disconnected";
		setTimeout(connectWs, Math.min(1000 * 2 ** retries++, 10000));
	};

	ws.onerror = () => {
		statusEl.textContent = "disconnected";
	};

	ws.onmessage = (event) => {
		if (!term) return;
		const data = event.data;
		if (data instanceof Blob) {
			data.arrayBuffer().then((buf) => {
				const clean = stripOSC52(new Uint8Array(buf));
				if (clean.length) term.write(clean);
			});
			return;
		}
		const clean = toCleanBytes(data);
		if (clean && clean.length) term.write(clean);
	};
};

// --- Copy: terminal selection (or pending OSC52) -> system clipboard ---
const copySelection = async () => {
	if (!term) return;
	term.focus();
	if (pendingOSC52 && !term.hasSelection()) {
		if (await writeClipboardText(pendingOSC52)) {
			flash(`copied ${pendingOSC52.length} chars`);
			pendingOSC52 = "";
			btnCopy?.classList.remove("pending");
		} else {
			flash("copy blocked — tap again, or select + Cmd-C");
		}
		return;
	}
	const text = term.getSelection();
	if (!text) {
		flash("nothing selected — drag, or Select then drag");
		return;
	}
	if (await writeClipboardText(text)) {
		flash(`copied ${text.length} chars`);
	} else {
		flash("copy blocked — select + Cmd-C");
	}
};

// --- Paste: system clipboard -> terminal (bracketed-paste aware) ---
const hidePasteSheet = () => {
	if (!pasteSheet) return;
	pasteSheet.hidden = true;
	if (pasteArea) pasteArea.value = "";
	term?.focus();
};

const showPasteSheet = () => {
	// Fallback when navigator.clipboard.readText is unavailable/denied
	// (plain http, permissions). A real textarea gets the native iPad
	// long-press Paste menu, which canvas never does.
	if (!pasteSheet || !pasteArea) {
		flash("paste blocked by browser — use Cmd-V");
		return;
	}
	pasteSheet.hidden = false;
	pasteArea.value = "";
	pasteArea.focus();
};

const pasteFromClipboard = async () => {
	if (!term) return;
	term.focus();
	try {
		if (navigator.clipboard?.readText) {
			const text = await navigator.clipboard.readText();
			if (text) {
				term.paste(text);
				return;
			}
		}
	} catch (err) {
		console.warn("[clipboard] read failed, showing paste sheet", err);
	}
	showPasteSheet();
};

btnCopy?.addEventListener("click", copySelection);
btnPaste?.addEventListener("click", pasteFromClipboard);
pasteInsert?.addEventListener("click", () => {
	const text = pasteArea?.value ?? "";
	hidePasteSheet();
	if (text) term?.paste(text);
});
pasteCancel?.addEventListener("click", hidePasteSheet);

// Route every Cmd-V / Edit-menu paste through term.paste() so bracketed
// paste (\x1b[200~...\x1b[201~) reaches tmux/nvim intact. The lib's own
// paste handler sends raw text without the markers. Capture phase +
// stopPropagation keeps a single paste path. The paste-sheet textarea is
// exempt so the native iPad menu keeps working there.
window.addEventListener(
	"paste",
	(e) => {
		if (!term) return;
		if (pasteSheet && !pasteSheet.hidden && pasteSheet.contains(e.target)) return;
		const text = e.clipboardData?.getData("text");
		if (text) {
			e.preventDefault();
			e.stopPropagation();
			term.paste(text);
		}
	},
	true,
);

async function start() {
	statusEl.textContent = "loading terminal…";

	let ghosttyInstance = null;
	let initOk = false;
	try {
		await init();
		initOk = true;
	} catch (e) {
		console.warn("[ghostty-web] init() failed, trying explicit WASM paths", e);
		const candidates = ["/public/ghostty-vt.wasm", "/public/build/ghostty-vt.wasm", "/ghostty-vt.wasm"];
		for (const p of candidates) {
			try {
				ghosttyInstance = await Ghostty.load(p);
				console.log(`[ghostty-web] loaded WASM from ${p}`);
				initOk = true;
				break;
			} catch (e2) {
				console.warn(`[ghostty-web] failed to load ${p}`, e2);
			}
		}
		if (!initOk) {
			console.error("[ghostty-web] all WASM load attempts failed");
			statusEl.textContent = "failed to load terminal";
			return;
		}
	}

	const opts = {
		cursorBlink: false,
		fontSize: 14,
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
		scrollback: 5000,
		theme: {
			background: "#1e1e1e",
			foreground: "#d4d4d4",
		},
	};
	if (ghosttyInstance) {
		opts.ghostty = ghosttyInstance;
	}

	term = new Terminal(opts);

	fitAddon = new FitAddon();
	term.loadAddon(fitAddon);

	term.open(termElement);
	term.focus();

	term.onData((data) => {
		sendData(data);
	});

	term.onResize(({ cols, rows }) => {
		lastDims = `${cols}x${rows}`;
		statusEl.textContent = lastDims;
		sendResize(cols, rows);
	});

	enableTouchSelect();

	window.addEventListener("resize", () => {
		clearTimeout(resizeTimeout);
		resizeTimeout = setTimeout(fit, 100);
	});

	// Use FitAddon's built-in observer if available, otherwise fallback to manual
	if (typeof fitAddon.observeResize === "function") {
		try {
			fitAddon.observeResize();
		} catch { }
	} else if (typeof ResizeObserver !== "undefined") {
		const ro = new ResizeObserver(() => {
			clearTimeout(resizeTimeout);
			resizeTimeout = setTimeout(fit, 100);
		});
		ro.observe(termElement);
	}

	if (document.fonts?.ready) {
		document.fonts.ready.then(() => setTimeout(fit, 50));
	}

	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) {
			setTimeout(fit, 150);
			if (ws && ws.readyState === WebSocket.CLOSED) {
				connectWs();
			}
		}
	});

	// initial fit after fonts/layout settle
	// ghostty needs a frame for metrics, so defer
	requestAnimationFrame(() => setTimeout(fit, 50));
	setTimeout(fit, 150);

	connectWs();
}

// --- Touch selection for iPad ---
// ghostty-web's SelectionManager only listens to mouse events, and a
// one-finger drag on iPad scrolls instead of selecting. While Select mode
// is on, translate single-finger touches into the mousedown/mousemove/mouseup
// the manager already handles (incl. its mouseup auto-copy). Off = normal
// touch scrolling.
let selectMode = false;
let touchSelecting = false;

function fireMouse(canvas, type, touch) {
	const rect = canvas.getBoundingClientRect();
	const ev = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		view: window,
		button: 0,
		buttons: type === "mouseup" ? 0 : 1,
		clientX: touch.clientX,
		clientY: touch.clientY,
	});
	// SelectionManager reads offsetX/offsetY, which MouseEvent init ignores.
	Object.defineProperties(ev, {
		offsetX: { value: touch.clientX - rect.left },
		offsetY: { value: touch.clientY - rect.top },
	});
	canvas.dispatchEvent(ev);
}

function enableTouchSelect() {
	const canvas = termElement.querySelector("canvas");
	if (!canvas || !btnSelect) return;

	btnSelect.addEventListener("click", () => {
		selectMode = !selectMode;
		touchSelecting = false;
		btnSelect.classList.toggle("active", selectMode);
		btnSelect.setAttribute("aria-pressed", String(selectMode));
		// Don't let the page/scroll gesture steal the drag while selecting.
		canvas.style.touchAction = selectMode ? "none" : "";
		term?.focus();
		flash(selectMode ? "select mode: drag to select" : "select mode off");
	});

	canvas.addEventListener(
		"touchstart",
		(e) => {
			if (!selectMode || e.touches.length !== 1) return;
			e.preventDefault();
			touchSelecting = true;
			fireMouse(canvas, "mousedown", e.touches[0]);
		},
		{ passive: false },
	);
	canvas.addEventListener(
		"touchmove",
		(e) => {
			if (!selectMode || !touchSelecting || e.touches.length !== 1) return;
			e.preventDefault();
			fireMouse(canvas, "mousemove", e.touches[0]);
		},
		{ passive: false },
	);
	const endTouch = (e) => {
		if (!selectMode || !touchSelecting) return;
		touchSelecting = false;
		const t = e.changedTouches[0];
		if (t) fireMouse(canvas, "mouseup", t);
	};
	canvas.addEventListener("touchend", endTouch);
	canvas.addEventListener("touchcancel", () => {
		touchSelecting = false;
	});
}

start();
