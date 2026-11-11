//go:build js

// Command fude-react is fude's vim grammar for the browser. It sets
// fude.create, which the page calls once for each editor it shows.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime/debug"
	"syscall/js"
)

func main() {
	js.Global().Set("fude", map[string]any{"create": js.FuncOf(create)})
	select {}
}

// create takes the text, the rows the view shows and the page, an object
// with command(line), clipboard() and copy(text). command returns
// [message, error], with "" for none, and clipboard returns null when the
// page does not know it. create returns the editor's calls. Each returns
// the state as JSON, but text, which returns the text, and destroy.
func create(_ js.Value, args []js.Value) any {
	page := args[2]
	e := NewEditor(args[0].String(), args[1].Int(), Page{
		Command: func(line string) (string, error) {
			r := page.Call("command", line)
			if msg := r.Index(1).String(); msg != "" {
				return "", errors.New(msg)
			}
			return r.Index(0).String(), nil
		},
		Clipboard: func() (string, bool) {
			r := page.Call("clipboard")
			return r.String(), r.Type() == js.TypeString
		},
		Copy: func(text string) { page.Call("copy", text) },
	})
	state := func() any {
		b, err := json.Marshal(e.State())
		if err != nil {
			panic(fmt.Sprintf("state: %v", err)) // a state is plain data
		}
		return string(b)
	}
	var funcs []js.Func
	// fn makes a call of f. A panic in it shows as the editor's error, and
	// the stack goes to the console, so a bug in one editor does not stop
	// the others.
	fn := func(f func(args []js.Value) any) js.Func {
		jf := js.FuncOf(func(_ js.Value, args []js.Value) (out any) {
			defer func() {
				if r := recover(); r != nil {
					js.Global().Get("console").Call("error", fmt.Sprintf("fude: %v\n%s", r, debug.Stack()))
					e.Fail(fmt.Sprintf("internal error: %v", r))
					out = state()
				}
			}()
			return f(args)
		})
		funcs = append(funcs, jf)
		return jf
	}
	// then makes a call that runs f and returns the state.
	then := func(f func(args []js.Value)) js.Func {
		return fn(func(args []js.Value) any {
			f(args)
			return state()
		})
	}
	h := map[string]any{
		"state": then(func([]js.Value) {}),
		"feed": then(func(args []js.Value) {
			keys := make([]string, args[0].Length())
			for i := range keys {
				keys[i] = args[0].Index(i).String()
			}
			e.Feed(keys)
		}),
		"type":  then(func(args []js.Value) { e.Type(args[0].String()) }),
		"paste": then(func(args []js.Value) { e.Paste(args[0].String()) }),
		"click": then(func(args []js.Value) { e.Click(args[0].Int(), args[1].Int()) }),
		"drag": then(func(args []js.Value) {
			e.Drag(args[0].Int(), args[1].Int(), args[2].Int(), args[3].Int())
		}),
		"scroll":   then(func(args []js.Value) { e.ScrollBy(args[0].Int()) }),
		"resize":   then(func(args []js.Value) { e.Resize(args[0].Int()) }),
		"readOnly": then(func(args []js.Value) { e.SetReadOnly(args[0].Bool()) }),
		"setText":  then(func(args []js.Value) { e.SetText(args[0].String()) }),
		"text":     fn(func([]js.Value) any { return e.String() }),
	}
	var destroy js.Func
	destroy = js.FuncOf(func(js.Value, []js.Value) any {
		for _, f := range funcs {
			f.Release()
		}
		destroy.Release()
		return nil
	})
	h["destroy"] = destroy
	return h
}
