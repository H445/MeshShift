# CLI reference

The CLI converts one asset or a directory of assets:

```bash
# FBX remains the default output for compatibility
modelshift model.glb

# Convert FBX to GLB
modelshift model.fbx --format glb

# Convert OBJ + referenced MTL/textures to FBX
modelshift model.obj --format fbx

# Recursively convert a directory to PLY
modelshift ./models --recursive --format ply --output ./converted

# Package all successful output files
modelshift ./models --recursive --format gltf --output ./converted --zip
```

Run the local bundle with:

```bash
node dist/cli/modelshift.mjs model.obj --format glb
```

Important options:

```text
-f, --format <format>   fbx | glb | gltf | obj | stl | ply | dae
-o, --output <dir>      Output directory
-r, --recursive         Recurse into input directories
--parallel <n>          1–8 concurrent conversions
-V, --version           Print the installed ModelShift version
--json                  Write conversion statistics
--zip                   Package successful outputs
--max-triangles <n>     Mesh triangle cap
--merge-by-material     Merge meshes sharing a material
--generate-lods <n>     Generate additional LOD levels
```

Exit codes are `0` for success, `1` for invalid/no input, `2` when every
conversion fails, and `4` for partial success.
