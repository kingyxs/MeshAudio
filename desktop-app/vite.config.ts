import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'node:fs';

const host = process.env.TAURI_DEV_HOST;
// The packaged webview cannot read package.json, so the app version is stamped
// into index.html at build time and read back by src/lib/version.ts.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string };
const appVersion = pkg.version || '0.0.0';

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'meshaudio-app-version',
      transformIndexHtml(html: string) {
        return html.replace(
          '</head>',
          `  <meta name="app-version" content="${appVersion}" />\n</head>`
        );
      }
    }
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  build: { target: 'es2021' },
  test: {
    // src-tauri/resources is a copy of the sidecar sources, not a vitest suite.
    exclude: ['**/node_modules/**', '**/src-tauri/**']
  }
});
