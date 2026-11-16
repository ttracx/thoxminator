# ThoxMinator

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![THOX.ai](https://img.shields.io/badge/THOX.ai-LLC-red.svg)
![Repository](https://img.shields.io/badge/repository-ttracx%2Fthoxminator-0B1220)

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

---

## Legal

Copyright (c) 2024-2026 THOX.ai LLC. All rights reserved.

**THOX.ai LLC**
- CTO: Tommy Xaypanya
- CEO: Craig Ross

Licensed under the MIT License. See [LICENSE](LICENSE) for details.

Unauthorized copying, modification, merger, publication, distribution, sublicensing, and/or selling of this software, via any medium, is strictly prohibited without prior written consent from THOX.ai LLC.
