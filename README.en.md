# Ink Fill

[한국어](README.md) · **[Play](https://playroom.mmonoo.com/en/games/ink-fill/#play)**

Launch a ball, connect its trail, and fill regions without enemies. All 52 stages across seven worlds are available from the start. The game supports Korean, English, Simplified Chinese, and Japanese.

![Ink Fill gameplay](media/preview.png)

Made with Codex and Claude under human planning and direction.

## Play and controls

Open `index.html` in a browser. No installation or build is needed.

- Drag and release to launch the ball in the opposite direction. Drag length sets its power.
- Connect trails to claim empty regions. Hit tool marbles to remove or move enemies.
- R: restart · Esc: pause or cancel aiming · G: predicted paths.
- Mouse and touch are supported. Progress is stored in your browser.

## Edit and check the source

Game code, stages, and presentation live in `index.html`. Edit translations in `locales/`, then run `node tools/build-locales.cjs`. `tools/campaign.cjs` generates stages and verifies their routes.

Development checks require Node.js 22 or later. These tools are not needed to play.

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm run validate
```

## Status and license

This repository shares the currently published version. Further development and responses to issues or pull requests are not guaranteed. You can fork, modify, or continue the project.

[MIT License](LICENSE)
