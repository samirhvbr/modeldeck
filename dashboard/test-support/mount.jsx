// The click-test entry point: the real App, mounted the way main.jsx mounts it.
//
// Deliberately NOT wrapped in React's act(): recharts measures its plot through
// the ResizeObserver, so every flush schedules another measurement and act()
// never reaches quiescence. The tests wait on the DOM instead (waitFor in
// ./index.mjs), which is the same thing a reader's eye does.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App.jsx';

export function mountApp(node) {
  const root = createRoot(node);
  root.render(<App />);
  return root;
}
