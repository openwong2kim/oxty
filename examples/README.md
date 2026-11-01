# Examples

A real shell drawn by `oxtty/xterm`. Build the package first: `(cd packages/oxtty && npm run build)`.

| Example | Run | What it shows |
| --- | --- | --- |
| [browser](browser) | `npm install && npm start`, open http://localhost:8080 | node-pty on a local server, the terminal in a web page, one WebSocket between them |
| [electron](electron) | `npm install && npm start` | node-pty in the main process, the terminal in the renderer; the engine's wasm bytes come over IPC because a `file://` page cannot fetch them |

Coming from xterm.js, the only new step is `await init()` before the first `new Terminal()`.
