default:
    @just --list

# Build the grammar into src/ with tinygo, beside the wasm_exec.js of the
# same tinygo. tinygo finds its root through the links oku makes only when
# told.
wasm:
    #!/bin/sh -e
    export TINYGOROOT="$(dirname "$(dirname "$(realpath "$(command -v tinygo)")")")"
    tinygo build -target wasm -no-debug -o src/fude.wasm .
    cp -f "$TINYGOROOT/targets/wasm_exec.js" src/

# Serve the demo page with reloads.
dev: wasm
    npm install
    npm run dev

# Build the demo page into dist/.
build: wasm
    npm install
    npm run build

test:
    go test ./...

# Format the Go and the page.
fmt:
    gofmt -w .
    biome check --write

# Check formatting, vet and test.
check:
    test -z "$(gofmt -l .)"
    go vet ./...
    GOOS=js GOARCH=wasm go vet ./...
    biome check
    go test ./...

# Record demos/fude-react.gif with the headless Chrome or Chromium at chrome.
demo chrome: build
    #!/bin/sh -e
    npx vite preview --port 5301 --strictPort >/dev/null &
    server=$!
    trap 'kill $server' EXIT
    until curl -fs http://localhost:5301/ >/dev/null; do sleep 0.2; done
    node demos/record.mjs "{{chrome}}" http://localhost:5301/ demos/fude-react.gif

# Check the component in the headless Chrome or Chromium at chrome, on the
# built page.
e2e chrome: build
    #!/bin/sh -e
    npx vite preview --port 5302 --strictPort >/dev/null &
    server=$!
    trap 'kill $server' EXIT
    until curl -fs http://localhost:5302/ >/dev/null; do sleep 0.2; done
    node test/e2e.mjs "{{chrome}}" http://localhost:5302/
