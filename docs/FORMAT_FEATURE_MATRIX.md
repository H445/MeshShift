# Format and Feature Matrix

This matrix records the supported disposition for MeshShift 0.2.x. “Verified”
means covered by an automated fixture, structural invariant, or round-trip test;
“Partial” means the feature is retained when the underlying Assimp path supports
it and a warning or documented limitation applies; “N/A” means the destination
format cannot represent the feature.

| Feature                                  | GLB/glTF input                                           | FBX input                           | OBJ/STL/PLY/DAE/3DS input         | FBX output                                | GLB/glTF output                                          | OBJ/STL/PLY/DAE output            |
| ---------------------------------------- | -------------------------------------------------------- | ----------------------------------- | --------------------------------- | ----------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| Triangle topology and indices            | Verified                                                 | Verified by parseable import        | Verified for static mesh fixtures | Verified by round-trip parse              | Verified by parseable output                             | Verified by output parse          |
| Vertex positions/normals/UVs             | Verified                                                 | Partial; Assimp-dependent           | Partial; source-format-dependent  | Partial; Assimp-dependent                 | Verified for supported source attributes                 | Partial; destination-dependent    |
| Vertex colors/tangents                   | Verified for self-contained glTF path; partial otherwise | Partial                             | Partial                           | Partial                                   | Verified for self-contained glTF path; partial otherwise | Partial                           |
| Scene hierarchy and transforms           | Verified for self-contained glTF path; partial otherwise | Partial                             | Partial                           | Partial                                   | Verified for self-contained glTF path; partial otherwise | Partial                           |
| Materials and texture references         | Partial; local resources only                            | Partial                             | OBJ MTL/textures supported        | Partial                                   | Partial; self-contained GLB/glTF path is covered         | OBJ MTL/textures supported        |
| Embedded PNG/JPEG textures               | Partial; source/importer-dependent                       | Partial                             | Partial                           | Partial                                   | Partial                                                  | OBJ resource extraction supported |
| Skinning and inverse bind matrices       | Verified by skinned fixture structure                    | Partial                             | N/A for source formats            | Partial                                   | Verified for self-contained glTF path; partial otherwise | N/A                               |
| Skeletal animation                       | Verified by animated fixture parse path                  | Partial                             | N/A                               | Partial                                   | Verified for self-contained glTF path; partial otherwise | N/A                               |
| Morph targets                            | Verified by inspection/counting fixtures where present   | Partial                             | N/A                               | Partial                                   | Verified for self-contained glTF path; partial otherwise | N/A                               |
| Cameras and lights                       | Verified for self-contained glTF path; partial otherwise | Partial                             | N/A                               | Partial                                   | Verified for self-contained glTF path; partial otherwise | N/A                               |
| Names and custom metadata                | Verified for self-contained glTF path; partial otherwise | Partial                             | Partial                           | Partial                                   | Verified for self-contained glTF path; partial otherwise | Partial                           |
| LOD generation and selection             | Verified in core/browser optimization tests              | Applicable after normalization      | Applicable after normalization    | Exported from prepared GLB                | Verified in prepared GLB catalog tests                   | Exported from prepared GLB        |
| Texture resize/LOD baking                | Browser-only, partial                                    | Browser-only after normalization    | Browser-only after normalization  | N/A in Node/CLI                           | Browser-only                                             | Browser-only                      |
| External companion resources             | Local relative `.bin`, `.mtl`, textures                  | Importer-dependent                  | Local relative resources          | glTF/OBJ companion files where applicable | glTF `.bin` and OBJ resources                            | glTF `.bin` and OBJ resources     |
| Remote URLs, Draco, KTX2/Basis, USD/USDZ | Unsupported                                              | Unsupported/unsupported by contract | Unsupported                       | Unsupported                               | Unsupported                                              | Unsupported                       |

## Fidelity rules

- The source remains the authority for supported attributes; a destination
  format's representational limits are documented rather than silently treated
  as lossless conversion.
- Every exported primary file must be non-empty and parseable by the bundled
  Assimp path for formats with a parser in the test fixture.
- The output statistics must report input bytes, output bytes, mesh/material/
  texture/animation/bone/morph counts, triangle count, vertex count, and
  duration.
- Static destinations emit a warning when the source contains animation.
- The self-contained glTF/GLB path has structural regression coverage for
  camera/light extension data, animation interpolation/timing metadata,
  skin joints/inverse-bind accessors, names, and supported extras; this is not
  a claim of lossless behavior for every importer or extension.
- Any feature marked Partial requires customer validation in the target DCC or
  engine before production use.
