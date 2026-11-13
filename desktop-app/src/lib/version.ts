// Stamped into index.html by the `meshaudio-app-version` Vite plugin. Reading
// it from the DOM works in dev and in the packaged build, where package.json is
// not part of the webview bundle.
export const APP_VERSION: string =
  (typeof document !== 'undefined'
    ? document.querySelector('meta[name="app-version"]')?.getAttribute('content')
    : '') || '0.0.0'
