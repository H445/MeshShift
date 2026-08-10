# Core TypeScript API

```ts
import { convertAsset } from 'meshshift';

const result = await convertAsset(
  [
    { name: 'model.obj', data: objBytes },
    { name: 'model.mtl', data: mtlBytes },
    { name: 'albedo.png', data: textureBytes },
  ],
  { outputFormat: 'glb', name: 'model.obj' },
);

result.filename; // model.glb
result.data; // primary output bytes
result.files; // every output file
result.stats;
result.warnings;
```

`convertGltfToFbx()` remains as a backwards-compatible wrapper. `convertBatch()`
accepts the same output options and supports companion files through each batch
item’s `files` property.

Long-running core and optimization calls may receive an `AbortSignal` through
their options. Cancellation is cooperative: the API returns a typed
`AbortError` at the next phase boundary or yield, while a native parser/export
operation already in progress may finish its current operation first.
