// Drives the demo page in headless Chrome over CDP and checks what the
// component promises. It exits non-zero when a check fails.
// Usage: node test/e2e.mjs <chrome> <page url>
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [bin, url] = process.argv.slice(2);
if (!url) throw new Error("usage: e2e.mjs <chrome> <page url>");
const dir = mkdtempSync(join(tmpdir(), "fude-e2e-"));
const chrome = spawn(
	bin,
	[
		"--remote-debugging-port=9334",
		`--user-data-dir=${dir}`,
		"--window-size=1000,1400",
		"about:blank",
	],
	{ stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) {
	try {
		targets = await (await fetch("http://127.0.0.1:9334/json")).json();
		break;
	} catch {
		await sleep(100);
	}
}
const ws = new WebSocket(
	targets.find((t) => t.type === "page").webSocketDebuggerUrl,
);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const waiting = new Map();
const errors = [];
ws.addEventListener("message", (m) => {
	const d = JSON.parse(m.data);
	if (d.id && waiting.has(d.id)) waiting.get(d.id)(d);
	if (
		d.method === "Runtime.consoleAPICalled" &&
		["error", "warning"].includes(d.params.type)
	)
		errors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
	if (d.method === "Runtime.exceptionThrown")
		errors.push(
			`exception: ${d.params.exceptionDetails.exception?.description}`,
		);
});
const call = (method, params = {}) =>
	new Promise((r) => {
		waiting.set(++id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
const ev = async (expr) => {
	const r = await call("Runtime.evaluate", {
		expression: expr,
		returnByValue: true,
		awaitPromise: true,
	});
	if (r.result?.exceptionDetails)
		throw new Error(
			`${expr}: ${r.result.exceptionDetails.exception?.description}`,
		);
	return r.result?.result?.value;
};
let failures = 0;
const check = (ok, what, got) => {
	console.log(
		`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: got ${JSON.stringify(got)}`}`,
	);
	if (!ok) failures++;
};

await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", {
	width: 1000,
	height: 1400,
	deviceScaleFactor: 1,
	mobile: false,
});
await call("Page.navigate", { url });
for (
	let i = 0;
	i < 100 &&
	(await ev("document.querySelectorAll('.fude .fude-text').length")) < 2;
	i++
)
	await sleep(100);

await ev(`window.Q = {
	ed: (i) => document.querySelectorAll('.fude')[i],
	rows: (i) => [...Q.ed(i).querySelectorAll('.fude-text .fude-line')].map(l => l.textContent),
	status: (i) => Q.ed(i).querySelector('.fude-status').textContent,
	message: (i) => Q.ed(i).querySelector('.fude-message')?.textContent,
	error: (i) => !!Q.ed(i).querySelector('.fude-message.fude-error'),
	mode: (i) => Q.ed(i).querySelector('.fude-mode')?.textContent,
	ruler: (i) => Q.ed(i).querySelector('.fude-ruler')?.textContent,
	gutter: (i) => [...Q.ed(i).querySelectorAll('.fude-gutter div')].map(d => d.textContent),
	focused: () => [...document.querySelectorAll('.fude')].findIndex(e => e.contains(document.activeElement)),
	rect: (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; },
	// the centre of the n-th character of row r in editor i
	charAt: (i, r, n) => {
		const line = Q.ed(i).querySelectorAll('.fude-text .fude-line')[r];
		for (const s of line.querySelectorAll('[data-at]')) {
			const at = Number(s.dataset.at), t = s.firstChild;
			if (n >= at && n < at + t.length) {
				const g = document.createRange(); g.setStart(t, n - at); g.setEnd(t, n - at + 1);
				const b = g.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2];
			}
		}
	},
}; true`);

const special = {
	"<Esc>": ["Escape", "Escape", 27],
	"<CR>": ["Enter", "Enter", 13],
	"<BS>": ["Backspace", "Backspace", 8],
};
async function keys(seq) {
	for (const tok of seq.match(/<[^>]+>|./gu)) {
		if (special[tok]) {
			const [key, code, vk] = special[tok];
			await call("Input.dispatchKeyEvent", {
				type: "rawKeyDown",
				key,
				code,
				windowsVirtualKeyCode: vk,
			});
			await call("Input.dispatchKeyEvent", {
				type: "keyUp",
				key,
				code,
				windowsVirtualKeyCode: vk,
			});
		} else if (/^<C-.>$/.test(tok)) {
			const ch = tok[3];
			await call("Input.dispatchKeyEvent", {
				type: "rawKeyDown",
				key: ch,
				code: `Key${ch.toUpperCase()}`,
				modifiers: 2,
			});
			await call("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: ch,
				code: `Key${ch.toUpperCase()}`,
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
	}
	await sleep(30);
}
async function mouse(type, x, y, extra = {}) {
	await call("Input.dispatchMouseEvent", {
		type,
		x,
		y,
		button: "left",
		clickCount: 1,
		...extra,
	});
}
async function click(x, y) {
	await mouse("mousePressed", x, y, { buttons: 1 });
	await mouse("mouseReleased", x, y);
	await sleep(30);
}

// Loading and focus
check(
	(await ev("Q.focused()")) === 0,
	"autoFocus focuses the first editor",
	await ev("Q.focused()"),
);
check(
	(await ev("Q.mode(0)")) === "normal",
	"starts in normal mode",
	await ev("Q.mode(0)"),
);

// Keys, undo, onChange
await keys("wciwfude<Esc>");
check(
	(await ev("Q.rows(0)[0]")).startsWith("fudefudes vim"),
	"ciw edits",
	await ev("Q.rows(0)[0]"),
);
check(
	(await ev("document.querySelector('.meta').textContent")).startsWith(
		"338 characters",
	),
	"onChange reports the text",
	await ev("document.querySelector('.meta').textContent"),
);
await keys("u");
check(
	(await ev("Q.rows(0)[0]")).startsWith("fude's vim"),
	"u undoes",
	await ev("Q.rows(0)[0]"),
);
await keys("<C-r>u");

// Insert caret
await keys("A");
const bar = await ev("Q.rect(Q.ed(0).querySelector('.fude-caret'))");
check(
	bar && bar[3] - bar[1] > 12 && bar[2] - bar[0] >= 1,
	"insert mode draws a caret",
	bar,
);

// Committed IME text, and a composition
await call("Input.insertText", { text: " 日本" });
await sleep(30);
check(
	(await ev("Q.rows(0)[0]")).endsWith("page. 日本"),
	"inserted text types",
	await ev("Q.rows(0)[0]"),
);
await call("Input.imeSetComposition", {
	text: "に",
	selectionStart: 1,
	selectionEnd: 1,
});
await sleep(30);
check(
	await ev("!!Q.ed(0).querySelector('.fude-input.fude-composing')"),
	"a composition shows in the input",
	false,
);
check(
	(await ev("Q.rows(0)[0]")).endsWith("日本"),
	"a composition does not type yet",
	await ev("Q.rows(0)[0]"),
);
await call("Input.insertText", { text: "二" });
await sleep(30);
check(
	(await ev("Q.rows(0)[0]")).endsWith("日本二"),
	"a finished composition types once",
	await ev("Q.rows(0)[0]"),
);
check(
	!(await ev("!!Q.ed(0).querySelector('.fude-input.fude-composing')")),
	"the input hides after it",
	true,
);

// Paste, in insert mode and normal mode
await ev(
	`{ const d = new DataTransfer(); d.setData("text/plain", "P1\\nP2"); document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true })); }`,
);
await sleep(30);
let rows = await ev("Q.rows(0)");
check(
	rows[0].endsWith("二P1") && rows[1] === "P2",
	"paste types in insert mode",
	rows.slice(0, 2),
);
await keys("<Esc>uuuu");
check(
	(await ev("Q.rows(0)[0]")) === "fude's vim keys, running in this page.",
	"undo takes it all back",
	await ev("Q.rows(0)[0]"),
);

// Commands
await keys(":w<CR>");
check(
	(await ev("Q.message(0)")) === "saved 8 lines" && !(await ev("Q.error(0)")),
	":w shows the page's message",
	await ev("Q.message(0)"),
);
const savedText = (await ev("Q.rows(0).join('\\n')")).length;
check(
	(await ev("document.querySelector('.log li')?.textContent")) ===
		`saved ${savedText} characters`,
	"getValue inside a command reads the text",
	await ev("document.querySelector('.log li')?.textContent"),
);
await keys(":nope<CR>");
check(
	(await ev("Q.message(0)")) === "unknown command: nope" &&
		(await ev("Q.error(0)")),
	"a failing command shows its error",
	await ev("Q.message(0)"),
);
await keys(":s/vim/Vim/g");
check(
	(await ev("Q.status(0)")) === ":s/vim/Vim/g",
	"the command line shows as typed",
	await ev("Q.status(0)"),
);
await keys("<Esc>");

// Incremental search
await keys("/macro");
check(
	(await ev("Q.ed(0).querySelector('.fude-match')?.textContent")) === "macro",
	"a search being typed lights its match",
	await ev("Q.ed(0).querySelector('.fude-match')?.textContent"),
);
await keys("<CR>");
check(
	(await ev("Q.ruler(0)")) === "4:20",
	"the search moves the cursor",
	await ev("Q.ruler(0)"),
);

// Yank flash
await keys("yiw");
check(
	await ev("!!Q.ed(0).querySelector('.fude-flash')"),
	"a yank flashes",
	false,
);

// Clicks
let [x, y] = await ev("Q.charAt(0, 2, 4)");
await click(x, y);
check(
	(await ev("Q.ruler(0)")) === "3:5",
	"a click puts the cursor on the character",
	await ev("Q.ruler(0)"),
);
[x, y] = await ev("Q.charAt(0, 2, 6)");
await click(x + 3, y);
check(
	(await ev("Q.ruler(0)")) === "3:7",
	"a click on a character's right half stays on it",
	await ev("Q.ruler(0)"),
);
const end = await ev(
	"(r => [r.right - 10, (r.top + r.bottom) / 2])(Q.ed(0).querySelectorAll('.fude-text .fude-line')[0].getBoundingClientRect())",
);
await click(end[0], end[1]);
check(
	(await ev("Q.ruler(0)")) === "1:38",
	"a click past the end lands on the last character",
	await ev("Q.ruler(0)"),
);
[x, y] = await ev("Q.charAt(0, 6, 3)");
await click(x, y);
check(
	(await ev("Q.ruler(0)")) === "7:11",
	"a click after a tab and an accent finds its column",
	await ev("Q.ruler(0)"),
);

// Insert mode click keeps undo whole
await keys("ix<Esc>");
[x, y] = await ev("Q.charAt(0, 0, 0)");
await keys("a");
await click(x, y);
await keys("y<Esc>");
check(
	(await ev("Q.rows(0)[0]")).startsWith("yfude's"),
	"a click in insert mode moves the insert",
	await ev("Q.rows(0)[0]"),
);
await keys("uu");
rows = await ev("Q.rows(0)");
check(
	rows[0].startsWith("fude's") && !rows[6].includes("x"),
	"undo after it takes back both",
	[rows[0], rows[6]],
);

// Drag
const a = await ev("Q.charAt(0, 0, 0)");
const b = await ev("Q.charAt(0, 2, 2)");
await mouse("mousePressed", a[0], a[1], { buttons: 1 });
await mouse("mouseMoved", (a[0] + b[0]) / 2, b[1], { buttons: 1 });
await mouse("mouseMoved", b[0], b[1], { buttons: 1 });
await mouse("mouseReleased", b[0], b[1]);
await sleep(30);
const sel = await ev(
	"[...Q.ed(0).querySelectorAll('.fude-text .fude-sel')].map(s => s.textContent).join('|')",
);
check(
	(await ev("Q.mode(0)")) === "visual" &&
		sel.startsWith("fude's vim keys") &&
		sel.endsWith("Tr|y"),
	"a drag selects",
	sel,
);
await keys("<Esc>");

// Block selection draws per row
await keys("gg0<C-v>jjl");
check(
	(await ev(
		"[...Q.ed(0).querySelectorAll('.fude-text .fude-sel')].map(s => s.textContent).join('|')",
	)) === "fu|T|r",
	"a block draws on each row",
	await ev(
		"[...Q.ed(0).querySelectorAll('.fude-text .fude-sel')].map(s => s.textContent).join('|')",
	),
);
await keys("<Esc>");

// Long line keeps the cursor in view
await keys(`GA ${"long ".repeat(40)}`);
const view = await ev("Q.rect(Q.ed(0).querySelector('.fude-text'))");
const caret = await ev("Q.rect(Q.ed(0).querySelector('.fude-caret'))");
check(
	caret[0] >= view[0] && caret[2] <= view[2],
	"a long line scrolls to the caret",
	{ view, caret },
);
check(
	(await ev("window.scrollX")) === 0,
	"the page does not scroll sideways",
	await ev("window.scrollX"),
);
await keys("<Esc>0");
const back = await ev("Q.ed(0).querySelector('.fude-text').scrollLeft");
check(back === 0, "going back to column 0 scrolls back", back);
await keys("u");

// Wheel, relative line numbers, read-only, in the second editor
check(
	JSON.stringify(await ev("Q.gutter(1).slice(0, 3)")) === '["1","1","2"]',
	"relative numbers count from the cursor",
	await ev("Q.gutter(1)"),
);
const second = await ev("Q.rect(Q.ed(1).querySelector('.fude-text'))");
const sy = await ev("window.scrollY");
await call("Input.dispatchMouseEvent", {
	type: "mouseWheel",
	x: second[0] + 50,
	y: second[1] + 30,
	deltaX: 0,
	deltaY: 300,
});
await sleep(60);
const firstRow = await ev("Q.rows(1)[0]");
check(/^1[0-9]\. /.test(firstRow), "the wheel scrolls the view", firstRow);
check(
	(await ev("window.scrollY")) === sy,
	"the wheel does not scroll the page",
	await ev("window.scrollY"),
);
check(
	Number((await ev("Q.ruler(1)")).split(":")[0]) ===
		Number(firstRow.split(".")[0]),
	"the cursor stays in view",
	await ev("Q.ruler(1)"),
);
await ev("document.querySelector('input[type=checkbox]').click()");
await sleep(30);
const r1 = await ev("Q.rect(Q.ed(1).querySelector('.fude-text'))");
await click(r1[0] + 20, r1[1] + 5);
check(
	(await ev("Q.focused()")) === 1,
	"a click focuses the editor",
	await ev("Q.focused()"),
);
const before = await ev("Q.rows(1).join('\\n')");
await keys("ddx");
check(
	(await ev("Q.rows(1).join('\\n')")) === before &&
		(await ev("Q.message(1)")) === "the text is read-only",
	"read-only refuses edits",
	await ev("Q.message(1)"),
);
await keys("i");
check(
	(await ev("Q.mode(1)")).startsWith("normal"),
	"read-only stays in normal mode",
	await ev("Q.mode(1)"),
);
await ev("document.querySelector('input[type=checkbox]').click()");
await sleep(30);
await keys("dd");
check(
	(await ev("Q.rows(1).join('\\n')")) !== before,
	"keys edit again after read-only goes",
	null,
);
check(
	!(await ev("Q.rows(0)[0]")).startsWith("1"),
	"the editors keep their own text",
	await ev("Q.rows(0)[0]"),
);

// Ref API and remounting
await ev(
	"[...document.querySelectorAll('button')].find(b => b.textContent === 'cursor to the start').click()",
);
await sleep(30);
check(
	(await ev("Q.ruler(0)")) === "1:1" && (await ev("Q.focused()")) === 0,
	"type and focus through the ref",
	await ev("Q.ruler(0)"),
);
await keys("dd");
await ev(
	"[...document.querySelectorAll('button')].find(b => b.textContent === 'reset text').click()",
);
await sleep(30);
check(
	(await ev("Q.rows(0)[0]")).startsWith("fude's"),
	"setValue sets the text",
	await ev("Q.rows(0)[0]"),
);
await keys("u");
check(
	(await ev("Q.rows(0)[0]")).trim() === "",
	"undo takes setValue back",
	await ev("Q.rows(0)[0]"),
);
for (let i = 0; i < 3; i++) {
	await ev(
		"[...document.querySelectorAll('button')].find(b => b.textContent === 'unmount').click()",
	);
	await sleep(30);
	await ev(
		"[...document.querySelectorAll('button')].find(b => b.textContent === 'mount').click()",
	);
	for (
		let j = 0;
		j < 50 &&
		(await ev("document.querySelectorAll('.fude .fude-text').length")) < 3;
		j++
	)
		await sleep(20);
}
check(
	(await ev("document.querySelectorAll('.fude .fude-text').length")) === 3 &&
		(await ev("Q.rows(0)[0]")).startsWith("fude's"),
	"a remount starts again",
	await ev("Q.rows(0)[0]"),
);
await keys("x");
check(
	(await ev("Q.rows(0)[0]")).startsWith("ude's"),
	"the remounted editor takes keys",
	await ev("Q.rows(0)[0]"),
);

// setValue from inside a command runs once the command returns
await ev("Q.ed(0).querySelector('textarea').focus()");
await keys("ggdd:reset<CR>");
check(
	(await ev("Q.rows(0)[0]")).startsWith("fude's") &&
		(await ev("Q.message(0)")) === "reset",
	"setValue inside a command sets the text after it",
	[await ev("Q.rows(0)[0]"), await ev("Q.message(0)")],
);

// The system clipboard
await call("Browser.grantPermissions", {
	permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
	origin: new URL(url).origin,
});
await keys('gg"+yiw');
check(
	(await ev("navigator.clipboard.readText()")) === "fude",
	'"+y copies to the system clipboard',
	await ev("navigator.clipboard.readText()"),
);
await keys('$"+p');
check(
	(await ev("Q.rows(0)[0]")).endsWith("page.fude"),
	'"+p puts what the page copied',
	await ev("Q.rows(0)[0]"),
);
await ev("window.dispatchEvent(new Event('blur'))");
await keys('"+p');
check(
	(await ev("Q.error(0)")) && (await ev("Q.rows(0)[0]")).endsWith("page.fude"),
	'"+p after the window loses focus fails',
	await ev("Q.message(0)"),
);
await keys("u");

// Syntax highlighting
for (
	let i = 0;
	i < 100 && !(await ev("!!Q.ed(2).querySelector('.hl-keyword')"));
	i++
)
	await sleep(50);
const cls = (row, word) =>
	ev(
		`(() => { const line = Q.ed(2).querySelectorAll('.fude-text .fude-line')[${row}]; const s = [...line.querySelectorAll('[data-at]')].find(s => s.textContent.includes(${JSON.stringify(word)})); return s ? s.className : null; })()`,
	);
check(
	(await cls(1, "import")) === "hl-keyword",
	"keywords colour",
	await cls(1, "import"),
);
check(
	(await cls(5, "words")) === "hl-function",
	"a function's name colours",
	await cls(5, "words"),
);
check(
	(await cls(3, "A comment")) === "hl-comment" &&
		(await cls(4, "two lines")) === "hl-comment",
	"a comment over two lines colours on both",
	[await cls(3, "A comment"), await cls(4, "two lines")],
);
check(
	(await cls(14, "😀")) === "hl-string",
	"a template string with an emoji colours",
	await cls(14, "😀"),
);
await ev("Q.ed(2).querySelector('textarea').focus()");
await keys("ggjI/* <Esc>");
check(
	(await cls(1, "import")) === "hl-comment",
	"an edit that opens a comment colours what follows",
	await cls(1, "import"),
);
check(
	(await cls(5, "words")) === "hl-function",
	"the comment ends where it did",
	await cls(5, "words"),
);
await keys("u");
check(
	(await cls(1, "mport")) === "hl-keyword",
	"undo colours it back",
	await cls(1, "mport"),
);
// A new editor under the same highlight colours its own text
await ev(
	"[...document.querySelectorAll('button')].find(b => b.textContent === 'other sample').click()",
);
for (let i = 0; i < 50 && !(await ev("Q.rows(2)[0]")).startsWith("class"); i++)
	await sleep(20);
check(
	(await cls(0, "lass")) === "hl-keyword" &&
		(await cls(1, "counts")) !== "hl-keyword",
	"a remounted editor colours its new text",
	[await cls(0, "lass"), await cls(1, "counts")],
);
await ev(
	"[...document.querySelectorAll('button')].find(b => b.textContent === 'other sample').click()",
);
for (let i = 0; i < 50 && !(await ev("Q.rows(2)[0]")).startsWith("//"); i++)
	await sleep(20);
check(
	(await cls(0, "Colours")) === "hl-comment",
	"and back again",
	await cls(0, "Colours"),
);
await ev("Q.ed(2).querySelector('textarea').focus()");
await keys("15Gfh");
check(
	(await ev("Q.ruler(2)")) === "15:19",
	"the cursor moves on coloured text",
	await ev("Q.ruler(2)"),
);
check(
	(await ev("Q.ed(2).querySelector('[data-cursor]')?.className")) ===
		"hl-string fude-cursor",
	"the cursor draws over a colour",
	await ev("Q.ed(2).querySelector('[data-cursor]')?.className"),
);

// A large text stays fast
await ev(
	`(() => { const t = Array.from({length: 20000}, (_, i) => "line " + i + " " + "x".repeat(i % 50)).join("\\n"); const d = new DataTransfer(); d.setData("text/plain", t); Q.ed(0).querySelector('textarea').focus(); document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true })); })()`,
);
await sleep(200);
const ms = await ev(`(async () => {
	const ta = Q.ed(0).querySelector('textarea');
	const times = [];
	for (let i = 0; i < 20; i++) {
		const t0 = performance.now();
		ta.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true, cancelable: true }));
		await new Promise(r => requestAnimationFrame(() => setTimeout(r)));
		times.push(performance.now() - t0);
	}
	times.sort((a, b) => a - b);
	return times[10];
})()`);
check(ms < 30, `one move on 20k lines takes ${ms.toFixed(1)}ms to paint`, ms);
const edits = await ev(`(async () => {
	const ta = Q.ed(0).querySelector('textarea');
	const times = [];
	for (let i = 0; i < 300; i++) {
		const t0 = performance.now();
		ta.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", bubbles: true, cancelable: true }));
		await new Promise(r => requestAnimationFrame(() => setTimeout(r)));
		times.push(performance.now() - t0);
	}
	const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
	return [median(times.slice(0, 50)), median(times.slice(-50))];
})()`);
check(
	edits[0] < 60 && edits[1] < edits[0] * 2,
	`one edit on 20k lines with onChange takes ${edits[0].toFixed(1)}ms, and ${edits[1].toFixed(1)}ms 300 edits later`,
	edits,
);

const real = errors.filter((e) => !e.includes("React DevTools"));
check(real.length === 0, "no console errors or warnings", real);
console.log(failures ? `${failures} failed` : "all passed");
chrome.kill();
await new Promise((r) => chrome.once("exit", r));
rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
