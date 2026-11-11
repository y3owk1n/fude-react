package main

import (
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/y3owk1n/fude/core/kernel"
	"github.com/y3owk1n/fude/vim"
)

// Page is what an editor asks of the page it is on.
type Page struct {
	// Command runs an ex line the grammar leaves to the page, such as "w"
	// for :w, and returns a message to show. An error fails the command,
	// which stops a macro or :g that ran it.
	Command   func(line string) (string, error)
	Clipboard func() (string, bool) // the system clipboard, when the page knows it
	Copy      func(text string)     // puts text on the system clipboard
}

// Editor runs fude's vim grammar on a kernel buffer, for one editor on the
// page. It is the grammar's host.
type Editor struct {
	vim.Defaults
	b        *kernel.Buffer
	m        *vim.Machine
	page     Page
	cursor   kernel.MarkID
	top      kernel.MarkID // at the start of the first line shown
	marks    map[rune]kernel.MarkID
	rows     int
	readOnly bool
	forced   bool   // SetText edits a read-only text
	err      string // the error of the last call, shown in place of a message
	note     string // the message of the last command the page ran
}

// State is what the page draws: the rows in view and the status line.
// Columns count UTF-16 units, as the page's strings do.
type State struct {
	Version   kernel.Version `json:"version"` // changes when the text does
	Lines     int            `json:"lines"`
	Top       int            `json:"top"` // the line of the first row, from 0
	Rows      []Row          `json:"rows"`
	Line      int            `json:"line"`   // the cursor's line, from 0
	Column    int            `json:"column"` // the cursor's screen column, from 0
	Mode      string         `json:"mode"`
	Cmdline   string         `json:"cmdline"` // the command line, in command mode
	CmdCursor int            `json:"cmdCursor"`
	Message   string         `json:"message"`
	Error     bool           `json:"error"` // the message is an error
	Shown     string         `json:"shown"` // the keys of the command being typed
	Recording string         `json:"recording"`
	Pending   bool           `json:"pending"` // an operator or r waits for its target
	ReadOnly  bool           `json:"readOnly"`
}

// Row is one line in view. A range is a pair of columns, and one that ends
// past the text takes the line break.
type Row struct {
	Text    string   `json:"text"`
	Cursor  int      `json:"cursor"` // the cursor's column, or -1
	Cursors []int    `json:"cursors,omitempty"`
	Sel     [][2]int `json:"sel,omitempty"`
	Match   [][2]int `json:"match,omitempty"` // the match the search being typed goes to
	Flash   [][2]int `json:"flash,omitempty"` // what the last key yanked or put
}

var modes = map[vim.Mode]string{vim.Normal: "normal", vim.Insert: "insert", vim.Cmdline: "command", vim.Visual: "visual", vim.Replace: "replace"}

const origin kernel.Origin = "page"

var (
	errReadOnly    = errors.New("the text is read-only")
	errNoClipboard = errors.New("the page cannot read the clipboard, paste with the system's keys")
)

// NewEditor edits text in a view of rows lines.
func NewEditor(text string, rows int, page Page) *Editor {
	e := &Editor{b: kernel.New(text, nil), marks: map[rune]kernel.MarkID{}, rows: max(rows, 1), page: page}
	e.cursor = e.b.SetMark(0, kernel.Right)
	e.top = e.b.SetMark(0, kernel.Left)
	e.m = vim.New(e)
	return e
}

// Feed handles keys, one key each in vim notation, such as "<Esc>".
func (e *Editor) Feed(keys []string) {
	e.begin()
	for _, k := range keys {
		e.fail(e.m.Feed(vim.Key(k)))
	}
	e.scroll()
}

// Type handles keys written as one string in vim notation, such as "ggdG".
func (e *Editor) Type(keys string) {
	var ks []string
	for _, k := range vim.Keys(keys) {
		ks = append(ks, string(k))
	}
	e.Feed(ks)
}

// Paste types text as the grammar does a paste.
func (e *Editor) Paste(text string) {
	e.begin()
	e.fail(e.m.Paste(text))
	e.scroll()
}

// Click puts the cursor at column col of row, as a mouse does. A column
// past the line's end is its end.
func (e *Editor) Click(row, col int) {
	e.begin()
	if e.m.Mode() == vim.Cmdline {
		return
	}
	t := e.b.Snapshot()
	line := min(t.LineOf(e.Top())+max(row, 0), t.Lines()-1)
	ls := t.LineStart(line)
	e.SetCursor(e.land(t, ls+bytesAt(t.Slice(ls, vim.LineEnd(t, ls)), col)))
	e.scroll()
}

// Drag selects from where a mouse went down to where it is now.
func (e *Editor) Drag(fromRow, fromCol, row, col int) {
	if e.m.Mode() == vim.Cmdline {
		return
	}
	if e.m.Mode() != vim.Visual {
		if e.m.Mode() != vim.Normal {
			e.Feed([]string{"<Esc>"})
		}
		e.Click(fromRow, fromCol)
		e.Feed([]string{"v"})
	}
	e.Click(row, col)
}

// ScrollBy moves the view n lines down, or up when n is negative, and keeps
// the cursor in it, as a mouse wheel does.
func (e *Editor) ScrollBy(n int) {
	e.begin()
	t := e.b.Snapshot()
	top := min(max(t.LineOf(e.Top())+n, 0), t.Lines()-1)
	e.SetTop(t.LineStart(top))
	c := e.Cursor()
	line := t.LineOf(c)
	to := min(max(line, top), top+e.rows-1)
	if to == line {
		return
	}
	col := vim.Column(t, t.LineStart(line), c, e.TabWidth(), nil)
	e.SetCursor(e.land(t, vim.ColumnStart(t, t.LineStart(to), col, e.TabWidth(), nil)))
}

// Resize shows rows lines.
func (e *Editor) Resize(rows int) {
	e.rows = max(rows, 1)
	e.scroll()
}

// SetReadOnly keeps keys from changing the text, or lets them again.
func (e *Editor) SetReadOnly(on bool) { e.readOnly = on }

// SetText replaces the text as one change that undo takes back, even in a
// read-only editor. It ends what the keys were doing first, and leaves the
// message, as a command that sets the text has one.
func (e *Editor) SetText(text string) {
	for _, k := range []vim.Key{"<Esc>", "<Esc>"} {
		e.fail(e.m.Feed(k))
	}
	t := e.b.Snapshot()
	e.forced = true
	defer func() { e.forced = false }()
	if err := e.Apply([]vim.Edit{{Start: 0, End: t.Len(), Text: text}}, "set"); err != nil {
		e.fail(err)
		return
	}
	t = e.b.Snapshot()
	e.SetCursor(e.land(t, min(e.Cursor(), t.Len())))
	e.scroll()
}

// String returns the whole text.
func (e *Editor) String() string {
	t := e.b.Snapshot()
	return t.Slice(0, t.Len())
}

// Fail shows msg as the error of the last call.
func (e *Editor) Fail(msg string) { e.err = msg }

func (e *Editor) begin() { e.err, e.note = "", "" }

func (e *Editor) fail(err error) {
	if err != nil {
		e.err = err.Error()
	}
}

// land keeps pos off the line break in normal and visual mode, as the
// grammar keeps its cursor.
func (e *Editor) land(t vim.Text, pos int) int {
	if m := e.m.Mode(); m != vim.Normal && m != vim.Visual {
		return pos
	}
	ls, le := vim.LineStart(t, pos), vim.LineEnd(t, pos)
	if pos < le || le == ls {
		return pos
	}
	_, n := utf8.DecodeLastRuneInString(t.Slice(ls, le))
	return le - n
}

// scroll keeps the cursor's line in view, or the match a search being
// typed goes to.
func (e *Editor) scroll() {
	t := e.b.Snapshot()
	at := e.Cursor()
	if s, _, ok := e.m.Incremental(); ok {
		at = s
	}
	line := t.LineOf(at)
	top := min(t.LineOf(e.Top()), line)
	top = max(top, line-e.rows+1)
	e.SetTop(t.LineStart(top))
}

// State returns what the page draws now.
func (e *Editor) State() State {
	t := e.b.Snapshot()
	c := e.Cursor()
	line := t.LineOf(c)
	s := State{
		Version:   t.Version(),
		Lines:     t.Lines(),
		Top:       t.LineOf(e.Top()),
		Line:      line,
		Column:    vim.Column(t, t.LineStart(line), c, e.TabWidth(), nil),
		Mode:      modes[e.m.Mode()],
		Cmdline:   e.m.Line(),
		CmdCursor: units(e.m.Line()[:e.m.LineCursor()]),
		Message:   e.m.Message(),
		Shown:     e.m.Shown(),
		Pending:   e.m.Pending(),
		ReadOnly:  e.readOnly,
	}
	if r := e.m.Recording(); r != 0 {
		s.Recording = string(r)
	}
	switch {
	case e.err != "":
		s.Message, s.Error = e.err, true
	case e.note != "":
		s.Message = e.note
	}

	var sel [][2]int
	v, visual := e.m.Selection()
	block := visual && v.Block
	switch {
	case !visual, block:
	case v.Regions != nil:
		sel = v.Regions
	default:
		sel = [][2]int{{v.Start, v.End}}
	}
	if v.Kind == "V" {
		for i := range sel {
			sel[i][1]++ // a linewise selection takes each line break
		}
	}
	var match [][2]int
	if a, b, ok := e.m.Incremental(); ok {
		match = [][2]int{{a, b}}
	}
	flash, _ := e.m.Flash()
	cursors := e.m.Cursors()

	for l := s.Top; l < min(s.Top+e.rows, s.Lines); l++ {
		ls := t.LineStart(l)
		le := vim.LineEnd(t, ls)
		r := Row{Text: t.Slice(ls, le), Cursor: -1}
		col := func(p int) int { return units(r.Text[:min(max(p, ls), le)-ls]) }
		if c >= ls && c <= le {
			r.Cursor = col(c)
		}
		for _, x := range cursors {
			if x >= ls && x <= le {
				r.Cursors = append(r.Cursors, col(x))
			}
		}
		clip := func(ranges [][2]int) [][2]int {
			var out [][2]int
			for _, g := range ranges {
				if g[1] <= ls || g[0] > le || g[0] == g[1] {
					continue
				}
				end := col(g[1])
				if g[1] > le {
					end = units(r.Text) + 1
				}
				out = append(out, [2]int{col(g[0]), end})
			}
			return out
		}
		r.Sel = clip(sel)
		r.Match = clip(match)
		r.Flash = clip(flash)
		s.Rows = append(s.Rows, r)
	}
	if block {
		e.blockRows(t, v, s.Top, s.Rows)
	}
	return s
}

// blockRows puts a block selection on the rows in view, from the line top.
func (e *Editor) blockRows(t vim.Text, v vim.Selection, top int, rows []Row) {
	first, last := t.LineOf(v.Start), t.LineOf(max(v.End-1, v.Start))
	for i := range rows {
		l := top + i
		if l < first || l > last {
			continue
		}
		ls := t.LineStart(l)
		from := vim.ColumnStart(t, ls, v.Left, e.TabWidth(), nil)
		to := vim.LineEnd(t, ls)
		if v.Right < math.MaxInt {
			to = vim.ColumnStart(t, ls, v.Right+1, e.TabWidth(), nil)
		}
		if to > from {
			rows[i].Sel = [][2]int{{units(rows[i].Text[:from-ls]), units(rows[i].Text[:to-ls])}}
		}
	}
}

// units counts the UTF-16 units of s.
func units(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// bytesAt returns the byte offset in s of UTF-16 column col, or len(s).
func bytesAt(s string, col int) int {
	n := 0
	for i, r := range s {
		if n >= col {
			return i
		}
		n += utf16.RuneLen(r)
	}
	return len(s)
}

func (e *Editor) Top() int          { return e.b.Mark(e.top) }
func (e *Editor) Text() vim.Text    { return e.b.Snapshot() }
func (e *Editor) Cursor() int       { return e.b.Mark(e.cursor) }
func (e *Editor) SetCursor(pos int) { e.b.MoveMark(e.cursor, pos) }
func (e *Editor) BeginGroup()       { e.b.BeginGroup(origin) }
func (e *Editor) EndGroup()         { e.b.EndGroup(origin) }

func (e *Editor) Apply(edits []vim.Edit, label string) error {
	if e.readOnly && !e.forced {
		return errReadOnly
	}
	t := kernel.Transaction{Base: e.b.Snapshot().Version(), Origin: origin, Label: label, Time: time.Now()}
	for _, ed := range edits {
		t.Edits = append(t.Edits, kernel.Edit(ed))
	}
	return e.b.Apply(t)
}

func (e *Editor) Editable() error {
	if e.readOnly {
		return errReadOnly
	}
	return nil
}

func (e *Editor) Undo() (int, int, error) { return e.step(e.b.Undo) }
func (e *Editor) Redo() (int, int, error) { return e.step(e.b.Redo) }

// step undoes or redoes, unless the text is read-only, and puts the cursor
// where the step's text starts.
func (e *Editor) step(move func() (int, bool)) (int, int, error) {
	if e.readOnly {
		return 0, 0, errReadOnly
	}
	start, ok := move()
	if !ok {
		return 0, 0, vim.ErrNoStep
	}
	return start, start, nil
}

func (e *Editor) Unhandled(keys string) error {
	line, ok := strings.CutPrefix(keys, ":")
	if !ok {
		return nil // a <C-w> key, and there are no windows here
	}
	msg, err := e.page.Command(line)
	e.note = msg
	return err
}

func (e *Editor) Clipboard() (string, error) {
	if s, ok := e.page.Clipboard(); ok {
		return s, nil
	}
	return "", errNoClipboard
}

func (e *Editor) SetClipboard(text string) error {
	e.page.Copy(text)
	return nil
}

func (e *Editor) SetMark(name rune, pos int) {
	if id, ok := e.marks[name]; ok {
		e.b.MoveMark(id, pos)
		return
	}
	e.marks[name] = e.b.SetMark(pos, kernel.Right)
}

func (e *Editor) Mark(name rune) (int, bool) {
	id, ok := e.marks[name]
	if !ok {
		return 0, false
	}
	return e.b.Mark(id), true
}

func (e *Editor) DeleteMark(name rune) {
	if id, ok := e.marks[name]; ok {
		e.b.DeleteMark(id)
		delete(e.marks, name)
	}
}

// Viewport gives the start of the first line shown, which an edit may have
// left inside a line.
func (e *Editor) Viewport() (int, int, int) {
	return vim.LineStart(e.b.Snapshot(), e.Top()), e.rows, math.MaxInt
}

func (e *Editor) SetTop(top int) { e.b.MoveMark(e.top, top) }
