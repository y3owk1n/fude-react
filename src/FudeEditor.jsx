import {
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import defaultWasm from "./fude.wasm?url";
import "./wasm_exec.js";
import { keys } from "./keys.js";
import "./FudeEditor.css";

// wasm_exec.js stubs process for go when the page has none. Without
// versions, a library that looks for node through process.versions.node
// throws in place of finding none.
globalThis.process.versions ??= {};

let grammar = null;

// load starts fude's grammar once for every editor on the page. A failed
// load is tried again by the next editor that mounts.
function load(url) {
	grammar ??= (async () => {
		const go = new Go();
		const { instance } = await WebAssembly.instantiateStreaming(
			fetch(url),
			go.importObject,
		);
		go.run(instance);
		return globalThis.fude;
	})().catch((err) => {
		grammar = null;
		throw err;
	});
	return grammar;
}

// clip is the system clipboard as the page last saw it, through a paste or
// a yank to "+. The page cannot read the clipboard itself without asking,
// so it forgets what it saw when the window loses focus.
let clip = null;
if (typeof window !== "undefined")
	window.addEventListener("blur", () => {
		clip = null;
	});

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// FudeEditor edits text with fude's vim keys. It owns its text once it
// mounts, so it takes defaultValue and reports each change to onChange.
export function FudeEditor({
	defaultValue = "",
	rows = 12,
	onChange,
	onCommand,
	readOnly = false,
	lineNumbers = false,
	highlight,
	autoFocus = false,
	className,
	wasmUrl = defaultWasm,
	"aria-label": label = "editor",
	ref,
}) {
	const [state, setState] = useState(null);
	const [failed, setFailed] = useState(null);
	const [composing, setComposing] = useState(false);
	const editor = useRef(null);
	const version = useRef(0);
	const busy = useRef(false);
	const queue = useRef([]);
	const view = useRef(null);
	const text = useRef(null);
	const input = useRef(null);
	const live = useRef({});
	live.current = { onChange, onCommand, state };

	function show(json) {
		const s = JSON.parse(json);
		if (s.version !== version.current) {
			version.current = s.version;
			live.current.onChange?.(editor.current.text());
		}
		setState(s);
	}

	// run calls the editor, or queues the call until it loads or until the
	// call it is inside returns, as a command that sets the text is.
	function run(call) {
		if (!editor.current || busy.current) {
			queue.current.push(call);
			return;
		}
		busy.current = true;
		try {
			show(call(editor.current));
		} finally {
			busy.current = false;
		}
		const next = queue.current.shift();
		if (next) run(next);
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: the editor keeps its own text and grammar after it mounts
	useEffect(() => {
		let gone = false;
		load(wasmUrl).then(
			(fude) => {
				if (gone) return;
				const ed = fude.create(defaultValue, rows, {
					command(line) {
						const f = live.current.onCommand;
						if (!f) return ["", `unknown command: ${line}`];
						try {
							const msg = f(line);
							return [typeof msg === "string" ? msg : "", ""];
						} catch (err) {
							return ["", err?.message || String(err)];
						}
					},
					clipboard: () => clip,
					copy(t) {
						clip = t;
						navigator.clipboard?.writeText(t).catch((err) => {
							console.warn("fude: copy to the clipboard:", err);
						});
					},
				});
				editor.current = ed;
				ed.readOnly(readOnly);
				const s = JSON.parse(ed.state());
				version.current = s.version;
				setState(s);
				const next = queue.current.shift();
				if (next) run(next);
			},
			(err) => {
				if (!gone) setFailed(err);
			},
		);
		return () => {
			gone = true;
			editor.current?.destroy();
			editor.current = null;
			queue.current = [];
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: run reads the editor when it runs
	useEffect(() => {
		if (editor.current) run((ed) => ed.resize(rows));
	}, [rows]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: run reads the editor when it runs
	useEffect(() => {
		if (editor.current) run((ed) => ed.readOnly(readOnly));
	}, [readOnly]);

	const loaded = state !== null;
	useEffect(() => {
		if (loaded && autoFocus) input.current.focus();
	}, [loaded, autoFocus]);

	useImperativeHandle(ref, () => ({
		focus: () => input.current?.focus(),
		blur: () => input.current?.blur(),
		getValue: () => editor.current?.text() ?? defaultValue,
		setValue: (t) => run((ed) => ed.setText(t)),
		type: (ks) => run((ed) => ed.type(ks)),
	}));

	// Keep the cursor in view sideways, and the input at the cursor, where
	// an input method shows what it composes.
	useLayoutEffect(() => {
		const box = text.current;
		const at = box?.querySelector("[data-cursor]");
		if (!at) return;
		const b = box.getBoundingClientRect();
		const c = at.getBoundingClientRect();
		const pad = 12;
		if (c.left < b.left + pad) box.scrollLeft -= b.left + pad - c.left;
		else if (c.right > b.right - pad) box.scrollLeft += c.right - b.right + pad;
		const v = view.current.getBoundingClientRect();
		const moved = at.getBoundingClientRect();
		input.current.style.left = `${moved.left - v.left}px`;
		input.current.style.top = `${moved.top - v.top}px`;
	});

	// The wheel scrolls the view by lines. React's own wheel listener cannot
	// keep the page from scrolling as well.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run reads the editor when it runs
	useEffect(() => {
		const el = text.current;
		if (!el) return;
		let rest = 0;
		const wheel = (e) => {
			if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
			const s = live.current.state;
			if (e.deltaY < 0 ? s.top === 0 : s.top >= s.lines - 1) return;
			e.preventDefault();
			const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
			rest += e.deltaMode === 1 ? e.deltaY * line : e.deltaY;
			const n = Math.trunc(rest / line);
			if (!n) return;
			rest -= n * line;
			run((ed) => ed.scroll(n));
		};
		el.addEventListener("wheel", wheel, { passive: false });
		return () => el.removeEventListener("wheel", wheel);
	}, [loaded]);

	// drain types what the input holds, as an input method or a phone's
	// keyboard leaves it there.
	function drain() {
		const t = input.current.value;
		input.current.value = "";
		if (t)
			run((ed) => ed.feed(Array.from(t, (ch) => (ch === "\n" ? "<CR>" : ch))));
	}

	function onKeyDown(e) {
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		const ks = keys(e);
		if (!ks.length) return;
		e.preventDefault();
		run((ed) => ed.feed(ks));
	}

	function onPaste(e) {
		e.preventDefault();
		const t = e.clipboardData.getData("text/plain");
		clip = t;
		run((ed) => ed.paste(t));
	}

	// cell returns the row and column a mouse is over. Outside insert mode a
	// column is the character under the mouse, not the gap nearest it.
	function cell(x, y) {
		const lines = text.current.querySelectorAll(".fude-line");
		const first = lines[0].getBoundingClientRect();
		const row = Math.min(
			Math.max(Math.floor((y - first.top) / first.height), 0),
			lines.length - 1,
		);
		const line = lines[row];
		const r = line.getBoundingClientRect();
		const end = Number(line.dataset.len);
		const pos = caretAt(x, r.top + r.height / 2);
		if (!pos || !line.contains(pos.node))
			return { row, col: x > r.left ? end : 0 };
		const at = pos.node.parentElement.dataset.at;
		if (pos.node.nodeType !== Node.TEXT_NODE || at === undefined)
			return { row, col: end };
		let col = Number(at) + pos.offset;
		const mode = live.current.state.mode;
		if (pos.offset > 0 && mode !== "insert" && mode !== "replace") {
			const t = pos.node.data;
			let from = pos.offset - 1;
			if (from > 0 && /[\uDC00-\uDFFF]/.test(t[from])) from--;
			const range = document.createRange();
			range.setStart(pos.node, from);
			range.setEnd(pos.node, pos.offset);
			if (x < range.getBoundingClientRect().right) col -= pos.offset - from;
		}
		return { row, col: Math.min(col, end) };
	}

	function onMouseDown(e) {
		if (e.button !== 0) return;
		e.preventDefault();
		input.current.focus();
		const from = cell(e.clientX, e.clientY);
		run((ed) => ed.click(from.row, from.col));
		let dragging = false;
		const move = (m) => {
			const to = cell(m.clientX, m.clientY);
			if (!dragging && to.row === from.row && to.col === from.col) return;
			dragging = true;
			run((ed) => ed.drag(from.row, from.col, to.row, to.col));
		};
		const up = () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	}

	// The rows change only with the version, the top and their count.
	// biome-ignore lint/correctness/useExhaustiveDependencies: state is read through those
	const colours = useMemo(() => {
		if (!highlight || !state) return null;
		try {
			return highlight({
				editor: editor.current,
				version: state.version,
				top: state.top,
				rows: state.rows.map((r) => r.text),
				text: () => editor.current.text(),
			});
		} catch (err) {
			console.error("fude: highlight:", err);
			return null;
		}
	}, [highlight, state?.version, state?.top, state?.rows.length]);

	const style = { "--rows": rows };
	const classes = ["fude", className].filter(Boolean).join(" ");
	if (failed)
		return (
			<div className={`${classes} fude-failed`} style={style} role="alert">
				the editor could not load: {failed.message || String(failed)}
			</div>
		);
	if (!state)
		return <div className={`${classes} fude-loading`} style={style} />;

	const typing = state.mode === "command";
	const bar = state.mode === "insert";
	const digits = String(state.lines).length;
	return (
		<div ref={view} className={classes} style={style}>
			<div className="fude-body">
				{lineNumbers && (
					<div
						className="fude-gutter"
						style={{ "--digits": digits }}
						aria-hidden
					>
						{state.rows.map((_, i) => {
							const n = state.top + i;
							const rel = lineNumbers === "relative" && n !== state.line;
							return (
								<div
									key={n}
									className={n === state.line ? "fude-current" : undefined}
								>
									{rel ? Math.abs(n - state.line) : n + 1}
								</div>
							);
						})}
					</div>
				)}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: the mouse puts the cursor, the input takes the keys */}
				<div ref={text} className="fude-text" onMouseDown={onMouseDown}>
					{state.rows.map((r, i) => (
						<Row
							// biome-ignore lint/suspicious/noArrayIndexKey: a row's key is its line number
							key={state.top + i}
							row={r}
							colours={colours?.[i]}
							cursor={typing ? -1 : r.cursor}
							bar={bar}
						/>
					))}
				</div>
			</div>
			<textarea
				ref={input}
				className={composing ? "fude-input fude-composing" : "fude-input"}
				aria-label={label}
				aria-multiline="true"
				aria-readonly={readOnly}
				autoComplete="off"
				autoCorrect="off"
				autoCapitalize="off"
				spellCheck={false}
				rows={1}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				onInput={(e) => {
					if (!e.nativeEvent.isComposing) drain();
				}}
				onCompositionStart={() => setComposing(true)}
				onCompositionEnd={() => {
					setComposing(false);
					drain();
				}}
			/>
			<div className="fude-status">
				{typing ? (
					<Row
						row={{ text: state.cmdline, cursor: state.cmdCursor }}
						cursor={state.cmdCursor}
						bar
					/>
				) : (
					<>
						<span className="fude-mode">{state.mode}</span>
						{state.readOnly && <span className="fude-note">read-only</span>}
						{state.recording && (
							<span className="fude-note">recording @{state.recording}</span>
						)}
						<span
							className={
								state.error ? "fude-message fude-error" : "fude-message"
							}
							role="status"
						>
							{state.message}
						</span>
						<span className="fude-shown">{state.shown}</span>
						<span className="fude-ruler">
							{state.line + 1}:{state.column + 1}
						</span>
					</>
				)}
			</div>
		</div>
	);
}

// caretAt returns the text node and offset nearest a point.
function caretAt(x, y) {
	if (document.caretPositionFromPoint) {
		const p = document.caretPositionFromPoint(x, y);
		return p && { node: p.offsetNode, offset: p.offset };
	}
	const r = document.caretRangeFromPoint?.(x, y);
	return r && { node: r.startContainer, offset: r.startOffset };
}

// Row draws one line with its colours, selection, matches, flash and
// cursors. A range or cursor at the line's end draws as a space after it.
function Row({ row, colours, cursor, bar }) {
	const t = row.text;
	const len = t.length;
	const width = (at) =>
		at >= len ? 1 : segmenter.segment(t.slice(at)).containing(0).segment.length;
	const marks = colours ? [...colours] : [];
	for (const [cls, list] of [
		["fude-sel", row.sel],
		["fude-match", row.match],
		["fude-flash", row.flash],
	])
		for (const [a, b] of list ?? []) marks.push([a, b, cls]);
	for (const c of row.cursors ?? [])
		marks.push([c, c + width(c), "fude-cursors"]);
	if (cursor >= 0 && !bar)
		marks.push([cursor, cursor + width(cursor), "fude-cursor"]);

	const cuts = new Set([0, len, len + 1]);
	if (cursor >= 0) cuts.add(cursor);
	for (const [a, b] of marks)
		cuts.add(Math.min(a, len + 1)).add(Math.min(b, len + 1));
	const sorted = [...cuts].sort((a, b) => a - b);
	const pieces = [];
	for (let i = 0; i < sorted.length - 1; i++) {
		const [a, b] = [sorted[i], sorted[i + 1]];
		if (bar && a === cursor)
			pieces.push(<span key="bar" className="fude-caret" data-cursor />);
		const on = marks.filter(([x, y]) => x <= a && a < y).map((m) => m[2]);
		const cls = on.join(" ") || undefined;
		const here = on.includes("fude-cursor") ? { "data-cursor": true } : {};
		if (a < len)
			pieces.push(
				<span key={a} className={cls} data-at={a} {...here}>
					{t.slice(a, b)}
				</span>,
			);
		else if (on.length)
			pieces.push(
				<span key="end" className={cls} {...here}>
					{" "}
				</span>,
			);
	}
	return (
		<div className="fude-line" data-len={len}>
			{pieces}
		</div>
	);
}
