import React from 'react';
import { createRoot } from 'react-dom/client';
import ResetCalendar from '../src/ResetCalendar.jsx';

export function mountResetCalendar(node, props = {}) {
  const root = createRoot(node);
  root.render(<ResetCalendar {...props} />);
  return root;
}
