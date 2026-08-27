import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const name = location.pathname.split("/").pop()
const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/connect/${name}`;

const termElement = document.getElementById("terminal");

const statusEl = document.createElement("div");
statusEl.id = "status";
statusEl.textContent = "connecting";
termElement.parentNode.insertBefore(statusEl, termElement);

const term = new Terminal({
	cursorBlink: true,
	fontSize: 14,
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
	scrollback: 5000,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

let webgl = new WebglAddon();
term.loadAddon(webgl);
webgl.onContextLoss(() => {
	webgl.dispose();
});

term.open(termElement);
term.focus();

let ws;
let retries = 0;

const connectWs = () => {
	ws = new WebSocket(wsUrl);
	ws.binaryType = "arraybuffer";

	ws.onopen = () => {
		retries = 0;
		statusEl.textContent = "connected";
		term.reset();
		fit();
	};

	ws.onclose = () => {
		statusEl.textContent = "disconnected";
		setTimeout(connectWs, Math.min(1000 * 2 ** retries++, 10000));
	};

	ws.onerror = () => {
		statusEl.textContent = "disconnected";
	};

	ws.onmessage = (event) => {
		term.write(new Uint8Array(event.data));
	};
};

connectWs();

const send = (frame) => {
	if (ws.readyState === WebSocket.OPEN) {
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

term.onData((data) => {
	sendData(data);
});

term.onResize(({ cols, rows }) => {
	statusEl.textContent = `${cols}x${rows}`;
	sendResize(cols, rows);
});

let resizeTimeout = null;
const fit = () => {
	try {
		const parent = termElement.parentElement;
		if (parent && parent.offsetHeight === 0) return;
		fitAddon.fit();
	} catch (err) {
		// container hidden/zero-size; retry on next event
	}
	sendResize(term.cols, term.rows);
};

window.addEventListener("resize", () => {
	clearTimeout(resizeTimeout);
	resizeTimeout = setTimeout(fit, 100);
});

if (typeof ResizeObserver !== "undefined") {
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
		if (ws.readyState === WebSocket.CLOSED) {
			connectWs();
		}
	}
});

webgl.onContextLoss(() => {
	webgl.dispose();
});

termElement.addEventListener("webglcontextrestored", () => {
	setTimeout(fit, 50);
});

fit();

const modifierKeysCodes = [
	"ControlLeft",
	"ControlRight",
	"AltLeft",
	"AltRight",
	"MetaRight",
	"MetaLeft",
	"ShiftLeft",
	"ShiftRight",
	"CapsLock",
	"Escape",
];

const termTextAreaElement =
	document.querySelector(".xterm-helper-textarea") ||
	document.querySelector("#terminal textarea");

if (termTextAreaElement) {
	termTextAreaElement.addEventListener("keydown", (e) => {
		const keyCode = e.code;
		// console.log(keyCode);
		if (modifierKeysCodes.includes(keyCode)) {
			e.preventDefault();
			// console.log("found key:", keyCode);
			ws.send(
				JSON.stringify({
					type: "special_key",
					payload: keyCode,
				}),
			);
		}
	});
}