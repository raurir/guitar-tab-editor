# Guitar Tab Editor

A browser-based guitar tab editor with playback, built with Svelte 5 and Vite.

Entirely vibe coded.

## Development

```sh
yarn install
yarn dev
yarn build
yarn check
```

## Files

Songs are saved as `.tab.json` files. In Chromium browsers, Save writes back to the opened file; elsewhere it downloads a copy. Only player settings (volume, metal mode) are kept in browser storage.

Keyboard shortcuts are listed at the bottom of the app.
