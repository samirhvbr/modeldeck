// A bare DailyChart mount for tests that are about the CHART itself rather than
// about a page — the hover cursor, the marks, the axes. Mounted the same way
// mount.jsx mounts the App (no act(); the tests wait on the DOM).
import React from 'react';
import { createRoot } from 'react-dom/client';
import DailyChart from '../src/DailyChart.jsx';

export function mountChart(node, props) {
  const root = createRoot(node);
  root.render(<DailyChart {...props} />);
  return root;
}
