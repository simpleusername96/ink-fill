# Ink Fill

An open-source puzzle-action browser game made with vanilla JavaScript and HTML5 Canvas. Created with AI (Codex and Claude), with human direction.

**[Play](https://playroom.mmonoo.com/en/games/ink-fill/#play)** · [한국어](README.ko.md)

https://github.com/user-attachments/assets/54c44873-2cdf-4c60-834d-aaa1bc102f9a

**Claim territory. Use tools to eliminate enemies. Combine tools and terrain.**

Watch complete playthroughs of stages 31, 28, and 33 in one video. [Download MP4](media/gameplay.mp4).

## About the game

Ink Fill is a puzzle-action game about claiming territory with a moving ball. Drag and release to launch it, bounce off walls, and connect its trail to seal off areas without enemies. Hit tool marbles to freeze, move, or defeat enemies, while keeping unfinished trails from being broken.

The campaign has 52 stages across seven worlds. Simple opening stages gradually give way to combinations of enemy types, tools, terrain, and boss fights. Each stage has a coverage target, and you can replay it to improve your shot count and earn more stars. All stages are available from the start. Mouse and touch are supported, with progress saved in your browser.

## Why I'm releasing the source

I'm sharing Ink Fill so others can build on the idea and take it further. After a few weeks of experimenting with puzzle-action gameplay, I haven't been able to make the game as enjoyable as I'd hoped, and I don't have a clear plan for improving it. The source is open for anyone who wants to refine it, redesign the stages, or try a different direction.

## For agents

This section and the linked [technical guide](FOR_AGENTS.md) were written entirely by AI to help AI agents understand and work on this project.

The game runs from one self-contained HTML file. Open `index.html` in a browser; no installation, build, or server is required. The current campaign contains 52 stages across seven worlds and supports Korean, English, Simplified Chinese, and Japanese. There is no background music or sound-effect system.

| File | Role |
| --- | --- |
| `index.html` | Stage data, simulation, Canvas rendering, input, menus, progress storage, and embedded translations. |
| `locales/*.json` | Translation sources; `tools/build-locales.cjs` embeds them in the HTML. |
| `tools/campaign.cjs` | Offline stage generation, route search, and replay verification using the game's actual simulation. |
| `tests/campaign-certificate.json` | Retained routes and bounded replay results for the current campaign. |
| `tests/*.cjs` | Simulation, browser interaction, rendering, and translation checks. |
| `tools/validate.cjs` | Development validation entry point. |

Development checks require Node.js 22 or later. These dependencies are needed for the checks, not for playing the game.

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm run validate
```

Read the Korean technical guide before changing simulation, stage generation, coordinate transforms, or localization. It describes the relevant entry points and validation boundaries.

## License

[MIT](LICENSE)
