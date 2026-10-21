// The app is written against React's API and runs on Preact's compatible runtime: ~15 KB instead of ~210 KB
// of react-dom for the same components. Vite (build) and Vitest (tests) both resolve React through this.
export const preactAliases = [
  { find: /^react-dom\/client$/, replacement: 'preact/compat/client' },
  { find: /^react-dom\/server$/, replacement: 'preact/compat/server' },
  { find: /^react-dom$/, replacement: 'preact/compat' },
  { find: /^react\/jsx-runtime$/, replacement: 'preact/jsx-runtime' },
  { find: /^react\/jsx-dev-runtime$/, replacement: 'preact/jsx-dev-runtime' },
  { find: /^react$/, replacement: 'preact/compat' },
];
