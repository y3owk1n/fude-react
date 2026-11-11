const named = {
	Escape: "<Esc>",
	Enter: "<CR>",
	Backspace: "<BS>",
	Delete: "<Del>",
	Insert: "<Insert>",
	ArrowUp: "<Up>",
	ArrowDown: "<Down>",
	ArrowLeft: "<Left>",
	ArrowRight: "<Right>",
	Home: "<Home>",
	End: "<End>",
	PageUp: "<PageUp>",
	PageDown: "<PageDown>",
};
const arrows = new Set([
	"<Up>",
	"<Down>",
	"<Left>",
	"<Right>",
	"<Home>",
	"<End>",
]);

// keys turns a key going down into vim keys, as fude's own frontends do: an
// Alt chord is <Esc> and the key, and a Meta chord is the browser's.
export function keys(e) {
	if (e.metaKey || e.isComposing) return [];
	if (e.key === "Tab") return [e.shiftKey ? "<S-Tab>" : "\t"];
	if (/^F\d+$/.test(e.key)) return [`<${e.key}>`];
	const n = named[e.key];
	if (n) {
		if (e.ctrlKey && arrows.has(n)) return [`<C-${n.slice(1)}`];
		if (e.shiftKey && arrows.has(n)) return [`<S-${n.slice(1)}`];
		return [n];
	}
	const plain = e.code.startsWith("Key")
		? e.code.slice(3).toLowerCase()
		: e.code.startsWith("Digit")
			? e.code.slice(5)
			: e.key;
	if (e.ctrlKey) {
		if (plain === "6" || e.key === "^") return ["<C-^>"];
		if (e.key === " " || plain === "2" || e.key === "@") return ["<C-@>"];
		return [...e.key].length === 1 ? [`<C-${e.key.toLowerCase()}>`] : [];
	}
	if (e.altKey && plain.length === 1)
		return ["<Esc>", e.shiftKey ? plain.toUpperCase() : plain];
	return [...e.key].length === 1 ? [e.key] : [];
}
