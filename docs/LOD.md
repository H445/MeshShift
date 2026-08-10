# LOD generation, texture reprojection, and vertex pins

LOD generation is a geometry-first pipeline. It favors a safe plateau over
hitting a triangle target with holes, folded faces, broken UV islands, or a
visibly damaged outline.

1. **Prepare the source.** ModelShift normalizes the mesh to indexed geometry
   and keeps the high-detail source available for feature checks and optional
   texture projection. Each requested LOD is generated independently from
   LOD0, not from the previous LOD, so errors do not compound down the chain.
2. **Choose the triangle budget.** Explicit per-level targets take precedence.
   Automatic targets use 50%, 30%, 20%, and 12% of the source for LOD1–LOD4;
   automatic LOD4 is additionally capped at 450 triangles. Targets never go
   below four triangles, and accepted levels must decrease monotonically.
3. **Run progressive Meshopt passes.** The simplifier begins with conservative
   error tolerances and relaxes them only when necessary. Textured meshes use
   attribute-aware and UV-safe passes that weight UV continuity, preserve
   surviving normals and colors, lock severe UV discontinuities, and protect
   atlas borders.
4. **Repair topology.** If aggressive reduction makes an edge belong to more
   than two faces, ModelShift duplicates the vertices of the exceptional faces.
   This keeps every triangle visible while removing the non-manifold edge
   instead of dropping a face and creating a crack or hole.
5. **Audit critical shape features.** The reduced surface is compared with the
   source using a BVH closest-point search. Missing points are scored by
   geometric deviation, local curvature, extremity, and silhouette importance.
6. **Run silhouette passes.** Three canonical snap views audit the XY, XZ, and
   YZ envelopes. Another 24 oblique views approximate a free-orbit inspection.
   High-value missing anchors may be restored by splitting a face or a shared
   manifold edge.
7. **Validate every repair.** Candidate splits must preserve face orientation
   and source-normal agreement, avoid degenerate or paper-thin triangles,
   maintain acceptable triangle quality, and avoid projected-area explosions.
8. **Accept or safely plateau.** A level is accepted only when it is smaller
   than the preceding level and passes the safety checks. If no safe reduction
   is available, ModelShift clones the last safe geometry and reports a
   `safe plateau`; it does not substitute a destructive fallback.
9. **Rebuild UVs and bake textures when available.** Textured LODs receive a
   new non-overlapping xatlas/watlas UV atlas. Every atlas pixel is projected
   back to the intact source with a reusable BVH, closest-surface lookup, and
   forward/backward ray fallback.
10. **Verify and finish the bake.** Projection coverage must touch enough
    distinct source faces and span the model on its active axes. Bounded
    dilation fills chart padding and missed samples, then material texture slots
    are resampled with the source transforms, wrapping modes, and bilinear
    filtering. If unwrapping, projection, validation, or baking fails, the
    simplified geometry keeps its safe source material/UV path.
11. **Assemble the scene.** Generated meshes are named `_LOD1`, `_LOD2`, and so
    on and are added as siblings of LOD0 with the same transform. Keeping them
    as siblings lets an engine or viewer switch their visibility independently.

## Vertex pins

In the web UI, **Edit detail pins** locks the nearest selected vertex from the
chosen LOD through deeper levels. Pins can protect silhouettes, landmarks,
caps, edges, and other details that a simplifier might otherwise remove.
Regenerate the optimized preview after changing pins so the cached optimization
includes the new constraints.

For very large meshes, the same policy is applied with bounded repair and
texture proxies, compact geometry allocation, and periodic browser yields to
prevent the LOD job from monopolizing memory or the main thread.
