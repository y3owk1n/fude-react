package main

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func newEditor(text string, rows int) *Editor {
	return NewEditor(text, rows, Page{
		Command: func(line string) (string, error) {
			if line == "w" {
				return "saved", nil
			}
			return "", errors.New("unknown command: " + line)
		},
	})
}

// Keys edit the text with undo, and the rows count columns in UTF-16
// units, as the page's strings do.
func TestEdit(t *testing.T) {
	e := newEditor("hello big world", 10)
	for _, c := range []struct{ keys, text string }{
		{"wdw", "hello world"},
		{"$bcwthere<Esc>", "hello there"},
		{"u", "hello world"},
		{"<C-r>", "hello there"},
		{"0yeP", "hellohello there"},
	} {
		e.Type(c.keys)
		if got := e.String(); got != c.text {
			t.Fatalf("after %s: text %q, want %q", c.keys, got, c.text)
		}
	}

	e = newEditor("é😀 ab\ncd", 10)
	e.Type("W")
	if r := e.State().Rows[0]; r.Cursor != 4 {
		t.Errorf("cursor at %d, want 4", r.Cursor)
	}
	e.Type("vj")
	rows := e.State().Rows
	if !slices.Equal(rows[0].Sel, [][2]int{{4, 7}}) || !slices.Equal(rows[1].Sel, [][2]int{{0, 2}}) || rows[1].Cursor != 1 {
		t.Errorf("rows %+v, want the selection through the line break to d", rows)
	}
}

// The view follows the cursor and the keys that scroll it, on lines of
// unequal length.
func TestView(t *testing.T) {
	var b strings.Builder
	for i := range 40 {
		fmt.Fprintf(&b, "line %d %s\n", i, strings.Repeat("x", i%7))
	}
	e := newEditor(b.String(), 10)
	for _, c := range []struct {
		keys      string
		top, line int
	}{
		{"<C-d>", 5, 5},
		{"<C-d>", 10, 10},
		{"zz", 6, 10},
		{"zt", 10, 10},
		{"G", 31, 40},
		{"gg", 0, 0},
	} {
		e.Type(c.keys)
		if s := e.State(); s.Top != c.top || s.Line != c.line {
			t.Errorf("after %s: top %d, line %d, want %d, %d", c.keys, s.Top, s.Line, c.top, c.line)
		}
	}
	e.ScrollBy(15)
	if s := e.State(); s.Top != 15 || s.Line != 15 || s.Rows[0].Text != "line 15 x" {
		t.Errorf("after scrolling 15: top %d, line %d, first row %q", s.Top, s.Line, s.Rows[0].Text)
	}
}

// A read-only editor refuses keys that edit, and SetText still replaces its
// text as one change undo takes back.
func TestReadOnly(t *testing.T) {
	e := newEditor("one\ntwo", 10)
	e.SetReadOnly(true)
	e.Type("ddi")
	if s := e.State(); e.String() != "one\ntwo" || s.Mode != "normal" || !s.Error {
		t.Errorf("text %q, mode %s, error %v, want it unchanged in normal mode with an error", e.String(), s.Mode, s.Error)
	}
	e.SetText("three")
	e.SetReadOnly(false)
	if e.String() != "three" {
		t.Errorf("text %q, want three", e.String())
	}
	e.Type("u")
	if e.String() != "one\ntwo" {
		t.Errorf("after u: text %q, want one\\ntwo", e.String())
	}
}

// An ex line the grammar leaves to the page runs there, and shows its
// message or its error.
func TestCommand(t *testing.T) {
	e := newEditor("text", 10)
	e.Type(":w<CR>")
	if s := e.State(); s.Message != "saved" || s.Error {
		t.Errorf(":w shows %q, error %v", s.Message, s.Error)
	}
	e.Type(":nope<CR>")
	if s := e.State(); s.Message != "unknown command: nope" || !s.Error {
		t.Errorf(":nope shows %q, error %v", s.Message, s.Error)
	}
}
