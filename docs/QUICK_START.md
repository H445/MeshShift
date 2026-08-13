# Quick start

MeshShift requires Node.js 22 or newer and pnpm 10.30.1. Install pnpm
globally if it is not already available:

```bash
npm install --global pnpm@10.30.1
```

Install dependencies once:

```bash
pnpm install
```

Launch MeshShift from the repository root.

Linux/macOS:

```sh
sh ./start.sh
```

Windows PowerShell:

```powershell
.\start.ps1
```

Both launchers start the local Vite development server at
`http://localhost:5173/`. Additional Vite options are forwarded unchanged:

```sh
sh ./start.sh --port 5180 --host 0.0.0.0 --open
```

```powershell
.\start.ps1 --port 5180 --host 0.0.0.0 --open
```

`pnpm dev` remains available as a package-manager alias for the same shared
launcher.

Build every release surface:

```bash
pnpm build
```

The reusable Node API is written to `dist/core/`, the CLI bundle is
`dist/cli/meshshift.mjs`, and the production web app is written to
`dist/client/`. Use `pnpm preview` when testing the production build locally
so the `exports/` writer remains available.

For the Electron desktop development build, run:

```bash
pnpm desktop:dev
```

The packaged desktop application uses Electron's embedded runtime. Published
portable CLI archives include their own supported Node.js runtime and do not
require Node.js to be installed separately.

## Export destination

The web app automatically saves every successful conversion directly under
the repository’s `exports/` directory instead of using the browser Downloads
folder. A single conversion writes its output and companion files at the root
of `exports/`. A batch conversion groups each converted asset into its own
subdirectory to prevent companion-file name collisions. The **Save again**
controls retry the write or overwrite existing files.

The local writer accepts only relative paths beneath `exports/`, rejects
traversal and unsafe path segments, and overwrites an older file with the same
path. Generated files are ignored by Git; `exports/.gitkeep` retains the empty
directory in a checkout.
