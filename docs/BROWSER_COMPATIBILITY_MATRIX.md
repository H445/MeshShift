# Browser Compatibility Matrix

This is the release qualification matrix for the static client and local export
writer. The contract is “current and previous stable” for each engine; the
exact browser version and OS must be recorded in the release evidence bundle.

| Engine / surface       | Required coverage                                                          | Current evidence                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium desktop       | Current and previous stable; 100%, 125%, and 200% zoom; keyboard-only flow | Local evidence in `BROWSER_LOCAL_EVIDENCE.md`: Codex in-app Chromium-style browser, 1280×720 at device pixel ratio 1.25 plus 375×800, 768×1024, 1024×768, and 1440×900 viewport checks; long/unusual filename converted to Done at 100%; the broader current/previous-stable and zoom matrix remains a release checkpoint; zero console errors |
| Edge desktop           | Current and previous stable; Windows 10/11                                 | Required release-checkpoint run; not available in this workspace                                                                                                                                                                                                                                                                               |
| Firefox desktop        | Current and previous stable; Linux and Windows                             | Required release-checkpoint run; not available in this workspace                                                                                                                                                                                                                                                                               |
| Safari desktop         | Current and previous stable; macOS Intel and Apple Silicon                 | Required release-checkpoint run; not available in this workspace                                                                                                                                                                                                                                                                               |
| Mobile Chromium/WebKit | Explicitly out of the 0.2.x support contract unless separately qualified   | Not a ship blocker for the declared desktop contract                                                                                                                                                                                                                                                                                           |
| Screen reader          | NVDA/Windows and VoiceOver/macOS on supported desktop browsers             | Required release-checkpoint run; semantic labels and modal behavior are implemented, but assistive-technology output is not verifiable from this workspace                                                                                                                                                                                     |

## Required scenarios

Each qualified engine must exercise:

- empty, drag/drop, file chooser, loading, processing, success, warning, error,
  retry, and recovery states;
- settings and profiles dialogs with focus return, Escape, Tab wrapping, and
  no hidden dialog exposed in the accessibility tree;
- long filenames, unusual but valid Unicode names, high-DPI/zoom, reduced
  motion, and keyboard-only conversion;
- local export endpoint behavior and static-host behavior where filesystem
  export is intentionally unavailable.

## Evidence capture

Record browser version, OS, viewport, device-pixel ratio, zoom, scenario result,
console warnings/errors, and a screenshot or accessibility-tree excerpt for any
failure. A release is blocked by a reproducible P1 keyboard, data-loss, or
security regression. Browser-specific cosmetic differences are P2 only when the
declared accessibility target remains satisfied.
