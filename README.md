# ThoxMinator

iPhone and Mac shells for one agent. Chat is the front. The cell admits or stops every tool call before anything runs.

On a phone the layout is the iPhone app. On a wide window it is the Mac app: File and View menus, Command-N for a new chat, Command-1 through 4 for sections. Same agent either way.

## Run

```bash
npm install
npm run dev
```

## Layout

- `src/components/minator` — iPhone and Mac UI
- `src/lib/cell` — proposer, verifier, and the cell that admits or stops tools
- `spaces/thoxminator-cell` — shared cell API, also published as [Thox-ai/thoxminator-cell](https://huggingface.co/spaces/Thox-ai/thoxminator-cell)

The cell keeps file access inside the workspace. Network calls stay stopped. Mail needs an approval card and still does not leave the machine.
