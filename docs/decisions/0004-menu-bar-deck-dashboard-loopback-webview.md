# 0004 — Menu bar stays the deck; dashboard is one loopback WKWebView window

- Date: 2026-08-14
- Links: #378, #402

The menu bar remains the glanceable deck; the dashboard gets a single SwiftUI window
hosting the existing dashboard in a WKWebView over loopback HTTP with the daemon's auth
token — not a dock-app rethink and not a second navigation system. When the daemon is
down the window shows an honest empty state with a start action, never a blank screen.
