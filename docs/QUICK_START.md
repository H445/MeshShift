# Quick start for users

## 1. Download and install

Download the latest release from
[GitHub Releases](https://github.com/H445/MeshShift/releases/latest).

- **Windows:** run the `.exe` installer.
- **macOS:** open the `.dmg`, then drag MeshShift to Applications. Choose the
  `arm64` build for Apple Silicon Macs and `x64` for Intel Macs.
- **Linux:** download the `.AppImage`, make it executable, and launch it. For
  example:

  ```sh
  chmod +x MeshShift-*-linux-x86_64.AppImage
  ./MeshShift-*-linux-x86_64.AppImage
  ```

The desktop release includes the runtime it needs. You do not need to install
Node.js, pnpm, or a separate server.

## 2. Convert a model

1. Open MeshShift.
2. Click **Choose files** and select your model.
3. For glTF or OBJ assets, select their companion `.bin`, `.mtl`, and texture
   files in the same file selection.
4. Choose an output format in **Settings**. FBX is selected by default.
5. Click **Convert all**.

The converted model appears in the Output viewer and the queue shows **Done**.
Use **Save again** if you want to repeat the export after changing a setting.

## 3. Find your exported files

Open **Settings → Export location** to see the exact active folder.

By default, MeshShift uses an `exports` folder beside the installed
application. If the operating system prevents writing beside the application,
MeshShift uses a writable documents fallback and shows that location in
Settings. Click **Browse…** to choose another folder, or **Use default** to
restore the default behavior.

Batch conversions place each model in its own subfolder so companion files do
not overwrite one another.

## 4. Create lower-detail versions

Open **Profiles** and set **Generate LODs** to the number of additional levels
you want. Leave a triangle target at `0` to let MeshShift choose a
quality-focused target automatically. Generate the optimized preview before
converting if you want to inspect the result first.

For detail-sensitive areas, use **Edit detail pins** in the Output viewer to
preserve important vertices through deeper LOD levels. See the
[full walkthrough](HOW_TO_USE.md) for screenshots and examples.

## Troubleshooting

- If macOS blocks the first launch, open **System Settings → Privacy & Security**
  and allow MeshShift to open.
- If Linux does not launch the AppImage, confirm it is executable and that FUSE
  support is available on your distribution.
- If an export fails, open Settings and choose a folder where your user account
  has write permission.
- The release page includes `SHA256SUMS.txt` for verifying downloaded files.

Developers who want to run from source should use the
[Developer guide](DEVELOPER.md), not this user quick start.
