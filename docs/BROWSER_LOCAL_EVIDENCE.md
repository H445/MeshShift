# Local Browser Qualification Evidence

Date: 2026-08-09

This is local evidence for the static browser surface. It supplements, but does
not replace, the cross-engine, zoom, and assistive-technology qualification
required by `BROWSER_COMPATIBILITY_MATRIX.md`.

## Environment

- Surface: Codex in-app Chromium-style browser
- Host: Windows 11 x64, local Vite preview
- Preview URL: `http://127.0.0.1:4175/`
- Default viewport: 1280×720
- Default device-pixel ratio: 1.25
- Browser console errors/warnings: none observed

## Responsive and high-DPI checks

Each viewport loaded the release preview and was checked for visible controls,
horizontal overflow, and vertical overflow.

| Viewport | Observed DPR | Result                                   |
| -------- | -----------: | ---------------------------------------- |
| 375×800  |         1.00 | Pass; no horizontal overflow             |
| 768×1024 |         1.00 | Pass; no horizontal or vertical overflow |
| 1024×768 |         1.00 | Pass; no horizontal or vertical overflow |
| 1280×720 |         1.25 | Pass; no horizontal or vertical overflow |
| 1440×900 |         1.00 | Pass; no horizontal or vertical overflow |

The 1280×720 run is the high-DPI local check. Browser zoom at 100%, 125%, and
200% remains an external matrix requirement because the available local browser
surface does not expose a reliable browser-chrome zoom control.

## Long and unusual filename check

The fixture `cube.glb` was loaded under this disposable filename:

```text
modelshift_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx [QA] (final)!.glb
```

At 375×800 the queue retained the full name in the accessible label and title,
showed finite mesh metadata, kept horizontal overflow false, and converted the
row to `Done` at 100% with the corresponding `.fbx` export saved. No browser
console errors or warnings were observed.

## Remaining qualification boundary

Edge, Firefox, Safari, mobile exclusions, screen readers, formal zoom levels,
and customer-owned operating-system/browser combinations still require the
release checkpoint described in the compatibility matrix and approval record.
