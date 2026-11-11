import { useEffect, useState } from "react";
import { Edit, Language, Parser, Query } from "web-tree-sitter";
import runtime from "web-tree-sitter/web-tree-sitter.wasm?url";

let ready = null;

// init starts tree-sitter's runtime once for the page.
function init() {
	ready ??= Parser.init({ locateFile: () => runtime }).catch((err) => {
		ready = null;
		throw err;
	});
	return ready;
}

// useTreeSitter returns a highlight function for FudeEditor that parses
// with the grammar at grammarUrl and colours with the highlights query, or
// null while they load. Give each editor its own, since it keeps that
// editor's tree. A capture such as @function.method becomes the class
// hl-function-method.
export function useTreeSitter(grammarUrl, highlights) {
	const [highlight, setHighlight] = useState(null);
	useEffect(() => {
		let gone = false;
		let h = null;
		init()
			.then(() => Language.load(grammarUrl))
			.then((language) => {
				if (gone) return;
				h = highlighter(language, highlights);
				setHighlight(() => h.highlight);
			})
			.catch((err) => console.error("fude: tree-sitter:", err));
		return () => {
			gone = true;
			setHighlight(null);
			h?.dispose();
		};
	}, [grammarUrl, highlights]);
	return highlight;
}

// highlighter parses each version of the text once, reusing the tree from
// the version before, and colours the rows in view. A new editor starts a
// new tree.
function highlighter(language, highlights) {
	const parser = new Parser();
	parser.setLanguage(language);
	const query = new Query(language, highlights);
	let tree = null;
	let text = "";
	let version = -1;
	let editor = null;
	const highlight = (view) => {
		if (view.editor !== editor) {
			tree?.delete();
			tree = null;
			text = "";
			editor = view.editor;
			version = -1;
		}
		if (view.version !== version) {
			const next = view.text();
			tree?.edit(new Edit(change(text, next)));
			const parsed = parser.parse(next, tree);
			tree?.delete();
			tree = parsed;
			text = next;
			version = view.version;
		}
		const top = view.top;
		const rows = view.rows;
		const captures = query.captures(tree.rootNode, {
			startPosition: { row: top, column: 0 },
			endPosition: { row: top + rows.length, column: 0 },
		});
		// Outer nodes paint first and later patterns over earlier ones, so
		// the innermost and most specific capture shows.
		captures.sort(
			(a, b) =>
				b.node.endIndex -
					b.node.startIndex -
					(a.node.endIndex - a.node.startIndex) ||
				a.patternIndex - b.patternIndex,
		);
		const paint = rows.map((r) => new Array(r.length).fill(null));
		for (const { name, node } of captures) {
			const cls = `hl-${name.replaceAll(".", "-")}`;
			const { startPosition: s, endPosition: e } = node;
			for (
				let row = Math.max(s.row, top);
				row <= Math.min(e.row, top + rows.length - 1);
				row++
			) {
				const line = paint[row - top];
				const from = row === s.row ? s.column : 0;
				const to = row === e.row ? e.column : line.length;
				line.fill(cls, from, to);
			}
		}
		return paint.map(spans);
	};
	return {
		highlight,
		dispose() {
			tree?.delete();
			query.delete();
			parser.delete();
		},
	};
}

// spans turns a row's class per column into runs of [from, to, class].
function spans(line) {
	const out = [];
	for (let i = 0; i < line.length; ) {
		let j = i + 1;
		while (j < line.length && line[j] === line[i]) j++;
		if (line[i]) out.push([i, j, line[i]]);
		i = j;
	}
	return out;
}

// change describes the edit that turns before into after, as the span
// between what they start and end with in common.
function change(before, after) {
	let start = 0;
	const most = Math.min(before.length, after.length);
	while (start < most && before.charCodeAt(start) === after.charCodeAt(start))
		start++;
	let tail = 0;
	while (
		tail < most - start &&
		before.charCodeAt(before.length - 1 - tail) ===
			after.charCodeAt(after.length - 1 - tail)
	)
		tail++;
	return {
		startIndex: start,
		oldEndIndex: before.length - tail,
		newEndIndex: after.length - tail,
		startPosition: point(before, start),
		oldEndPosition: point(before, before.length - tail),
		newEndPosition: point(after, after.length - tail),
	};
}

// point returns the row and column of index in text.
function point(text, index) {
	let row = 0;
	let last = -1;
	for (
		let i = text.indexOf("\n");
		i !== -1 && i < index;
		i = text.indexOf("\n", i + 1)
	) {
		row++;
		last = i;
	}
	return { row, column: index - last - 1 };
}
