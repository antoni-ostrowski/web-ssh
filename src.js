import { init, Terminal, FitAddon, Ghostty } from "ghostty-web";

const name = location.pathname.split("/").pop();
const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/connect/${name}`;

const termElement = document.getElementById("terminal");

const statusEl = document.createElement("div");
statusEl.id = "status";
statusEl.textContent = "connecting";
termElement.parentNode.insertBefore(statusEl, termElement);

let term;
let fitAddon;
let ws;
let retries = 0;

const send = (frame) => {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(frame);
	}
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
		if (data instanceof ArrayBuffer) {
			term.write(new Uint8Array(data));
		} else if (data instanceof Uint8Array) {
			term.write(data);
		} else if (typeof data === "string") {
			term.write(data);
		} else {
			// Blob fallback
			if (data instanceof Blob) {
				data.arrayBuffer().then((buf) => term.write(new Uint8Array(buf)));
			}
		}
	};
};

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
		cursorBlink: true,
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
		statusEl.textContent = `${cols}x${rows}`;
		sendResize(cols, rows);
	});

	window.addEventListener("resize", () => {
		clearTimeout(resizeTimeout);
		resizeTimeout = setTimeout(fit, 100);
	});

	// Use FitAddon's built-in observer if available, otherwise fallback to manual
	if (typeof fitAddon.observeResize === "function") {
		try {
			fitAddon.observeResize();
		} catch {}
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

start();
