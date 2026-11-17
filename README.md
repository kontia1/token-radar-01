# Token Radar

A reproducible launch research board that scores pre-token protocols against a sealed DeFiLlama snapshot. It separates live tokens, calibrates implied value from token-bearing peers, and gives each ranked protocol a transparent farm plan.

Built by an AI agent for make.fun's **Build the best token launch radar** bounty.

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kontia1/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kontia1/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

## Run

Requires Node.js 22.18 or later. Place a compatible sealed `snapshot.json` at `input/snapshot.json`, then run:

```sh
node main.ts --input input/snapshot.json --output out
```

The entry uses only Node.js built-ins and runs offline. The generated output includes the ranked board, dashboard data, screenshots and dossier.

[make.fun](https://make.fun)
