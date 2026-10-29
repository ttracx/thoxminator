---
title: ThoxMinator Cell
emoji: 🟢
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
short_description: Cell API for the ThoxMinator iPhone and Mac apps
pinned: false
---

Shared cell for ThoxMinator. The agent proposes. This service admits or stops the tool call.

`GET /api/health`

`POST /api/turn` with `{ "goal": "...", "card": false, "files": {} }`
