import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import highlights from "tree-sitter-javascript/queries/highlights.scm?raw";
import grammar from "tree-sitter-javascript/tree-sitter-javascript.wasm?url";
import { FudeEditor } from "./FudeEditor.jsx";
import { useTreeSitter } from "./treeSitter.js";

const sample = `fude's vim keys, running in this page.

Try ciw, dap, u and <C-r>, a visual block with <C-v>,
:s/vim/Vim/g, or a macro with qa ... q and @a.
Click to put the cursor, drag to select, and scroll with the wheel.

	A tab, café, and 😀 keep the cursor where it belongs.
:w reaches the page through onCommand, and :anything else fails there.`;

const notes = Array.from(
	{ length: 60 },
	(_, i) => `${i + 1}. a line of ${"words ".repeat(1 + (i % 9))}`,
).join("\n");

const code = `// Colours come from tree-sitter, parsed again after each change.
import { readFile } from "node:fs/promises";

/* A comment over
   two lines stays a comment. */
export async function words(path, { min = 3 } = {}) {
	const text = await readFile(path, "utf8");
	const counts = new Map();
	for (const word of text.toLowerCase().match(/[a-zé]+/g) ?? []) {
		if (word.length >= min) counts.set(word, (counts.get(word) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);
}

const greeting = \`hello \${"world"}, 😀\`;
console.log(greeting, 42, true, null);`;

const other = `class Counter {
	#counts = new Map();

	add(word) {
		this.#counts.set(word, (this.#counts.get(word) ?? 0) + 1);
		return this;
	}
}`;

function Code() {
	const highlight = useTreeSitter(grammar, highlights);
	const [first, setFirst] = useState(true);
	return (
		<>
			<div className="controls">
				<button type="button" onClick={() => setFirst((f) => !f)}>
					other sample
				</button>
			</div>
			<FudeEditor
				key={first ? "code" : "other"}
				defaultValue={first ? code : other}
				rows={18}
				lineNumbers
				highlight={highlight}
				aria-label="code"
			/>
		</>
	);
}

function Demo() {
	const [text, setText] = useState(sample);
	const [log, setLog] = useState([]);
	const [shown, setShown] = useState(true);
	const [readOnly, setReadOnly] = useState(false);
	const [numbers, setNumbers] = useState("relative");
	const editor = useRef(null);

	function command(line) {
		if (line === "w") {
			const saved = editor.current.getValue();
			setLog((l) => [`saved ${saved.length} characters`, ...l].slice(0, 5));
			return `saved ${saved.split("\n").length} lines`;
		}
		if (line === "reset") {
			editor.current.setValue(sample);
			return "reset";
		}
		throw new Error(`unknown command: ${line}`);
	}

	return (
		<main>
			<h1>fude in React</h1>
			<p>
				A React component that edits text with fude's vim grammar, compiled to
				WebAssembly. Click an editor and type.
			</p>
			{shown && (
				<FudeEditor
					ref={editor}
					defaultValue={sample}
					rows={10}
					autoFocus
					onChange={setText}
					onCommand={command}
				/>
			)}
			<div className="controls">
				<button type="button" onClick={() => setShown((s) => !s)}>
					{shown ? "unmount" : "mount"}
				</button>
				<button
					type="button"
					disabled={!shown}
					onClick={() => editor.current.setValue(sample)}
				>
					reset text
				</button>
				<button
					type="button"
					disabled={!shown}
					onClick={() => {
						editor.current.type("gg0");
						editor.current.focus();
					}}
				>
					cursor to the start
				</button>
				<span className="meta">
					{text.length} characters, {text.split("\n").length} lines
				</span>
			</div>
			{log.length > 0 && (
				<ul className="log">
					{log.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the log only grows at the front
						<li key={i}>{line}</li>
					))}
				</ul>
			)}

			<h2>Line numbers and read-only</h2>
			<div className="controls">
				<label>
					<input
						type="checkbox"
						checked={readOnly}
						onChange={(e) => setReadOnly(e.target.checked)}
					/>{" "}
					read-only
				</label>
				<label>
					line numbers{" "}
					<select value={numbers} onChange={(e) => setNumbers(e.target.value)}>
						<option value="relative">relative</option>
						<option value="absolute">absolute</option>
						<option value="none">none</option>
					</select>
				</label>
			</div>
			<FudeEditor
				defaultValue={notes}
				rows={8}
				readOnly={readOnly}
				lineNumbers={
					numbers === "none"
						? false
						: numbers === "relative"
							? "relative"
							: true
				}
				aria-label="notes"
			/>

			<h2>Syntax highlighting</h2>
			<p>
				The page passes a highlight function, here one that parses JavaScript
				with tree-sitter.
			</p>
			<Code />
		</main>
	);
}

createRoot(document.getElementById("root")).render(
	<StrictMode>
		<Demo />
	</StrictMode>,
);
