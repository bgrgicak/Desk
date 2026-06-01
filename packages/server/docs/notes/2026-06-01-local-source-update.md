# Local source update notes

- The source checkout should be treated as deployment input, not as the runtime
  directory. Running pre-prod directly from the editable checkout can expose the
  running process to rewritten `dist/` files or `node_modules` changes.
- A release directory keeps the "last good build keeps running" property: build
  failures never move `current`, so restart is skipped and the existing service
  remains on its previous target.
- The first implementation can use a full filesystem copy for correctness. If
  release size becomes a problem, optimize later with rsync hard links or a
  smaller staged package layout.
