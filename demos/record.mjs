// Records demos/fude-react.gif: plays a session on the demo page in
// headless Chrome, captures its frames and joins them with ffmpeg.
// Usage: node demos/record.mjs <chrome> <page url> <out.gif>
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [chromeBin, url, out] = process.argv.slice(2);
if (!out) throw new Error("usage: record.mjs <chrome> <page url> <out.gif>");
const width = 960;
const height = 620;
const work = mkdtempSync(join(tmpdir(), "fude-demo-"));
const chrome = spawn(
	chromeBin,
	[
		"--remote-debugging-port=9335",
		`--user-data-dir=${join(work, "profile")}`,
		"--hide-scrollbars",
		"about:blank",
	],
	{ stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 100 && !targets; i++) {
	targets = await fetch("http://127.0.0.1:9335/json")
		.then((r) => r.json())
		.catch(() => sleep(100));
}
const ws = new WebSocket(
	targets.find((t) => t.type === "page").webSocketDebuggerUrl,
);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
const frames = [];
ws.addEventListener("message", (m) => {
	const d = JSON.parse(m.data);
	if (d.id) pending.get(d.id)?.(d);
	if (d.method === "Page.screencastFrame") {
		const f = d.params;
		frames.push({ data: f.data, at: f.metadata.timestamp });
		call("Page.screencastFrameAck", { sessionId: f.sessionId });
	}
});
function call(method, params = {}) {
	return new Promise((resolve, reject) => {
		pending.set(++id, (d) =>
			d.error
				? reject(new Error(`${method}: ${d.error.message}`))
				: resolve(d.result),
		);
		ws.send(JSON.stringify({ id, method, params }));
	});
}
const run = (expression) =>
	call("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	}).then((r) => r.result.value);

await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", {
	width,
	height,
	deviceScaleFactor: 1,
	mobile: false,
});
await call("Emulation.setEmulatedMedia", {
	features: [{ name: "prefers-color-scheme", value: "dark" }],
});
await call("Page.navigate", { url });
for (
	let i = 0;
	i < 100 && !(await run("!!document.querySelector('.hl-keyword')"));
	i++
)
	await sleep(100);

// The overlay shows a caption, the keys typed and a pointer, which a
// headless page does not draw.
await run(`(() => {
	const s = document.createElement("style");
	s.textContent = \`
		#demo-bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; justify-content: space-between; align-items: center;
			padding: 10px 20px; font: 600 15px system-ui; color: #e6edf3; background: #161b22ee; border-top: 1px solid #30363d; }
		#demo-keys { font: 600 15px ui-monospace, monospace; color: #7ee787; min-height: 1em; }
		#demo-pointer { position: fixed; left: -40px; top: -40px; width: 20px; height: 20px; pointer-events: none; z-index: 9;
			transition: left .5s ease, top .5s ease; filter: drop-shadow(0 1px 2px #000); }
		main { margin-top: 24px !important; }\`;
	document.head.append(s);
	document.body.insertAdjacentHTML("beforeend", \`<div id="demo-bar"><span id="demo-caption"></span><span id="demo-keys"></span></div>
		<svg id="demo-pointer" viewBox="0 0 20 20"><path d="M2 1 L2 16 L6 12 L9 19 L12 18 L9 11 L15 11 Z" fill="#fff" stroke="#000" stroke-width="1"/></svg>\`);
})()`);

const caption = (text) =>
	run(
		`document.getElementById("demo-caption").textContent = ${JSON.stringify(text)}`,
	);
const shown = (text) =>
	run(
		`document.getElementById("demo-keys").textContent = ${JSON.stringify(text)}`,
	);
const special = {
	"<Esc>": ["Escape", 27],
	"<CR>": ["Enter", 13],
};

// keys types keys in vim notation at a person's pace, and shows them.
async function keys(seq, pace = 110) {
	let typed = "";
	for (const tok of seq.match(/<[^>]+>|./gu)) {
		typed += tok;
		await shown(typed.slice(-28));
		if (special[tok]) {
			const [key, vk] = special[tok];
			await call("Input.dispatchKeyEvent", {
				type: "rawKeyDown",
				key,
				code: key,
				windowsVirtualKeyCode: vk,
			});
			await call("Input.dispatchKeyEvent", {
				type: "keyUp",
				key,
				code: key,
				windowsVirtualKeyCode: vk,
			});
		} else if (/^<C-.>$/.test(tok)) {
			const k = tok[3];
			const code = `Key${k.toUpperCase()}`;
			await call("Input.dispatchKeyEvent", {
				type: "rawKeyDown",
				key: k,
				code,
				modifiers: 2,
			});
			await call("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: k,
				code,
				modifiers: 2,
			});
		} else {
			await call("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: tok,
				text: tok,
			});
			await call("Input.dispatchKeyEvent", { type: "keyUp", key: tok });
		}
		await sleep(pace);
	}
}

// at returns the centre of character col of row in editor ed, on screen.
const at = (ed, row, col) =>
	run(`(() => {
		const line = document.querySelectorAll(".fude")[${ed}].querySelectorAll(".fude-line")[${row}];
		for (const s of line.querySelectorAll("[data-at]")) {
			const from = Number(s.dataset.at), t = s.firstChild;
			if (${col} >= from && ${col} < from + t.length) {
				const r = document.createRange(); r.setStart(t, ${col} - from); r.setEnd(t, ${col} - from + 1);
				const b = r.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2];
			}
		}
	})()`);
async function point(x, y) {
	await run(
		`Object.assign(document.getElementById("demo-pointer").style, { left: "${x - 2}px", top: "${y - 1}px" })`,
	);
	await sleep(550);
}
const mouse = (type, x, y, buttons) =>
	call("Input.dispatchMouseEvent", {
		type,
		x,
		y,
		button: "left",
		buttons,
		clickCount: 1,
	});
async function click(x, y) {
	await point(x, y);
	await mouse("mousePressed", x, y, 1);
	await mouse("mouseReleased", x, y, 0);
}
async function drag([x1, y1], [x2, y2]) {
	await point(x1, y1);
	await mouse("mousePressed", x1, y1, 1);
	await run(
		`document.getElementById("demo-pointer").style.transition = "none"`,
	);
	for (let i = 1; i <= 12; i++) {
		const x = x1 + ((x2 - x1) * i) / 12;
		const y = y1 + ((y2 - y1) * i) / 12;
		await run(
			`Object.assign(document.getElementById("demo-pointer").style, { left: "${x - 2}px", top: "${y - 1}px" })`,
		);
		await mouse("mouseMoved", x, y, 1);
		await sleep(40);
	}
	await mouse("mouseReleased", x2, y2, 0);
	await run(`document.getElementById("demo-pointer").style.transition = ""`);
}
async function step(text, seq, rest = 900) {
	await caption(text);
	await shown("");
	if (seq) await keys(seq);
	await sleep(rest);
}

await call("Page.startScreencast", { format: "png", everyNthFrame: 1 });
await sleep(800);
await step("fude's vim grammar, as a React component", null, 1200);
await step("ciw changes a word", "3wciwmodal<Esc>");
await step("u undoes, <C-r> redoes", "u");
await keys("<C-r>");
await sleep(700);
await step("A visual block inserts on every line", "jj0<C-v>jjI// <Esc>", 1200);
await step("A search lights its match as you type", "/macro", 900);
await keys("<CR>");
await step("Macros record and replay", "qaA!<Esc>jq2@a", 1200);
await caption("Click to move, drag to select");
await shown("");
await click(...(await at(0, 0, 13)));
await sleep(500);
await drag(await at(0, 0, 13), await at(0, 0, 25));
await sleep(500);
await step("Click to move, drag to select", "d", 700);
await keys("u");
await step(":w runs the page's own command", ":w<CR>", 1400);

await caption("Syntax highlighting from tree-sitter");
await shown("");
await run(
	`document.querySelectorAll(".fude")[2].scrollIntoView({ behavior: "smooth", block: "end" })`,
);
await sleep(1200);
await click(...(await at(2, 1, 2)));
await sleep(600);
await step("Open a string and the colours follow", "9GI`<Esc>", 1600);
await step("Undo puts them back", "u", 900);
await step("Edits colour as you type", "6Gwwwciwcount<Esc>", 900);
await step(
	"Edits colour as you type",
	'Goconst top = await count("README.md", { min: 4 });<Esc>',
	2000,
);

await call("Page.stopScreencast");
chrome.kill();
await new Promise((r) => chrome.once("exit", r));

// Each frame shows until the next one, and the last for a second.
let list = "";
frames.forEach((f, i) => {
	const name = join(work, `${String(i).padStart(5, "0")}.png`);
	writeFileSync(name, Buffer.from(f.data, "base64"));
	const next = frames[i + 1]?.at ?? f.at + 1;
	list += `file '${name}'\nduration ${(next - f.at).toFixed(3)}\n`;
});
list += `file '${join(work, `${String(frames.length - 1).padStart(5, "0")}.png`)}'\n`;
writeFileSync(join(work, "frames.txt"), list);
const ff = spawnSync(
	"ffmpeg",
	[
		"-y",
		"-loglevel",
		"error",
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		join(work, "frames.txt"),
		"-vf",
		"fps=15,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
		out,
	],
	{ stdio: "inherit" },
);
rmSync(work, { recursive: true, force: true });
if (ff.status !== 0) throw new Error(`ffmpeg exited ${ff.status}`);
console.log(`wrote ${out} from ${frames.length} frames`);
process.exit(0);
