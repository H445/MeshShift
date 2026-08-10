# Development, safety limits, and limitations

## Development commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm release:check
```

Set `MODELSHIFT_MAX_FILE_MB` to change the default 200 MB aggregate input
limit. The legacy `G2F_MAX_FILE_MB` variable is still recognized.

## Safety limits and local configuration

The converter applies defensive limits at every public entry point:

- External input bundles default to 200 MB total. Configure the limit with
  `MODELSHIFT_MAX_FILE_MB`.
- Local browser exports default to 1 GB per file. Configure the limit with
  `MODELSHIFT_MAX_EXPORT_MB`.
- An input bundle may contain at most 4,096 files, and public optimization
  options are validated before parsing.
- Companion files must be local, relative resources inside the selected input
  directory. Absolute paths, traversal, URL resources, and symlink escapes are
  rejected by the CLI.
- CLI outputs are written atomically beneath the requested output directory;
  symlinked output parents and unsafe generated names are rejected.

Both environment variables accept non-negative megabytes. Invalid or
overflowing values fall back to the documented defaults. These controls are
intended for local deployments and should be set to match the host’s available
memory and disk budget.

## Limitations

- Format conversion cannot create features the destination format does not
  support.
- OBJ, STL, PLY, and the current DAE writer do not contain skeletal animation
  or morph animation.
- Assimp has partial support for some animation/material combinations; verify
  production assets in the target engine or DCC.
- Texture resizing and LOD texture baking require the browser canvas pipeline.
  The Node API and CLI preserve unchanged embedded PNG/JPEG bytes.
- Draco and KTX2/Basis inputs are not decoded by the current preprocessing path.
- USD/USDZ are not exposed because this bundled Assimp build does not provide a
  verified import/export path for them.
- Direct browser saving requires the local ModelShift dev or preview server; a
  separately hosted static build cannot write to the repository filesystem.
