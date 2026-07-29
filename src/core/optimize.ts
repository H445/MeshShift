/**
 * Optimization pass for glTF / GLB assets targeting game engines
 * (Unity, Unreal, Godot). Runs in the browser, before FBX export.
 *
 * What it does:
 *
 *   - Decimation: each Mesh above `maxTriangles` is simplified with
 *     meshoptimizer's progressive, position-aware simplifier. UV-seam
 *     duplicates are welded for the reduction pass and exceptional
 *     non-manifold faces are split instead of dropped, so low LODs do not
 *     punch holes into the mesh.
 *   - Merge by material: meshes that share a material are combined
 *     into one geometry → fewer draw calls on the engine side.
 *   - Generate LODs: in addition to the (possibly decimated) LOD0,
 *     emit LOD1..LODn as child meshes with progressive decimation
 *     (×0.5, ×0.25, ...).
 *   - Texture resize: any texture whose longest edge exceeds
 *     `maxTextureSize` is downsampled to that size using a canvas.
 *
 * Output: a fresh binary glTF (glb) you can feed back into
 * `convertGltfToFbx` to export to FBX. The same code path that reads
 * the original GLB will read the optimized one — assimp will pick up
 * the merged meshes / LOD children / resized textures automatically.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  BufferAttribute,
  BufferGeometry,
  type InterleavedBufferAttribute,
  type TypedArray,
  Vector3,
} from 'three';
import { MeshoptSimplifier, type SimplifierFlags } from 'meshoptimizer';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import {
  applyEnginePreset,
  DEFAULT_DEEPEST_LOD_TRIANGLE_CAP,
  DEFAULT_LOD_TRIANGLE_RATIOS,
  type ConvertOptions,
  type InspectResult,
} from '../shared/options.js';
import { inspectGltf, inspectScene } from './inspect.js';
import { makeProgress } from './progress.js';

declare const __IS_BROWSER__: boolean;

type VertexAttribute = BufferAttribute | InterleavedBufferAttribute;
type TypedArrayConstructor = new (length: number) => TypedArray;

/**
 * Allocate a tightly packed array with the same scalar type as a regular or
 * interleaved source attribute. GLTFLoader commonly interleaves large meshes,
 * so compaction must read through the attribute API instead of assuming the
 * values are contiguous in `attribute.array`.
 */
function createAttributeArray(attribute: VertexAttribute, length: number): TypedArray {
  const sourceArray = 'data' in attribute ? attribute.data.array : attribute.array;
  const ArrayConstructor = sourceArray.constructor as TypedArrayConstructor;
  return new ArrayConstructor(length);
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface OptimizeResult {
  /** The optimized GLB (binary glTF). Pass to convertGltfToFbx next. */
  data: Uint8Array;
  /** Metadata of the optimized scene. */
  stats: InspectResult;
  /** What we actually did. */
  changes: OptimizeChange[];
}

export interface OptimizeChange {
  kind: 'decimate' | 'merge' | 'lod' | 'texture-resize' | 'texture-bake';
  /** Free-form description for the UI. */
  detail: string;
  /** For decimate/merge: triangle count before → after. */
  trianglesBefore?: number;
  trianglesAfter?: number;
  /** For texture-resize: dimension before → after. */
  sizeBefore?: number;
  sizeAfter?: number;
}

export interface GeneratedLodGeometry {
  level: number;
  geometry: import('three').BufferGeometry;
  triangleCount: number;
  /** Source vertices reintroduced to repair severe local surface loss. */
  restoredVertices: number;
  /** True when this and subsequent levels reuse the last topology-safe mesh. */
  safePlateau: boolean;
}

export interface CriticalVertexRepairResult {
  geometry: import('three').BufferGeometry;
  triangleCount: number;
  restoredVertices: number;
}

/** Internal mesh record used during the pass. */
interface MeshRecord {
  mesh: import('three').Mesh | import('three').SkinnedMesh;
  before: number;
  /** High-detail projection source retained even when LOD0 is decimated. */
  sourceGeometry: import('three').BufferGeometry;
}

/**
 * Build every requested LOD level. When no further safe reduction is
 * possible, later levels clone the last safe geometry instead of disappearing
 * from the output or falling back to a hole-producing simplifier.
 */
export async function generateLodGeometries(
  source: import('three').BufferGeometry,
  requestedLevels: number,
  lodTriangleTargets?: number[],
  onProgress?: (pct: number) => void,
): Promise<GeneratedLodGeometry[]> {
  const levelCount = Math.max(0, Math.min(8, Math.floor(requestedLevels)));
  const sourceTriangles = source.index
    ? source.index.count / 3
    : source.attributes.position.count / 3;
  const levels: GeneratedLodGeometry[] = [];
  let largeRepairProxy: import('three').BufferGeometry | null = null;
  let previousTriangles = Math.round(sourceTriangles);
  onProgress?.(0);

  try {
    for (let level = 1; level <= levelCount; level++) {
      // Generate every level directly from LOD0. Repeatedly simplifying the
      // previous LOD compounds geometric and UV error, so the deepest levels
      // can be much worse than a single reduction to the same triangle count.
      // Independent levels cost more CPU time but maximize visual quality.
      const configuredTarget = lodTriangleTargets?.[level - 1];
      const automaticRatio =
        DEFAULT_LOD_TRIANGLE_RATIOS[level - 1] ?? Math.max(0.025, 0.5 ** level);
      const ratioTarget = sourceTriangles * automaticRatio;
      // Keep the first three levels ratio-based, but ensure the deepest
      // automatic level actually becomes a low-poly asset even when the source
      // is a scan with millions of triangles.  Explicit targets remain absolute
      // and are never changed by this policy.
      const automaticTarget =
        level >= 4 ? Math.min(ratioTarget, DEFAULT_DEEPEST_LOD_TRIANGLE_CAP) : ratioTarget;
      const target = Math.max(
        4,
        Math.floor(
          typeof configuredTarget === 'number' &&
            Number.isFinite(configuredTarget) &&
            configuredTarget > 0
            ? configuredTarget
            : automaticTarget,
        ),
      );
      let geometry: import('three').BufferGeometry;
      let triangleCount = previousTriangles;
      let restoredVertices = 0;
      let safePlateau = false;

      if (target < previousTriangles) {
        let simplified: Awaited<ReturnType<typeof meshoptDecimate>> = null;
        try {
          if (
            sourceTriangles > MAX_EXHAUSTIVE_REPAIR_SOURCE_TRIANGLES &&
            target <= MAX_LARGE_MESH_REPAIR_PROXY_TRIANGLES
          ) {
            largeRepairProxy ??= buildLargeMeshRepairProxy(
              source,
              MAX_LARGE_MESH_REPAIR_PROXY_TRIANGLES,
            );
          }
          simplified = await meshoptDecimate(source, target, largeRepairProxy ?? undefined);
        } catch {
          // Treat unsupported/pathological geometry as a safe plateau.
        }
        if (simplified && simplified.triangleCount < previousTriangles) {
          geometry = simplified.geometry;
          triangleCount = simplified.triangleCount;
          restoredVertices = simplified.restoredVertices;
        } else {
          simplified?.geometry.dispose();
          safePlateau = true;
          geometry = levels.at(-1)?.geometry.clone() ?? source.clone();
        }
      } else {
        safePlateau = true;
        geometry = levels.at(-1)?.geometry.clone() ?? source.clone();
      }

      levels.push({ level, geometry, triangleCount, restoredVertices, safePlateau });
      previousTriangles = triangleCount;
      onProgress?.(levelCount > 0 ? level / levelCount : 1);
      if (sourceTriangles > MAX_EXHAUSTIVE_REPAIR_SOURCE_TRIANGLES) {
        await yieldToMainThread();
      }
    }
  } finally {
    largeRepairProxy?.dispose();
  }

  return levels;
}

interface CriticalSourcePoint {
  x: number;
  y: number;
  z: number;
  sourceVertices: number[];
  normalX: number;
  normalY: number;
  normalZ: number;
  normalCount: number;
}

interface RepairFace {
  a: number;
  b: number;
  c: number;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
  nx: number;
  ny: number;
  nz: number;
}

interface ClosestTrianglePoint {
  distanceSquared: number;
  wa: number;
  wb: number;
  wc: number;
}

interface RepairEdge {
  a: number;
  b: number;
  faceIndices: number[];
}

interface RestorationCandidate extends ClosestTrianglePoint {
  point: CriticalSourcePoint;
  faceIndex: number;
  sourceVertex: number;
  /** Source vertex used for UVs when it belongs to the same local atlas region. */
  uvSourceVertex: number;
  score: number;
  repairKind: 'face' | 'edge';
  affectedFaces: number[];
  edge?: RepairEdge;
}

/**
 * Restore a small number of source vertices when an aggressive simplification
 * loses a high-curvature or silhouette-defining region.
 *
 * An interior source anchor splits one triangle into three. A silhouette
 * anchor near a manifold edge splits both adjacent triangles around the same
 * source vertex. Both operations retain the old boundary and cannot create a
 * crack or non-manifold edge. Candidates are rejected when they belong to the
 * opposite side of a thin surface or would flip a child face.
 */
export function restoreCriticalVertices(
  source: import('three').BufferGeometry,
  simplified: import('three').BufferGeometry,
  targetTriangles: number,
): CriticalVertexRepairResult | null {
  const sourcePosition = source.attributes.position;
  const sourceIndex = source.index;
  const simplifiedPosition = simplified.attributes.position;
  const simplifiedIndex = simplified.index;
  if (!sourcePosition || !sourceIndex || !simplifiedPosition || !simplifiedIndex) return null;
  if (
    Object.values(simplified.attributes).some(
      (attribute) => 'data' in attribute || attribute.count !== simplifiedPosition.count,
    )
  ) {
    return null;
  }

  const currentTriangles = Math.floor(simplifiedIndex.count / 3);
  const sourceTriangles = Math.floor(sourceIndex.count / 3);
  if (currentTriangles < 1 || sourceTriangles <= currentTriangles) return null;

  // Avoid the all-pairs source-point/LOD-face search on very large meshes.
  // Without this guard a 1.8M-triangle asset can allocate millions of map
  // entries and then perform billions of closest-point tests, which presents
  // as a browser crash rather than a useful optimization result.
  if (sourceTriangles > MAX_EXHAUSTIVE_REPAIR_SOURCE_TRIANGLES) return null;

  // Scale the repair budget with simplification severity. Early LODs need
  // only a few anchors, while deep LODs have removed enough topology that a
  // fixed low ceiling cannot recover a recognizable silhouette. Reserve the
  // extra recovery budget for the final level only; earlier levels should
  // retain their tighter triangle targets and UVs.
  const reductionRatio = currentTriangles / sourceTriangles;
  const severity = Math.max(0, Math.min(1, (0.5 - reductionRatio) / 0.45));
  const deepRecovery = Math.max(0, Math.min(1, (severity - 0.95) / 0.05));
  const nominalTarget = Math.max(currentTriangles, Math.floor(targetTriangles));
  // Below sixteen triangles a single 1→3 split would consume too much of the
  // entire mesh budget. Preserve the genuinely tiny target instead.
  if (nominalTarget < 16) return null;
  const triangleHeadroom = 0.1 + severity * 0.55 + deepRecovery * 0.1;
  const maximumTriangles = Math.ceil(nominalTarget * (1 + triangleHeadroom));
  const budgetCapacity = Math.floor((maximumTriangles - currentTriangles) / 2);
  const qualityCapacity = Math.max(
    4,
    Math.min(48 + Math.round(deepRecovery * 16), Math.round(4 + severity * 44 + deepRecovery * 16)),
  );
  const maximumRestores = Math.min(budgetCapacity, qualityCapacity);
  if (maximumRestores < 1) return null;

  source.computeBoundingBox();
  const bounds = source.boundingBox;
  if (!bounds) return null;
  const sizeX = bounds.max.x - bounds.min.x;
  const sizeY = bounds.max.y - bounds.min.y;
  const sizeZ = bounds.max.z - bounds.min.z;
  const diagonal = Math.hypot(sizeX, sizeY, sizeZ) || 1;
  const centerX = (bounds.min.x + bounds.max.x) * 0.5;
  const centerY = (bounds.min.y + bounds.max.y) * 0.5;
  const centerZ = (bounds.min.z + bounds.max.z) * 0.5;

  // Weld source positions conceptually so UV-seam duplicates contribute to
  // one curvature estimate and cannot be restored more than once.
  const sourcePoints = new Map<string, CriticalSourcePoint>();
  for (let vertex = 0; vertex < sourcePosition.count; vertex++) {
    const x = sourcePosition.getX(vertex);
    const y = sourcePosition.getY(vertex);
    const z = sourcePosition.getZ(vertex);
    const key = criticalPositionKey(x, y, z);
    const point = sourcePoints.get(key);
    if (point) {
      point.sourceVertices.push(vertex);
    } else {
      sourcePoints.set(key, {
        x,
        y,
        z,
        sourceVertices: [vertex],
        normalX: 0,
        normalY: 0,
        normalZ: 0,
        normalCount: 0,
      });
    }
  }

  for (let offset = 0; offset + 2 < sourceIndex.count; offset += 3) {
    const a = sourceIndex.getX(offset);
    const b = sourceIndex.getX(offset + 1);
    const c = sourceIndex.getX(offset + 2);
    const ax = sourcePosition.getX(a);
    const ay = sourcePosition.getY(a);
    const az = sourcePosition.getZ(a);
    const bx = sourcePosition.getX(b);
    const by = sourcePosition.getY(b);
    const bz = sourcePosition.getZ(b);
    const cx = sourcePosition.getX(c);
    const cy = sourcePosition.getY(c);
    const cz = sourcePosition.getZ(c);
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const length = Math.hypot(nx, ny, nz);
    if (length < diagonal * diagonal * 1e-12) continue;
    nx /= length;
    ny /= length;
    nz /= length;
    for (const vertex of [a, b, c]) {
      const point = sourcePoints.get(
        criticalPositionKey(
          sourcePosition.getX(vertex),
          sourcePosition.getY(vertex),
          sourcePosition.getZ(vertex),
        ),
      )!;
      point.normalX += nx;
      point.normalY += ny;
      point.normalZ += nz;
      point.normalCount++;
    }
  }

  const existingPositions = new Set<string>();
  for (let vertex = 0; vertex < simplifiedPosition.count; vertex++) {
    existingPositions.add(
      criticalPositionKey(
        simplifiedPosition.getX(vertex),
        simplifiedPosition.getY(vertex),
        simplifiedPosition.getZ(vertex),
      ),
    );
  }

  const faces: RepairFace[] = [];
  const repairFaceByTriangle = new Int32Array(Math.floor(simplifiedIndex.count / 3));
  repairFaceByTriangle.fill(-1);
  for (let offset = 0; offset + 2 < simplifiedIndex.count; offset += 3) {
    const a = simplifiedIndex.getX(offset);
    const b = simplifiedIndex.getX(offset + 1);
    const c = simplifiedIndex.getX(offset + 2);
    const ax = simplifiedPosition.getX(a);
    const ay = simplifiedPosition.getY(a);
    const az = simplifiedPosition.getZ(a);
    const bx = simplifiedPosition.getX(b);
    const by = simplifiedPosition.getY(b);
    const bz = simplifiedPosition.getZ(b);
    const cx = simplifiedPosition.getX(c);
    const cy = simplifiedPosition.getY(c);
    const cz = simplifiedPosition.getZ(c);
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const length = Math.hypot(nx, ny, nz);
    if (length < diagonal * diagonal * 1e-12) continue;
    nx /= length;
    ny /= length;
    nz /= length;
    repairFaceByTriangle[Math.floor(offset / 3)] = faces.length;
    faces.push({
      a,
      b,
      c,
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      cx,
      cy,
      cz,
      nx,
      ny,
      nz,
    });
  }
  if (faces.length === 0) return null;

  // Map exact indexed edges to their adjacent faces. Only two-face manifold
  // edges are eligible for silhouette insertion; UV seams and open boundaries
  // remain untouched because they appear as one-face edges in indexed space.
  const repairEdges = new Map<string, RepairEdge>();
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
    const face = faces[faceIndex];
    for (const [a, b] of [
      [face.a, face.b],
      [face.b, face.c],
      [face.c, face.a],
    ]) {
      const edgeA = Math.min(a, b);
      const edgeB = Math.max(a, b);
      const key = repairEdgeKey(edgeA, edgeB);
      const edge = repairEdges.get(key);
      if (edge) edge.faceIndices.push(faceIndex);
      else repairEdges.set(key, { a: edgeA, b: edgeB, faceIndices: [faceIndex] });
    }
  }

  const deviationThreshold =
    diagonal * Math.max(0.0025, 0.012 * Math.sqrt(Math.max(0.001, reductionRatio)));
  const sourceUv = source.attributes.uv;
  const simplifiedUv = simplified.attributes.uv;
  const simplifiedBounds = repairAxisBounds(simplifiedPosition);
  const freeProjectionBounds = repairProjectionBounds(simplifiedPosition, FREE_REPAIR_VIEWS);
  const candidates: RestorationCandidate[] = [];
  // Query the reduced surface through a BVH instead of comparing every source
  // point with every LOD face. The old O(sourcePoints × faces) loop could
  // perform close to a billion triangle tests for a scan-sized proxy and was
  // the immediate cause of scan previews becoming unresponsive or crashing.
  const repairBvh = new MeshBVH(simplified, { indirect: true });
  const repairQuery = new Vector3();
  const repairHit: HitPointInfo = {
    point: new Vector3(),
    distance: 0,
    faceIndex: 0,
  };

  for (const [key, point] of sourcePoints) {
    if (existingPositions.has(key)) continue;
    repairQuery.set(point.x, point.y, point.z);
    const hit = repairBvh.closestPointToPoint(repairQuery, repairHit);
    if (!hit || hit.faceIndex < 0 || hit.faceIndex >= repairFaceByTriangle.length) continue;
    const closestFace = repairFaceByTriangle[hit.faceIndex];
    if (closestFace < 0) continue;
    const closest = closestPointOnRepairTriangle(point.x, point.y, point.z, faces[closestFace]);

    const distance = Math.sqrt(closest.distanceSquared);
    if (distance <= deviationThreshold) continue;
    const barycentricMargin = Math.min(closest.wa, closest.wb, closest.wc);

    let repairKind: RestorationCandidate['repairKind'] = 'face';
    let edge: RepairEdge | undefined;
    let affectedFaces = [closestFace];
    if (barycentricMargin < 0.075) {
      // A closest point on a triangle edge is often a missing silhouette
      // vertex. Do not treat a point nearest a corner as an edge insertion;
      // it would make one of the child triangles too small to be stable.
      const orderedWeights = [closest.wa, closest.wb, closest.wc].sort((a, b) => a - b);
      if (orderedWeights[1] < 0.1) continue;
      const face = faces[closestFace];
      let edgeA: number;
      let edgeB: number;
      if (closest.wa <= closest.wb && closest.wa <= closest.wc) {
        edgeA = face.b;
        edgeB = face.c;
      } else if (closest.wb <= closest.wc) {
        edgeA = face.c;
        edgeB = face.a;
      } else {
        edgeA = face.a;
        edgeB = face.b;
      }
      edge = repairEdges.get(repairEdgeKey(Math.min(edgeA, edgeB), Math.max(edgeA, edgeB)));
      if (!edge || edge.faceIndices.length !== 2) continue;
      repairKind = 'edge';
      affectedFaces = edge.faceIndices;
    }

    const face = faces[closestFace];
    const sourceNormalLength = Math.hypot(point.normalX, point.normalY, point.normalZ);
    const normalCoherence =
      point.normalCount > 0 ? sourceNormalLength / Math.max(1, point.normalCount) : 0;
    if (sourceNormalLength > 1e-8 && normalCoherence > 0.25) {
      const normalDot =
        (point.normalX * face.nx + point.normalY * face.ny + point.normalZ * face.nz) /
        sourceNormalLength;
      // A source point on the reverse side of a thin surface is geometrically
      // close but is not a valid anchor for this face.
      if (normalDot < 0.1) continue;
    }

    let sourceVertex = point.sourceVertices[0];
    let uvSourceVertex = sourceVertex;
    if (
      sourceUv &&
      sourceUv.itemSize >= 2 &&
      simplifiedUv &&
      simplifiedUv.itemSize >= 2 &&
      sourceUv.count === sourcePosition.count &&
      simplifiedUv.count === simplifiedPosition.count
    ) {
      const targetU =
        simplifiedUv.getX(face.a) * closest.wa +
        simplifiedUv.getX(face.b) * closest.wb +
        simplifiedUv.getX(face.c) * closest.wc;
      const targetV =
        simplifiedUv.getY(face.a) * closest.wa +
        simplifiedUv.getY(face.b) * closest.wb +
        simplifiedUv.getY(face.c) * closest.wc;
      let bestUvDistance = Number.POSITIVE_INFINITY;
      let bestUvVertex = sourceVertex;
      for (const vertex of point.sourceVertices) {
        const du = sourceUv.getX(vertex) - targetU;
        const dv = sourceUv.getY(vertex) - targetV;
        const uvDistance = du * du + dv * dv;
        if (uvDistance < bestUvDistance) {
          bestUvDistance = uvDistance;
          bestUvVertex = vertex;
        }
      }
      sourceVertex = bestUvVertex;
      // A welded source position can belong to several distant UV islands.
      // Never copy a seam vertex from a different island just because it is
      // the closest duplicate: that turns a few restored points into large
      // texture streaks.  Interpolate the simplified face UV instead when no
      // source duplicate is locally compatible with this face.
      const uvLocalityTolerance = 0.05;
      uvSourceVertex =
        bestUvDistance <= uvLocalityTolerance * uvLocalityTolerance ? bestUvVertex : -1;
    }

    const normalAverage = point.normalCount
      ? sourceNormalLength / Math.max(1, point.normalCount)
      : 1;
    const curvature = Math.max(0, Math.min(1, 1 - normalAverage));
    const axisSilhouette = repairAxisSilhouetteScore(point, simplifiedBounds, diagonal);
    const freeSilhouette = repairFreeSilhouetteScore(point, freeProjectionBounds, diagonal);
    const extremity = Math.max(
      sizeX ? Math.abs((point.x - centerX) / (sizeX * 0.5)) : 0,
      sizeY ? Math.abs((point.y - centerY) / (sizeY * 0.5)) : 0,
      sizeZ ? Math.abs((point.z - centerZ) / (sizeZ * 0.5)) : 0,
    );
    const silhouetteBoost = repairKind === 'edge' ? 1.6 : 1;
    const score =
      (distance / deviationThreshold) *
      (1 +
        curvature * 3 +
        Math.min(1, extremity) * 1.5 +
        Math.min(2, Math.max(axisSilhouette, freeSilhouette)) * 4) *
      silhouetteBoost;
    candidates.push({
      ...closest,
      point,
      faceIndex: closestFace,
      sourceVertex,
      uvSourceVertex,
      score,
      repairKind,
      affectedFaces,
      edge,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.score - left.score);

  const selected: RestorationCandidate[] = [];
  const usedFaces = new Set<number>();
  const minimumSpacing = diagonal * 0.012;
  const minimumSpacingSquared = minimumSpacing * minimumSpacing;
  for (const candidate of candidates) {
    if (selected.length >= maximumRestores) break;
    if (candidate.affectedFaces.some((faceIndex) => usedFaces.has(faceIndex))) continue;
    if (
      selected.some((other) => {
        const dx = other.point.x - candidate.point.x;
        const dy = other.point.y - candidate.point.y;
        const dz = other.point.z - candidate.point.z;
        return dx * dx + dy * dy + dz * dz < minimumSpacingSquared;
      })
    ) {
      continue;
    }
    const face = faces[candidate.faceIndex];
    const preservesOrientation =
      candidate.repairKind === 'edge' && candidate.edge
        ? candidate.edge.faceIndices.every((faceIndex) =>
            splitEdgePreservesFaceOrientation(
              faces[faceIndex],
              candidate.edge!.a,
              candidate.edge!.b,
              candidate.point.x,
              candidate.point.y,
              candidate.point.z,
              diagonal,
              candidate.point.normalX,
              candidate.point.normalY,
              candidate.point.normalZ,
            ),
          )
        : splitPreservesFaceOrientation(
            face,
            candidate.point.x,
            candidate.point.y,
            candidate.point.z,
            diagonal,
            candidate.point.normalX,
            candidate.point.normalY,
            candidate.point.normalZ,
          );
    if (!preservesOrientation) {
      continue;
    }
    for (const faceIndex of candidate.affectedFaces) usedFaces.add(faceIndex);
    selected.push(candidate);
  }
  if (selected.length === 0) return null;

  const selectedByFace = new Map<number, { candidate: RestorationCandidate; vertex: number }>();
  const outputVertexCount = simplifiedPosition.count + selected.length;
  for (let i = 0; i < selected.length; i++) {
    const repair = {
      candidate: selected[i],
      vertex: simplifiedPosition.count + i,
    };
    for (const faceIndex of selected[i].affectedFaces) selectedByFace.set(faceIndex, repair);
  }

  const output = new BufferGeometry();
  for (const [name, attribute] of Object.entries(simplified.attributes)) {
    const ArrayConstructor = attribute.array.constructor as new (
      length: number,
    ) => Float32Array | Uint8Array | Uint16Array | Uint32Array;
    const values = new ArrayConstructor(outputVertexCount * attribute.itemSize);
    values.set(attribute.array as typeof values);
    const sourceAttribute = source.attributes[name];
    for (let i = 0; i < selected.length; i++) {
      const candidate = selected[i];
      const face = faces[candidate.faceIndex];
      const outputOffset = (simplifiedPosition.count + i) * attribute.itemSize;
      for (let component = 0; component < attribute.itemSize; component++) {
        if (name === 'position') {
          values[outputOffset + component] =
            component === 0
              ? candidate.point.x
              : component === 1
                ? candidate.point.y
                : candidate.point.z;
        } else if (
          name === 'uv' &&
          candidate.uvSourceVertex >= 0 &&
          sourceAttribute &&
          sourceAttribute.itemSize === attribute.itemSize &&
          sourceAttribute.count === sourcePosition.count
        ) {
          values[outputOffset + component] = sourceAttribute.getComponent(
            candidate.uvSourceVertex,
            component,
          );
        } else if (
          sourceAttribute &&
          sourceAttribute.itemSize === attribute.itemSize &&
          sourceAttribute.count === sourcePosition.count &&
          (name !== 'uv' || candidate.uvSourceVertex >= 0)
        ) {
          values[outputOffset + component] = sourceAttribute.getComponent(
            candidate.sourceVertex,
            component,
          );
        } else {
          values[outputOffset + component] =
            attribute.getComponent(face.a, component) * candidate.wa +
            attribute.getComponent(face.b, component) * candidate.wb +
            attribute.getComponent(face.c, component) * candidate.wc;
        }
      }
    }
    output.setAttribute(
      name,
      new BufferAttribute(values, attribute.itemSize, attribute.normalized),
    );
  }

  const outputIndices: number[] = [];
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
    const face = faces[faceIndex];
    const restored = selectedByFace.get(faceIndex);
    if (restored) {
      if (restored.candidate.repairKind === 'edge' && restored.candidate.edge) {
        const split = splitRepairFaceAlongEdge(
          face,
          restored.candidate.edge.a,
          restored.candidate.edge.b,
          restored.vertex,
        );
        if (split) outputIndices.push(...split);
        else outputIndices.push(face.a, face.b, face.c);
      } else {
        outputIndices.push(
          face.a,
          face.b,
          restored.vertex,
          face.b,
          face.c,
          restored.vertex,
          face.c,
          face.a,
          restored.vertex,
        );
      }
    } else {
      outputIndices.push(face.a, face.b, face.c);
    }
  }
  output.setIndex(new BufferAttribute(new Uint32Array(outputIndices), 1));
  if (simplified.groups.length === 1) {
    output.addGroup(0, outputIndices.length, simplified.groups[0].materialIndex);
  }
  output.computeBoundingBox();
  output.computeBoundingSphere();
  repairNonManifoldTriangles(output);
  return {
    geometry: output,
    triangleCount: output.index ? output.index.count / 3 : outputIndices.length / 3,
    restoredVertices: selected.length,
  };
}

/**
 * Finish every simplification with the same geometry-driven feature repair.
 * The repair is deliberately dynamic: ordinary surfaces return unchanged,
 * while severe local loss gets a tightly bounded set of source anchors.
 */
function finishDecimation(
  source: import('three').BufferGeometry,
  simplified: { geometry: import('three').BufferGeometry; triangleCount: number },
  targetTriangles: number,
  largeMeshRepairProxy?: import('three').BufferGeometry,
): CriticalVertexRepairResult {
  let repaired = restoreCriticalVertices(source, simplified.geometry, targetTriangles);

  // Keep the same silhouette reinjection policy for scan-sized assets without
  // rebuilding a million-entry source-point map. A compact, spatially spread
  // proxy gives the repair scorer enough high-curvature/extremal anchors while
  // keeping the work bounded to a predictable triangle budget.
  if (!repaired && targetTriangles <= MAX_LARGE_MESH_REPAIR_PROXY_TRIANGLES) {
    const sourceIndex = source.index;
    const sourceTriangles = sourceIndex ? Math.floor(sourceIndex.count / 3) : 0;
    if (sourceTriangles > MAX_EXHAUSTIVE_REPAIR_SOURCE_TRIANGLES) {
      const ownsProxy = !largeMeshRepairProxy;
      const proxy =
        largeMeshRepairProxy ??
        buildLargeMeshRepairProxy(source, MAX_LARGE_MESH_REPAIR_PROXY_TRIANGLES);
      if (proxy) {
        try {
          repaired = restoreCriticalVertices(proxy, simplified.geometry, targetTriangles);
        } finally {
          if (ownsProxy) proxy.dispose();
        }
      }
    }
  }
  if (!repaired) return { ...simplified, restoredVertices: 0 };
  simplified.geometry.dispose();
  return repaired;
}

/** Build a bounded source sample for critical-vertex repair on huge meshes. */
function buildLargeMeshRepairProxy(
  source: import('three').BufferGeometry,
  maximumTriangles: number,
  includeAttribute: (name: string) => boolean = () => true,
): import('three').BufferGeometry | null {
  const position = source.attributes.position;
  const sourceIndex = source.index;
  if (!position || !sourceIndex || maximumTriangles < 8) return null;
  const sourceTriangles = Math.floor(sourceIndex.count / 3);
  if (sourceTriangles <= maximumTriangles) return source.clone();

  // Sample a regular stride so every region contributes, then add the faces
  // containing the six axis extrema so silhouettes remain represented even
  // when an extremal vertex happens to fall between stride samples.
  const stride = Math.max(1, Math.ceil(sourceTriangles / maximumTriangles));
  const selectedFaces = new Set<number>();
  for (let triangle = 0; triangle < sourceTriangles; triangle += stride) {
    selectedFaces.add(triangle);
  }
  const extrema = new Set<number>();
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  let minXVertex = -1,
    maxXVertex = -1,
    minYVertex = -1,
    maxYVertex = -1,
    minZVertex = -1,
    maxZVertex = -1;
  for (let vertex = 0; vertex < position.count; vertex++) {
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const z = position.getZ(vertex);
    if (x < minX) {
      minX = x;
      minXVertex = vertex;
    }
    if (x > maxX) {
      maxX = x;
      maxXVertex = vertex;
    }
    if (y < minY) {
      minY = y;
      minYVertex = vertex;
    }
    if (y > maxY) {
      maxY = y;
      maxYVertex = vertex;
    }
    if (z < minZ) {
      minZ = z;
      minZVertex = vertex;
    }
    if (z > maxZ) {
      maxZ = z;
      maxZVertex = vertex;
    }
  }
  const extremaVertices = new Set(
    [minXVertex, maxXVertex, minYVertex, maxYVertex, minZVertex, maxZVertex].filter(
      (vertex) => vertex >= 0,
    ),
  );
  for (let triangle = 0; triangle < sourceTriangles; triangle++) {
    const offset = triangle * 3;
    if (
      extremaVertices.has(sourceIndex.getX(offset)) ||
      extremaVertices.has(sourceIndex.getX(offset + 1)) ||
      extremaVertices.has(sourceIndex.getX(offset + 2))
    ) {
      extrema.add(triangle);
    }
  }
  for (const triangle of extrema) selectedFaces.add(triangle);

  const selectedIndices: number[] = [];
  for (const triangle of selectedFaces) {
    const offset = triangle * 3;
    selectedIndices.push(
      sourceIndex.getX(offset),
      sourceIndex.getX(offset + 1),
      sourceIndex.getX(offset + 2),
    );
  }
  if (selectedIndices.length < 3) return null;

  const remap = new Map<number, number>();
  const uniqueVertices: number[] = [];
  const compactIndices = new Uint32Array(selectedIndices.length);
  for (let i = 0; i < selectedIndices.length; i++) {
    const original = selectedIndices[i];
    let compact = remap.get(original);
    if (compact === undefined) {
      compact = uniqueVertices.length;
      remap.set(original, compact);
      uniqueVertices.push(original);
    }
    compactIndices[i] = compact;
  }

  const proxy = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    if (attribute.count !== position.count || !includeAttribute(name)) continue;
    const values = createAttributeArray(attribute, uniqueVertices.length * attribute.itemSize);
    for (let i = 0; i < uniqueVertices.length; i++) {
      const target = i * attribute.itemSize;
      for (let component = 0; component < attribute.itemSize; component++) {
        values[target + component] = attribute.getComponent(uniqueVertices[i], component);
      }
    }
    proxy.setAttribute(name, new BufferAttribute(values, attribute.itemSize, attribute.normalized));
  }
  proxy.setIndex(new BufferAttribute(compactIndices, 1));
  if (source.groups.length === 1) {
    proxy.addGroup(0, compactIndices.length, source.groups[0].materialIndex);
  }
  return proxy;
}

/**
 * Build a compact projection source with meshoptimizer's surface-aware
 * reduction. A regular stride sample is a safe last resort for malformed
 * assets, but it can leave large gaps in a scan and produce mostly-empty bake
 * atlases. The reduced proxy keeps a representative surface across the whole
 * model while remaining far below the full source memory footprint.
 */
async function buildLargeMeshTextureProxy(
  source: import('three').BufferGeometry,
  maximumTriangles: number,
): Promise<import('three').BufferGeometry | null> {
  // The projection proxy is texture truth, so every proxy triangle must be an
  // actual source triangle with its original UV triplet. Meshoptimizer's
  // permissive reduction creates new faces between surviving vertices; those
  // faces can cross unrelated UV islands and make one surface sample texture
  // patches from the opposite side. A dense, evenly distributed sample of
  // original faces is disconnected but ideal for nearest-surface BVH lookup.
  // This branch is used only for scan-sized meshes; ordinary assets continue
  // to project through their established complete-source path.
  return buildLargeMeshRepairProxy(
    source,
    maximumTriangles,
    (name) => name === 'position' || name.startsWith('uv'),
  );
}

function criticalPositionKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function repairEdgeKey(a: number, b: number): string {
  return `${a}|${b}`;
}

/** Closest point on a triangle, returned as barycentric weights. */
function closestPointOnRepairTriangle(
  px: number,
  py: number,
  pz: number,
  face: RepairFace,
): ClosestTrianglePoint {
  const abx = face.bx - face.ax;
  const aby = face.by - face.ay;
  const abz = face.bz - face.az;
  const acx = face.cx - face.ax;
  const acy = face.cy - face.ay;
  const acz = face.cz - face.az;
  const apx = px - face.ax;
  const apy = py - face.ay;
  const apz = pz - face.az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return repairPointResult(px, py, pz, face.ax, face.ay, face.az, 1, 0, 0);

  const bpx = px - face.bx;
  const bpy = py - face.by;
  const bpz = pz - face.bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return repairPointResult(px, py, pz, face.bx, face.by, face.bz, 0, 1, 0);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return repairPointResult(
      px,
      py,
      pz,
      face.ax + abx * v,
      face.ay + aby * v,
      face.az + abz * v,
      1 - v,
      v,
      0,
    );
  }

  const cpx = px - face.cx;
  const cpy = py - face.cy;
  const cpz = pz - face.cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return repairPointResult(px, py, pz, face.cx, face.cy, face.cz, 0, 0, 1);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return repairPointResult(
      px,
      py,
      pz,
      face.ax + acx * w,
      face.ay + acy * w,
      face.az + acz * w,
      1 - w,
      0,
      w,
    );
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edgeX = face.cx - face.bx;
    const edgeY = face.cy - face.by;
    const edgeZ = face.cz - face.bz;
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return repairPointResult(
      px,
      py,
      pz,
      face.bx + edgeX * w,
      face.by + edgeY * w,
      face.bz + edgeZ * w,
      0,
      1 - w,
      w,
    );
  }

  const denominator = 1 / (va + vb + vc);
  const wb = vb * denominator;
  const wc = vc * denominator;
  const wa = 1 - wb - wc;
  return repairPointResult(
    px,
    py,
    pz,
    face.ax * wa + face.bx * wb + face.cx * wc,
    face.ay * wa + face.by * wb + face.cy * wc,
    face.az * wa + face.bz * wb + face.cz * wc,
    wa,
    wb,
    wc,
  );
}

function repairPointResult(
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  wa: number,
  wb: number,
  wc: number,
): ClosestTrianglePoint {
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  return { distanceSquared: dx * dx + dy * dy + dz * dz, wa, wb, wc };
}

function orientedRepairEdge(
  face: RepairFace,
  edgeA: number,
  edgeB: number,
): [number, number, number] | null {
  const ids = [face.a, face.b, face.c];
  for (let corner = 0; corner < 3; corner++) {
    const start = ids[corner];
    const end = ids[(corner + 1) % 3];
    if ((start === edgeA && end === edgeB) || (start === edgeB && end === edgeA)) {
      return [start, end, ids[(corner + 2) % 3]];
    }
  }
  return null;
}

function repairFacePoint(face: RepairFace, vertex: number): [number, number, number] | null {
  if (vertex === face.a) return [face.ax, face.ay, face.az];
  if (vertex === face.b) return [face.bx, face.by, face.bz];
  if (vertex === face.c) return [face.cx, face.cy, face.cz];
  return null;
}

function splitRepairFaceAlongEdge(
  face: RepairFace,
  edgeA: number,
  edgeB: number,
  restoredVertex: number,
): number[] | null {
  const edge = orientedRepairEdge(face, edgeA, edgeB);
  if (!edge) return null;
  const [start, end, opposite] = edge;
  return [start, restoredVertex, opposite, restoredVertex, end, opposite];
}

function repairPointToLineDistance(
  point: number[],
  lineStart: number[],
  lineEnd: number[],
): number {
  const ex = lineEnd[0] - lineStart[0];
  const ey = lineEnd[1] - lineStart[1];
  const ez = lineEnd[2] - lineStart[2];
  const px = point[0] - lineStart[0];
  const py = point[1] - lineStart[1];
  const pz = point[2] - lineStart[2];
  const edgeLength = Math.hypot(ex, ey, ez);
  if (edgeLength <= 1e-12) return Number.POSITIVE_INFINITY;
  const cx = py * ez - pz * ey;
  const cy = pz * ex - px * ez;
  const cz = px * ey - py * ex;
  return Math.hypot(cx, cy, cz) / edgeLength;
}

function repairTriangleQuality(a: number[], b: number[], c: number[]): number {
  const abX = b[0] - a[0];
  const abY = b[1] - a[1];
  const abZ = b[2] - a[2];
  const acX = c[0] - a[0];
  const acY = c[1] - a[1];
  const acZ = c[2] - a[2];
  const bcX = c[0] - b[0];
  const bcY = c[1] - b[1];
  const bcZ = c[2] - b[2];
  const nx = abY * acZ - abZ * acY;
  const ny = abZ * acX - abX * acZ;
  const nz = abX * acY - abY * acX;
  const twiceArea = Math.hypot(nx, ny, nz);
  const squaredEdgeSum =
    abX * abX +
    abY * abY +
    abZ * abZ +
    acX * acX +
    acY * acY +
    acZ * acZ +
    bcX * bcX +
    bcY * bcY +
    bcZ * bcZ;
  return squaredEdgeSum > 1e-20 ? (2 * Math.sqrt(3) * twiceArea) / squaredEdgeSum : 0;
}

interface RepairAxisBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

interface RepairProjectionView {
  right: [number, number, number];
  up: [number, number, number];
}

interface RepairProjectionBounds {
  view: RepairProjectionView;
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
}

function normalizeRepairVector(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/** Oblique audit views approximating arbitrary free-orbit angles. */
function buildFreeRepairViews(): RepairProjectionView[] {
  const views: RepairProjectionView[] = [];
  for (const elevation of [-0.55, 0, 0.55]) {
    const cosElevation = Math.cos(elevation);
    const sinElevation = Math.sin(elevation);
    for (let step = 0; step < 8; step++) {
      const azimuth = (step * Math.PI) / 4;
      const direction = normalizeRepairVector(
        cosElevation * Math.sin(azimuth),
        sinElevation,
        cosElevation * Math.cos(azimuth),
      );
      // The world-up vector keeps free-orbit audit views upright. Near the
      // poles, fall back to the X axis to avoid a zero-length cross product.
      const upReference: [number, number, number] =
        Math.abs(direction[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
      const right = normalizeRepairVector(
        upReference[1] * direction[2] - upReference[2] * direction[1],
        upReference[2] * direction[0] - upReference[0] * direction[2],
        upReference[0] * direction[1] - upReference[1] * direction[0],
      );
      const up = normalizeRepairVector(
        direction[1] * right[2] - direction[2] * right[1],
        direction[2] * right[0] - direction[0] * right[2],
        direction[0] * right[1] - direction[1] * right[0],
      );
      views.push({ right, up });
    }
  }
  return views;
}

const FREE_REPAIR_VIEWS = buildFreeRepairViews();
const AXIS_REPAIR_VIEWS: RepairProjectionView[] = [
  { right: [0, 0, -1], up: [0, 1, 0] },
  { right: [1, 0, 0], up: [0, 0, -1] },
  { right: [1, 0, 0], up: [0, 1, 0] },
];

// The repair scorer compares every missing source point against every
// simplified face. That exhaustive pass is valuable on ordinary assets, but
// it becomes quadratic (and unbounded in browser memory) on scan-sized meshes
// such as million-triangle scans. Large meshes already get the
// topology-safe meshoptimizer reduction; skip only the expensive reinjection
// search and keep the generated LOD instead of taking the page down.
const MAX_EXHAUSTIVE_REPAIR_SOURCE_TRIANGLES = 250_000;
// The repair proxy feeds a curvature/silhouette scorer, not the exported
// surface. Roughly 24k evenly spread source faces retain far more detail than
// the deepest LOD while keeping its point map comfortably within browser
// memory. Reuse this one proxy across every requested level.
const MAX_LARGE_MESH_REPAIR_PROXY_TRIANGLES = 24_000;
const MAX_LARGE_MESH_TEXTURE_PROXY_TRIANGLES = 120_000;
const MAX_LARGE_MESH_TEXTURE_BAKE_TRIANGLES = 250_000;

// Selected-to-active baking builds a BVH over the full source mesh and then
// rasterizes every generated LOD. Keep that high-quality path for normal-sized
// assets, while allowing large meshes to use their seam-preserving source UVs
// without allocating several additional full-resolution copies in the viewer.
const MAX_BROWSER_TEXTURE_BAKE_SOURCE_TRIANGLES = 500_000;

function repairAxisBounds(position: {
  count: number;
  getX: (index: number) => number;
  getY: (index: number) => number;
  getZ: (index: number) => number;
}): RepairAxisBounds {
  const bounds: RepairAxisBounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (let vertex = 0; vertex < position.count; vertex++) {
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const z = position.getZ(vertex);
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxZ = Math.max(bounds.maxZ, z);
  }
  return bounds;
}

function repairProjectionBounds(
  position: {
    count: number;
    getX: (index: number) => number;
    getY: (index: number) => number;
    getZ: (index: number) => number;
  },
  views: RepairProjectionView[],
): RepairProjectionBounds[] {
  return views.map((view) => {
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let vertex = 0; vertex < position.count; vertex++) {
      const x = position.getX(vertex);
      const y = position.getY(vertex);
      const z = position.getZ(vertex);
      const u = x * view.right[0] + y * view.right[1] + z * view.right[2];
      const v = x * view.up[0] + y * view.up[1] + z * view.up[2];
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    return { view, minU, maxU, minV, maxV };
  });
}

function repairFreeSilhouetteScore(
  point: CriticalSourcePoint,
  projectionBounds: RepairProjectionBounds[],
  diagonal: number,
): number {
  let score = 0;
  for (const projection of projectionBounds) {
    const { view } = projection;
    const u = point.x * view.right[0] + point.y * view.right[1] + point.z * view.right[2];
    const v = point.x * view.up[0] + point.y * view.up[1] + point.z * view.up[2];
    const spanU = Math.max(diagonal * 1e-5, projection.maxU - projection.minU);
    const spanV = Math.max(diagonal * 1e-5, projection.maxV - projection.minV);
    const outsideU =
      u < projection.minU
        ? (projection.minU - u) / spanU
        : u > projection.maxU
          ? (u - projection.maxU) / spanU
          : 0;
    const outsideV =
      v < projection.minV
        ? (projection.minV - v) / spanV
        : v > projection.maxV
          ? (v - projection.maxV) / spanV
          : 0;
    score = Math.max(score, Math.hypot(outsideU, outsideV));
  }
  return score;
}

/**
 * Score how much a source point extends beyond the simplified projection in
 * each of the three snap views. A point outside the YZ, XZ, or XY envelope is
 * a likely missing silhouette anchor for the X, Y, or Z audit view.
 */
function repairAxisSilhouetteScore(
  point: CriticalSourcePoint,
  simplifiedBounds: RepairAxisBounds,
  diagonal: number,
): number {
  const outside = (value: number, min: number, max: number): number => {
    const span = Math.max(diagonal * 1e-5, max - min);
    return value < min ? (min - value) / span : value > max ? (value - max) / span : 0;
  };
  const x = outside(point.x, simplifiedBounds.minX, simplifiedBounds.maxX);
  const y = outside(point.y, simplifiedBounds.minY, simplifiedBounds.maxY);
  const z = outside(point.z, simplifiedBounds.minZ, simplifiedBounds.maxZ);
  return Math.max(Math.hypot(y, z), Math.hypot(x, z), Math.hypot(x, y));
}

function projectedRepairArea(
  view: RepairProjectionView,
  a: number[],
  b: number[],
  c: number[],
): number {
  const a0 = a[0] * view.right[0] + a[1] * view.right[1] + a[2] * view.right[2];
  const a1 = a[0] * view.up[0] + a[1] * view.up[1] + a[2] * view.up[2];
  const b0 = b[0] * view.right[0] + b[1] * view.right[1] + b[2] * view.right[2];
  const b1 = b[0] * view.up[0] + b[1] * view.up[1] + b[2] * view.up[2];
  const c0 = c[0] * view.right[0] + c[1] * view.right[1] + c[2] * view.right[2];
  const c1 = c[0] * view.up[0] + c[1] * view.up[1] + c[2] * view.up[2];
  return (b0 - a0) * (c1 - a1) - (b1 - a1) * (c0 - a0);
}

/** Reject child splits that explode the projected area in any snap view. */
function projectedRepairSplitIsSafe(
  face: RepairFace,
  px: number,
  py: number,
  pz: number,
  diagonal: number,
): boolean {
  const a = [face.ax, face.ay, face.az];
  const b = [face.bx, face.by, face.bz];
  const c = [face.cx, face.cy, face.cz];
  const p = [px, py, pz];
  const projectionEpsilon = diagonal * diagonal * 1e-8;
  // Keep the hard topology safety veto on the three canonical planes. Free
  // orbit samples influence candidate priority above, but should not reject
  // a valid anchor merely because its projection is edge-on at one oblique
  // sample angle.
  for (const view of AXIS_REPAIR_VIEWS) {
    const parentArea = projectedRepairArea(view, a, b, c);
    if (Math.abs(parentArea) <= projectionEpsilon) continue;
    const childAreas = [
      projectedRepairArea(view, a, b, p),
      projectedRepairArea(view, b, c, p),
      projectedRepairArea(view, c, a, p),
    ];
    const orientation = Math.sign(parentArea);
    const areaSum = childAreas.reduce((sum, area) => {
      if (Math.abs(area) > projectionEpsilon && Math.sign(area) !== orientation) return Infinity;
      return sum + Math.abs(area);
    }, 0);
    // A point that makes the projected child surface grow several times
    // larger than its parent is the classic paper-fin failure mode.
    if (areaSum > Math.abs(parentArea) * 2.5 + projectionEpsilon) return false;
  }
  return true;
}

function repairChildTriangleIsSafe(
  face: RepairFace,
  a: number[],
  b: number[],
  c: number[],
  diagonal: number,
  sourceNormalX: number,
  sourceNormalY: number,
  sourceNormalZ: number,
  minimumFaceNormalDot: number,
  minimumSourceNormalDot: number,
): boolean {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length <= diagonal * diagonal * 1e-10) return false;

  const parentQuality = repairTriangleQuality(
    [face.ax, face.ay, face.az],
    [face.bx, face.by, face.bz],
    [face.cx, face.cy, face.cz],
  );
  const minimumQuality = Math.min(0.1, Math.max(0.025, parentQuality * 0.25));
  if (repairTriangleQuality(a, b, c) < minimumQuality) return false;

  const faceNormalDot = (nx * face.nx + ny * face.ny + nz * face.nz) / length;
  if (faceNormalDot <= minimumFaceNormalDot) return false;

  const sourceNormalLength = Math.hypot(sourceNormalX, sourceNormalY, sourceNormalZ);
  if (sourceNormalLength > 1e-8) {
    const sourceNormalDot =
      (nx * sourceNormalX + ny * sourceNormalY + nz * sourceNormalZ) /
      (length * sourceNormalLength);
    if (sourceNormalDot <= minimumSourceNormalDot) return false;
  }
  return true;
}

function splitEdgePreservesFaceOrientation(
  face: RepairFace,
  edgeA: number,
  edgeB: number,
  px: number,
  py: number,
  pz: number,
  diagonal: number,
  sourceNormalX: number,
  sourceNormalY: number,
  sourceNormalZ: number,
): boolean {
  const edge = orientedRepairEdge(face, edgeA, edgeB);
  if (!edge) return false;
  const start = repairFacePoint(face, edge[0]);
  const end = repairFacePoint(face, edge[1]);
  const opposite = repairFacePoint(face, edge[2]);
  if (!start || !end || !opposite) return false;

  const restored = [px, py, pz];
  const edgeLength = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
  const localAltitude = repairPointToLineDistance(opposite, start, end);
  const restoredAltitude = repairPointToLineDistance(restored, start, end);
  // A source point much farther from the edge than either the edge length or
  // the adjacent face altitude creates the paper-thin fins seen at deep LODs.
  if (restoredAltitude > Math.max(edgeLength, localAltitude) * 1.2) return false;

  for (const [a, b, c] of [
    [start, restored, opposite],
    [restored, end, opposite],
  ] as [number[], number[], number[]][]) {
    if (
      !repairChildTriangleIsSafe(
        face,
        a,
        b,
        c,
        diagonal,
        sourceNormalX,
        sourceNormalY,
        sourceNormalZ,
        0.2,
        0.12,
      )
    ) {
      return false;
    }
  }
  return true;
}

function splitPreservesFaceOrientation(
  face: RepairFace,
  px: number,
  py: number,
  pz: number,
  diagonal: number,
  sourceNormalX: number,
  sourceNormalY: number,
  sourceNormalZ: number,
): boolean {
  if (!projectedRepairSplitIsSafe(face, px, py, pz, diagonal)) return false;
  for (const [ax, ay, az, bx, by, bz] of [
    [face.ax, face.ay, face.az, face.bx, face.by, face.bz],
    [face.bx, face.by, face.bz, face.cx, face.cy, face.cz],
    [face.cx, face.cy, face.cz, face.ax, face.ay, face.az],
  ]) {
    if (
      !repairChildTriangleIsSafe(
        face,
        [ax, ay, az],
        [bx, by, bz],
        [px, py, pz],
        diagonal,
        sourceNormalX,
        sourceNormalY,
        sourceNormalZ,
        0.05,
        0.03,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Apply the optimization pipeline to a GLB buffer.
 * Returns the optimized GLB and metadata describing what changed.
 */
export async function optimizeGltf(
  buf: ArrayBuffer | Uint8Array,
  options: ConvertOptions,
): Promise<OptimizeResult> {
  const opts = applyEnginePreset(options);
  const progress = makeProgress(opts);
  progress('parse', 0);
  const maxTris = Math.max(0, opts.maxTriangles ?? 0);
  const mergeByMaterial = !!opts.mergeByMaterial;
  const lodCount = Math.max(0, Math.min(8, opts.generateLODs ?? 0));
  const maxTex = Math.max(64, Math.min(8192, opts.maxTextureSize ?? 2048));

  // If the user hasn't enabled any optimization, just return the input
  // unchanged with its inspection. This is a no-op pass and is also
  // used to seed the stats in FbxResult.
  const hasAny =
    maxTris > 0 || mergeByMaterial || lodCount > 0 || (opts.maxTextureSize ?? 2048) < 8192;
  if (!hasAny) {
    progress('inspect', 0);
    const stats = await inspectGltf(buf);
    progress('parse', 1);
    progress('inspect', 1);
    return { data: buf instanceof Uint8Array ? buf : new Uint8Array(buf), stats, changes: [] };
  }

  const ab =
    buf instanceof Uint8Array
      ? (() => {
          const a = new ArrayBuffer(buf.byteLength);
          new Uint8Array(a).set(buf);
          return a;
        })()
      : buf;

  const gltf = await loadGltf(ab);
  progress('parse', 1);

  const changes: OptimizeChange[] = [];

  // 1. Texture resize
  progress('textures', 0);
  if (opts.maxTextureSize && opts.maxTextureSize < 8192) {
    const resizeChanges = resizeTextures(gltf.scene, maxTex);
    changes.push(...resizeChanges);
  }
  progress('textures', 1);

  // 2. Collect meshes (skip non-mesh, skip skinned for safety)
  const records: MeshRecord[] = [];
  gltf.scene.traverse((obj) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = obj as any;
    if (m.isMesh && !m.isSkinnedMesh && m.geometry) {
      const before = m.geometry.index
        ? m.geometry.index.count / 3
        : m.geometry.attributes.position.count / 3;
      // Keep the original geometry object as the high-detail source for
      // scan-sized meshes. LOD0 replacement assigns a new geometry to the
      // mesh, so the original object remains untouched; avoiding an eager
      // 1.6M-vertex clone prevents a second large allocation before the real
      // reduction even begins. Smaller assets retain the isolated clone used
      // by the texture baker and repair scorer.
      const sourceGeometry =
        before > MAX_BROWSER_TEXTURE_BAKE_SOURCE_TRIANGLES ? m.geometry : m.geometry.clone();
      records.push({ mesh: m, before: Math.round(before), sourceGeometry });
    }
  });
  progress('optimize', 0);

  // 3. Decimation — applied to LOD0 of every mesh above the cap.
  //    Strategy: meshoptimizer with position welding and non-manifold
  //    repair. If a geometry cannot be simplified safely, keep the denser
  //    result instead of dropping triangles.
  //
  //    The simplifier returns a new index buffer while retaining the
  //    original vertex attributes, which avoids the attribute drift that
  //    caused the previous edge-collapse path to tear UV-seamed assets.
  if (maxTris > 0) {
    for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
      const rec = records[recordIndex];
      const geo = rec.mesh.geometry;
      const triCount = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
      if (triCount <= maxTris) {
        progress('optimize', records.length ? ((recordIndex + 1) / records.length) * 0.35 : 0.35);
        continue;
      }
      let result: CriticalVertexRepairResult | null = null;
      try {
        result = await meshoptDecimate(geo, maxTris);
      } catch (e) {
        changes.push({
          kind: 'decimate',
          detail: `${rec.mesh.name || 'mesh'}: skipped (${(e as Error).message})`,
        });
        progress('optimize', records.length ? ((recordIndex + 1) / records.length) * 0.35 : 0.35);
        continue;
      }
      if (result) {
        rec.mesh.geometry = result.geometry;
        changes.push({
          kind: 'decimate',
          detail: `${rec.mesh.name || 'mesh'}: ${Math.round(triCount)} → ${result.triangleCount} tris${result.restoredVertices ? `, restored ${result.restoredVertices} critical vert${result.restoredVertices === 1 ? 'ex' : 'ices'}` : ''}`,
          trianglesBefore: Math.round(triCount),
          trianglesAfter: result.triangleCount,
        });
      } else {
        changes.push({
          kind: 'decimate',
          detail: `${rec.mesh.name || 'mesh'}: skipped (decimation returned null)`,
        });
      }
      progress('optimize', records.length ? ((recordIndex + 1) / records.length) * 0.35 : 0.35);
    }
  }

  // 4. LOD generation — clone the (now possibly decimated) mesh and
  //    add progressively simplified children.
  //
  //    The LODs are added as SIBLINGS of the source mesh, not as
  //    children. If they were children, the three.js visibility
  //    hierarchy would cascade — toggling LOD0.visible to false would
  //    also hide LOD1/LOD2/LOD3 even when their own .visible is true,
  //    and the user would see an empty viewer. As siblings with the
  //    same local transform they share the source mesh's world
  //    position, but visibility is independent per LOD level.
  if (lodCount > 0) {
    for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
      const rec = records[recordIndex];
      const geo = rec.mesh.geometry;
      const triCount = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
      const sourceTriCount = rec.sourceGeometry.index
        ? rec.sourceGeometry.index.count / 3
        : rec.sourceGeometry.attributes.position.count / 3;
      let textureBaker: import('./lod-texture-baker.js').LodTextureBaker | null = null;
      let textureProjectionSource: import('three').BufferGeometry | null = null;
      const isBrowser = typeof __IS_BROWSER__ !== 'undefined' && __IS_BROWSER__;
      const canBakeBrowserTextures = sourceTriCount <= MAX_BROWSER_TEXTURE_BAKE_SOURCE_TRIANGLES;
      const hasExplicitSmallLodTarget = (opts.lodTriangleTargets ?? []).some(
        (target) =>
          Number.isFinite(target) && target > 0 && target <= MAX_LARGE_MESH_TEXTURE_BAKE_TRIANGLES,
      );
      const shouldBakeLargeTextures =
        isBrowser && !canBakeBrowserTextures && (lodCount >= 4 || hasExplicitSmallLodTarget);
      // Keep ordinary assets on their established baker path. Scan-sized
      // sources defer BVH construction until after simplification so its
      // transient buffers do not overlap meshoptimizer's full-source buffers.
      if (isBrowser && canBakeBrowserTextures) {
        try {
          const { createLodTextureBaker } = await import('./lod-texture-baker.js');
          textureBaker = await createLodTextureBaker(rec.sourceGeometry, rec.mesh.material, maxTex);
        } catch {
          // UV generation or pixel readback may be unavailable. The existing
          // seam-preserving UV path remains a safe fallback.
        }
      }
      let previousTriangles = Math.round(triCount);
      // Valid glTF meshes may omit NORMAL and rely on renderer-generated face
      // normals. Generate smooth normals on a private high-detail clone before
      // simplifying so surviving vertices retain stable projection directions
      // for each generated LOD texture bake. Reconstructing normals after
      // aggressive reduction can point cage rays through the opposite side of
      // thin, curved assets such as bottles.
      const lodSource =
        geo.attributes.normal?.count === geo.attributes.position?.count || !textureBaker
          ? geo
          : geo.clone();
      const ownsLodSource = lodSource !== geo;
      if (ownsLodSource) lodSource.computeVertexNormals();
      let generatedLods: GeneratedLodGeometry[];
      try {
        generatedLods = await generateLodGeometries(
          lodSource,
          lodCount,
          opts.lodTriangleTargets,
          (pct) => {
            const base = 0.35 + (recordIndex / Math.max(1, records.length)) * 0.55;
            const span = 0.55 / Math.max(1, records.length);
            progress('optimize', base + span * pct);
          },
        );
      } catch (error) {
        textureBaker?.dispose?.();
        if (ownsLodSource) lodSource.dispose();
        throw error;
      }
      if (ownsLodSource) lodSource.dispose();

      if (shouldBakeLargeTextures) {
        await yieldToMainThread();
        try {
          const { createLodTextureBaker } = await import('./lod-texture-baker.js');
          textureBaker = await createLodTextureBaker(
            rec.sourceGeometry,
            rec.mesh.material,
            maxTex,
            {
              directProjectionSource: true,
              highDetailAtlases: true,
              paddingOnly: true,
            },
          );
        } catch {
          // An exact BVH is the quality-first path. A browser with an unusually
          // tight allocation limit can still fall back to a dense sample of
          // intact source faces; unlike a simplified proxy, it never invents
          // triangles between unrelated UV islands.
        }
        if (!textureBaker) {
          textureProjectionSource = await buildLargeMeshTextureProxy(
            rec.sourceGeometry,
            MAX_LARGE_MESH_TEXTURE_PROXY_TRIANGLES,
          );
          if (textureProjectionSource) {
            try {
              const { createLodTextureBaker } = await import('./lod-texture-baker.js');
              textureBaker = await createLodTextureBaker(
                textureProjectionSource,
                rec.mesh.material,
                maxTex,
                {
                  highDetailAtlases: true,
                  paddingOnly: true,
                },
              );
            } catch {
              // Keep the seam-preserving UV geometry if projection setup is
              // unavailable even with the bounded intact-face fallback.
            }
          }
        }
        if (!textureBaker) {
          textureProjectionSource?.dispose();
          textureProjectionSource = null;
        }
      }

      // Baking allocates a fresh atlas/material per level. Always release the
      // retained source BVH and proxy geometry, including when a browser
      // texture readback or an exporter-facing operation throws midway
      // through the level loop. A failed preview must not poison the next
      // ordinary-asset run with the previous run's native buffers still live.
      try {
        for (const result of generatedLods) {
          let lodGeometry = result.geometry;
          let lodMaterial = rec.mesh.material;
          // Rebuild the UV layout and reproject the source textures for every
          // generated LOD. Even the relatively dense LOD1/LOD2 can contain
          // collapsed edges that span a UV seam; retaining the original atlas
          // then stretches one island across the new triangle (the visible
          // streaks/patches users see on broad surfaces). A fresh atlas keeps
          // each LOD's UVs one-to-one with its simplified topology, while the
          // selected-to-active bake preserves the original texture detail.
          const shouldBakeTexture =
            textureBaker &&
            !result.safePlateau &&
            (canBakeBrowserTextures ||
              result.triangleCount <= MAX_LARGE_MESH_TEXTURE_BAKE_TRIANGLES);
          if (shouldBakeTexture && textureBaker) {
            let baked: Awaited<ReturnType<typeof textureBaker.bake>> = null;
            try {
              baked = await textureBaker.bake(
                result.geometry,
                result.level,
                result.triangleCount,
                Math.round(sourceTriCount),
              );
            } catch {
              // Keep the seam-preserving UV geometry if a browser-specific
              // atlas or pixel-readback operation cannot complete for a level.
            }
            if (baked) {
              result.geometry.dispose();
              lodGeometry = baked.geometry;
              lodMaterial = baked.material;
              changes.push({
                kind: 'texture-bake',
                detail: `${rec.mesh.name || 'mesh'}: LOD${result.level} reprojected ${baked.textureCount} texture${baked.textureCount === 1 ? '' : 's'} to a ${baked.resolution}px atlas`,
                sizeAfter: baked.resolution,
              });
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lodMesh = new (rec.mesh.constructor as any)();
          lodMesh.geometry = lodGeometry;
          lodMesh.material = lodMaterial;
          lodMesh.name = `${rec.mesh.name || 'mesh'}_LOD${result.level}`;
          lodMesh.position.copy(rec.mesh.position);
          lodMesh.rotation.copy(rec.mesh.rotation);
          lodMesh.scale.copy(rec.mesh.scale);
          const parent = rec.mesh.parent;
          if (parent) {
            parent.add(lodMesh);
          } else {
            rec.mesh.add(lodMesh);
          }
          changes.push({
            kind: 'lod',
            detail: `${rec.mesh.name || 'mesh'}: LOD${result.level} = ${result.triangleCount} tris${result.restoredVertices ? `, restored ${result.restoredVertices} critical vert${result.restoredVertices === 1 ? 'ex' : 'ices'}` : ''}${result.safePlateau ? ' (safe plateau)' : ''}`,
            trianglesBefore: previousTriangles,
            trianglesAfter: result.triangleCount,
          });
          previousTriangles = result.triangleCount;
        }
      } finally {
        textureBaker?.dispose?.();
        textureProjectionSource?.dispose();
        // `BufferGeometry.dispose()` releases renderer state, while the baker
        // closure still owns its BVH and CPU typed arrays. Drop both strong
        // references before GLTFExporter performs its largest allocation.
        textureBaker = null;
        textureProjectionSource = null;
      }
      progress('optimize', 0.35 + ((recordIndex + 1) / Math.max(1, records.length)) * 0.55);
    }
  }

  // 5. Merge by material — collect meshes sharing the same material
  //    (under the same parent) and merge them.
  if (mergeByMaterial) {
    const byMaterial = new Map<unknown, import('three').Mesh[]>();
    gltf.scene.traverse((obj) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = obj as any;
      if (m.isMesh && m.parent) {
        const key = m.material;
        if (!byMaterial.has(key)) byMaterial.set(key, []);
        byMaterial.get(key)!.push(m);
      }
    });
    for (const [material, meshes] of byMaterial) {
      if (meshes.length < 2) continue;
      // Only merge meshes that share the same parent (so the
      // hierarchy doesn't get reorganized under the merge root).
      const parentGroups = new Map<unknown, import('three').Mesh[]>();
      for (const m of meshes) {
        if (!parentGroups.has(m.parent)) parentGroups.set(m.parent, []);
        parentGroups.get(m.parent)!.push(m);
      }
      for (const [parent, group] of parentGroups) {
        if (group.length < 2) continue;
        // Compute world matrices so the merged geometry keeps its
        // visual position.
        gltf.scene.updateMatrixWorld(true);
        const worldGeos = group.map((m) => {
          const g = m.geometry.clone();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (g as any).applyMatrix4(m.matrixWorld);
          return g;
        });
        let merged: import('three').BufferGeometry | null = null;
        try {
          merged = BufferGeometryUtils.mergeGeometries(worldGeos, false);
        } catch {
          merged = null;
        }
        if (!merged) {
          // Incompatible attribute sets — skip silently.
          for (const g of worldGeos) g.dispose();
          continue;
        }
        // Move the merged geometry from world space into the parent's
        // local space, so it sits where the originals did.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const invParentMatrix = (parent as any).matrixWorld.clone().invert();
        merged.applyMatrix4(invParentMatrix);
        // Build a replacement mesh using the same class as the source.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const MeshCtor = group[0].constructor as any;
        const mergedMesh = new MeshCtor(merged, material);
        mergedMesh.name = `${group[0].name || 'merged'}_merged`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (parent as any).add(mergedMesh);
        // Remove originals
        for (const m of group) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (m.parent as any)?.remove(m);
        }
        const totalBefore = group.reduce(
          (sum, m) =>
            sum +
            (m.geometry.index
              ? m.geometry.index.count / 3
              : m.geometry.attributes.position.count / 3),
          0,
        );
        const totalAfter = merged.index
          ? merged.index.count / 3
          : merged.attributes.position.count / 3;
        for (const g of worldGeos) g.dispose();
        changes.push({
          kind: 'merge',
          detail: `${mergedMesh.name}: ${group.length} meshes → 1 (${Math.round(totalBefore)} → ${Math.round(totalAfter)} tris)`,
          trianglesBefore: Math.round(totalBefore),
          trianglesAfter: Math.round(totalAfter),
        });
      }
    }
  }
  progress('optimize', 1);

  // The optimized scene is already in memory. Inspect it directly before
  // export; parsing a 55+ MB exported GLB again creates another full
  // geometry/texture graph at the exact peak of the operation.
  progress('inspect', 0);
  const postStats = inspectScene(gltf.scene, gltf.animations);
  progress('inspect', 1);

  // Export back to glb
  progress('export', 0);
  let optimized: Uint8Array;
  try {
    optimized = await exportGltf(gltf);
  } catch (e) {
    disposeOptimizationScene(
      gltf.scene,
      records.map((record) => record.sourceGeometry),
    );
    throw new Error(`export failed: ${(e as Error).message}`);
  }
  // GLTFExporter has copied the scene into the output buffer. Release the
  // parsed source, LOD clones, decoded images, and repair-source clones before
  // the preview loader allocates the output scene. Without this handoff, each
  // repeated preview kept another complete set of GPU/JS buffers
  // alive until the browser decided to collect them, which could take the
  // tab down before the next optimization finished.
  disposeOptimizationScene(
    gltf.scene,
    records.map((record) => record.sourceGeometry),
  );
  progress('export', 1);
  return { data: optimized, stats: postStats, changes };
}

// --- helpers ---

const OPTIMIZATION_TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'bumpMap',
  'displacementMap',
  'alphaMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularIntensityMap',
  'specularColorMap',
  'transmissionMap',
  'thicknessMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
] as const;

/** Release all transient resources allocated by one optimization pass. */
function disposeOptimizationScene(
  scene: import('three').Object3D,
  extraGeometries: import('three').BufferGeometry[] = [],
): void {
  const geometries = new Set<import('three').BufferGeometry>();
  const materials = new Set<import('three').Material>();
  const textures = new Set<import('three').Texture>();
  for (const geometry of extraGeometries) geometries.add(geometry);
  scene.traverse((obj) => {
    const mesh = obj as import('three').Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (!mesh.material) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      materials.add(material);
      const record = material as unknown as Record<string, unknown>;
      for (const slot of OPTIMIZATION_TEXTURE_SLOTS) {
        const texture = record[slot];
        if (texture && typeof texture === 'object' && 'dispose' in texture) {
          textures.add(texture as import('three').Texture);
        }
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}

function loadGltf(
  buf: ArrayBuffer,
): Promise<{ scene: import('three').Group; animations: import('three').AnimationClip[] }> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      buf,
      '',
      (g) => resolve({ scene: g.scene, animations: g.animations }),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

function exportGltf(gltf: { scene: import('three').Object3D }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      gltf.scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(new Uint8Array(result));
        } else {
          // JSON gltf — convert to glb
          const json = JSON.stringify(result);
          const enc = new TextEncoder().encode(json);
          // Pad JSON to 4-byte alignment with spaces (per glTF 2.0 spec).
          const pad = (4 - (enc.byteLength % 4)) % 4;
          const padded = new Uint8Array(enc.byteLength + pad);
          padded.set(enc);
          for (let i = 0; i < pad; i++) padded[enc.byteLength + i] = 0x20;
          // Build a minimal glb
          const jsonChunk = makeGlbChunk(0x4e4f534a, padded); // 'JSON'
          const header = new Uint8Array(12);
          new DataView(header.buffer).setUint32(0, 0x46546c67, true); // 'glTF'
          new DataView(header.buffer).setUint32(4, 2, true); // version
          new DataView(header.buffer).setUint32(8, 12 + jsonChunk.byteLength, true);
          const out = new Uint8Array(header.byteLength + jsonChunk.byteLength);
          out.set(header, 0);
          out.set(jsonChunk, header.byteLength);
          resolve(out);
        }
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true },
    );
  });
}

function makeGlbChunk(type: number, data: Uint8Array): Uint8Array {
  const len = data.byteLength;
  const padded = new Uint8Array((len + 3) & ~3);
  padded.set(data);
  const out = new Uint8Array(8 + padded.byteLength);
  new DataView(out.buffer).setUint32(0, len, true);
  new DataView(out.buffer).setUint32(4, type, true);
  out.set(padded, 8);
  return out;
}

/**
 * Resize textures in the scene whose longest edge exceeds `maxSize`.
 * Returns the list of resizes performed.
 *
 * Browser: uses an HTMLCanvasElement to downsample.
 * Node: skips (no real Image decoder; the assimp path can do it
 *       natively via maxTextureSize when exporting to FBX).
 */
function resizeTextures(scene: import('three').Object3D, maxSize: number): OptimizeChange[] {
  const changes: OptimizeChange[] = [];
  const isBrowser = typeof __IS_BROWSER__ !== 'undefined' && __IS_BROWSER__;
  if (!isBrowser) {
    // Mark textures with userData so the assimp FBX exporter honors
    // the size cap. Actually assimp reads maxTextureSize from options
    // directly, so we don't need to mark anything in the scene.
    return changes;
  }
  scene.traverse((obj) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = obj as any;
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = mat as any;
      const texProps = [
        'map',
        'normalMap',
        'roughnessMap',
        'metalnessMap',
        'aoMap',
        'emissiveMap',
        'bumpMap',
        'displacementMap',
        'alphaMap',
        'clearcoatMap',
        'clearcoatNormalMap',
        'clearcoatRoughnessMap',
        'sheenColorMap',
        'sheenRoughnessMap',
        'specularIntensityMap',
        'specularColorMap',
        'transmissionMap',
        'thicknessMap',
        'iridescenceMap',
        'iridescenceThicknessMap',
      ];
      for (const k of texProps) {
        const tex = m[k];
        if (!tex?.image) continue;
        const img = tex.image;
        const w = img.width || 0;
        const h = img.height || 0;
        if (!w || !h) continue;
        const longest = Math.max(w, h);
        if (longest <= maxSize) continue;
        const ratio = maxSize / longest;
        const newW = Math.max(1, Math.round(w * ratio));
        const newH = Math.max(1, Math.round(h * ratio));
        try {
          const canvas = document.createElement('canvas');
          canvas.width = newW;
          canvas.height = newH;
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, newW, newH);
          tex.image = canvas;
          tex.needsUpdate = true;
          // Also drop the (now stale) mipmaps so three.js regenerates them
          // at the new resolution.
          if (tex.mipmaps) tex.mipmaps.length = 0;
          changes.push({
            kind: 'texture-resize',
            detail: `${m.name || k}: ${w}×${h} → ${newW}×${newH}`,
            sizeBefore: longest,
            sizeAfter: maxSize,
          });
        } catch {
          // CORS or tainted canvas — skip.
        }
      }
    }
  });
  return changes;
}

/**
 * Vertex-clustering decimation. Quantizes each vertex's position to
 * a 3D grid and merges vertices that fall into the same cell, then
 * drops triangles that became degenerate. Produces predictable
 * results on every mesh (unlike three.js's SimplifyModifier, which
 * fails on many real-world topologies with a "Cannot set properties
 * of undefined (setting 'NaN')" error).
 *
 * Returns the new geometry and the resulting triangle count, or
 * null if the input is unsuitable (no position attribute, no indices).
 */
/** @deprecated Legacy diagnostic helper; production optimization uses topology-safe edge collapses. */
export function vertexClusteringDecimate(
  src: import('three').BufferGeometry,
  targetTris: number,
): CriticalVertexRepairResult | null {
  // Only handle indexed geometries with position for now — that's
  // what we get from glTF.
  if (!src.index || !src.attributes.position) return null;
  const idxArr = src.index.array;
  const posArr = src.attributes.position.array as Float32Array;
  const normalArr = src.attributes.normal?.array as Float32Array | undefined;
  const uvArr = src.attributes.uv?.array as Float32Array | undefined;
  const vCount = src.attributes.position.count;
  const tCount = idxArr.length / 3;
  if (tCount <= targetTris) {
    return { geometry: src.clone(), triangleCount: tCount, restoredVertices: 0 };
  }

  // --- Step 1: compute bounding box ---
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < vCount; i++) {
    const x = posArr[i * 3],
      y = posArr[i * 3 + 1],
      z = posArr[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const sizeX = maxX - minX,
    sizeY = maxY - minY,
    sizeZ = maxZ - minZ;
  const diag = Math.sqrt(sizeX * sizeX + sizeY * sizeY + sizeZ * sizeZ);
  if (diag === 0) {
    return { geometry: src.clone(), triangleCount: tCount, restoredVertices: 0 };
  }

  // --- Step 2: binary search the cell size that hits `targetTris`. ---
  // The relationship is monotonic: bigger cell → fewer triangles.
  // We start with an upper bound (whole bbox) and search downward.
  //
  // Two-pass merging:
  //   1. Group vertices by quantized position cell.
  //   2. Within each cell, only merge vertices whose UVs are within
  //      `uvTolerance` of the representative. This preserves UV
  //      seams (cube corners, sharp texture edges) while still
  //      merging smooth-surface vertices that share UVs.
  //
  // UV tolerance is set to 5% of the UV range — that's 100 px on a
  // 2048 texture, 50 px on a 1024, etc. Small enough that the seam
  // stays invisible, large enough to allow meaningful decimation on
  // meshes whose UVs vary continuously (sphere, organic shapes).
  function tryCellSize(cell: number): { remap: Int32Array; newVerts: number; keptTris: number } {
    const uvTolerance = 0.05;
    const normTolerance = 0.05;

    // Pass 1: group by position cell.
    const cellMap = new Map<string, number[]>();
    for (let i = 0; i < vCount; i++) {
      const x = posArr[i * 3],
        y = posArr[i * 3 + 1],
        z = posArr[i * 3 + 2];
      const k = `${Math.floor((x - minX) / cell)}|${Math.floor((y - minY) / cell)}|${Math.floor((z - minZ) / cell)}`;
      let arr = cellMap.get(k);
      if (!arr) {
        arr = [];
        cellMap.set(k, arr);
      }
      arr.push(i);
    }

    // Pass 2: within each cell, greedily merge into a representative
    // if attributes are similar enough. The representative is the
    // first vertex in the cell.
    const remap = new Int32Array(vCount);
    // For each cell we track the [repIndex, ...] and the rep's
    // attributes, so subsequent vertices can compare.
    const cellRepresentatives = new Map<
      string,
      { rep: number; repU: number; repV: number; repNX: number; repNY: number; repNZ: number }
    >();
    let nextNewIdx = 0;
    for (const [cellKey, indices] of cellMap) {
      for (const i of indices) {
        const rep = cellRepresentatives.get(cellKey);
        if (!rep) {
          // First vertex in this cell — becomes the representative.
          const u = uvArr ? uvArr[i * 2] : 0;
          const v = uvArr ? uvArr[i * 2 + 1] : 0;
          const nx = normalArr ? normalArr[i * 3] : 0;
          const ny = normalArr ? normalArr[i * 3 + 1] : 0;
          const nz = normalArr ? normalArr[i * 3 + 2] : 0;
          cellRepresentatives.set(cellKey, {
            rep: nextNewIdx,
            repU: u,
            repV: v,
            repNX: nx,
            repNY: ny,
            repNZ: nz,
          });
          remap[i] = nextNewIdx;
          nextNewIdx++;
          continue;
        }
        // Compare to representative.
        const u = uvArr ? uvArr[i * 2] : 0;
        const v = uvArr ? uvArr[i * 2 + 1] : 0;
        const nx = normalArr ? normalArr[i * 3] : 0;
        const ny = normalArr ? normalArr[i * 3 + 1] : 0;
        const nz = normalArr ? normalArr[i * 3 + 2] : 0;
        const dU = Math.abs(u - rep.repU);
        const dV = Math.abs(v - rep.repV);
        const dN = Math.sqrt((nx - rep.repNX) ** 2 + (ny - rep.repNY) ** 2 + (nz - rep.repNZ) ** 2);
        if (uvArr && (dU > uvTolerance || dV > uvTolerance)) {
          // UVs are too different — make this a new representative
          // (still in the same cell, so no double-position issue, but
          // a separate UV island).
          cellRepresentatives.set(cellKey, {
            rep: nextNewIdx,
            repU: u,
            repV: v,
            repNX: nx,
            repNY: ny,
            repNZ: nz,
          });
          remap[i] = nextNewIdx;
          nextNewIdx++;
        } else if (normalArr && dN > normTolerance) {
          // Normals differ too much — separate vertex.
          cellRepresentatives.set(cellKey, {
            rep: nextNewIdx,
            repU: u,
            repV: v,
            repNX: nx,
            repNY: ny,
            repNZ: nz,
          });
          remap[i] = nextNewIdx;
          nextNewIdx++;
        } else {
          // Close enough — merge into the representative.
          remap[i] = rep.rep;
        }
      }
    }
    const newVerts = nextNewIdx;
    let keptTris = 0;
    for (let i = 0; i < tCount; i++) {
      const a = remap[idxArr[i * 3]];
      const b = remap[idxArr[i * 3 + 1]];
      const c = remap[idxArr[i * 3 + 2]];
      if (a === b || b === c || a === c) continue;
      keptTris++;
    }
    return { remap, newVerts, keptTris };
  }

  // Find a cell size that gets us close to target. We accept anything
  // between 50% and 100% of target (over-decimation is uglier than
  // slight under-decimation).
  let lo = diag / 1e4; // very fine → no merging
  let hi = diag; // very coarse → everything merges to one cell
  let best: { remap: Int32Array; newVerts: number; keptTris: number; cell: number } | null = null;
  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2;
    const r = tryCellSize(mid);
    if (r.keptTris <= targetTris) {
      best = { ...r, cell: mid };
      hi = mid;
    } else {
      lo = mid;
    }
    if (Math.abs(lo - hi) < diag * 1e-5) break;
  }
  // If even the coarsest cell didn't get us under target, the mesh is
  // pathologically sparse — fall back to the coarsest result.
  if (!best) {
    const r = tryCellSize(hi);
    best = { ...r, cell: hi };
  }

  // --- Step 3: build the new vertex array using the best cell size ---
  // For each grid cell, keep the FIRST vertex's attributes (position,
  // normal, uv). Subsequent vertices in the same cell are mapped to
  // the kept vertex.
  const remap = best.remap;
  const newVerts = best.newVerts;
  const newPositions = new Array<number>(newVerts * 3);
  const newNormals = normalArr ? new Array<number>(newVerts * 3) : null;
  const newUvs = uvArr ? new Array<number>(newVerts * 2) : null;
  // Walk the original vertex array in order; the first time we see a
  // grid cell, record its attributes under the cell's new index.
  const seen = new Uint8Array(newVerts);
  for (let i = 0; i < vCount; i++) {
    const newIdx = remap[i];
    if (seen[newIdx]) continue;
    seen[newIdx] = 1;
    newPositions[newIdx * 3] = posArr[i * 3];
    newPositions[newIdx * 3 + 1] = posArr[i * 3 + 1];
    newPositions[newIdx * 3 + 2] = posArr[i * 3 + 2];
    if (newNormals) {
      newNormals[newIdx * 3] = normalArr![i * 3];
      newNormals[newIdx * 3 + 1] = normalArr![i * 3 + 1];
      newNormals[newIdx * 3 + 2] = normalArr![i * 3 + 2];
    }
    if (newUvs) {
      newUvs[newIdx * 2] = uvArr![i * 2];
      newUvs[newIdx * 2 + 1] = uvArr![i * 2 + 1];
    }
  }

  // --- Step 4: rewrite the index buffer, drop degenerate triangles ---
  const finalIdx: number[] = [];
  for (let i = 0; i < tCount; i++) {
    const a = remap[idxArr[i * 3]];
    const b = remap[idxArr[i * 3 + 1]];
    const c = remap[idxArr[i * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    finalIdx.push(a, b, c);
  }
  if (finalIdx.length === 0) return null;
  const keptTris = finalIdx.length / 3;

  // --- Step 5: assemble the new BufferGeometry. ---
  // We construct a fresh BufferGeometry with explicit BufferAttribute
  // instances. The cloned source might carry InterleavedBufferAttribute
  // (which has `data`, not `array`) and that breaks GLTFExporter.
  const newGeo = new BufferGeometry();
  newGeo.setAttribute('position', new BufferAttribute(new Float32Array(newPositions), 3));
  if (newNormals) {
    newGeo.setAttribute('normal', new BufferAttribute(new Float32Array(newNormals), 3));
  }
  if (newUvs) {
    newGeo.setAttribute('uv', new BufferAttribute(new Float32Array(newUvs), 2));
  }
  newGeo.setIndex(new BufferAttribute(new Uint32Array(finalIdx), 1));
  return finishDecimation(src, { geometry: newGeo, triangleCount: keptTris }, targetTris);
}

/**
 * Simplify a geometry with meshoptimizer's progressive simplifier.
 *
 * glTF exporters commonly split vertices at UV seams. Those duplicated
 * positions look like topological borders to a simplifier and can make a
 * closed asset plateau early. We build a temporary position-only index for
 * the reduction pass, welding exact duplicate positions, then map the result
 * back to representative original vertices. Textured meshes take a separate
 * UV-safe indexed path that preserves the original seam relationships.
 */
export async function meshoptDecimate(
  src: import('three').BufferGeometry,
  targetTris: number,
  largeMeshRepairProxy?: import('three').BufferGeometry,
): Promise<CriticalVertexRepairResult | null> {
  const simplified = await meshoptDecimateRaw(src, targetTris);
  if (!simplified) return null;
  const sourceTriangles = src.index
    ? Math.floor(src.index.count / 3)
    : Math.floor(src.attributes.position.count / 3);
  if (sourceTriangles > MAX_EXHAUSTIVE_REPAIR_SOURCE_TRIANGLES) {
    // Give V8 a collection point after meshoptimizer releases its full-source
    // index/position work buffers and before feature repair allocates maps.
    await yieldToMainThread();
  }
  return finishDecimation(src, simplified, targetTris, largeMeshRepairProxy);
}

/**
 * Raw meshoptimizer reduction. Keep feature restoration in the public wrapper
 * so every attribute-aware, UV-safe, or position-welded branch is repaired
 * consistently without duplicating policy inside the individual strategies.
 */
async function meshoptDecimateRaw(
  src: import('three').BufferGeometry,
  targetTris: number,
): Promise<{ geometry: import('three').BufferGeometry; triangleCount: number } | null> {
  const position = src.attributes.position;
  if (!position || src.groups.length > 1) return null;

  const sourceIndices = src.index
    ? Uint32Array.from(src.index.array as ArrayLike<number>)
    : Uint32Array.from({ length: position.count }, (_, i) => i);
  const sourceTriangles = Math.floor(sourceIndices.length / 3);
  const target = Math.max(4, Math.floor(targetTris));
  if (sourceTriangles <= target) {
    return { geometry: src.clone(), triangleCount: sourceTriangles };
  }

  // A textured mesh must keep its UV-island seams. Reducing across those
  // seams makes the triangles watertight, but assigns unrelated atlas regions
  // to the same face. Meshoptimizer can preserve the original indexed UV
  // layout; when that path reaches its safe limit, the LOD generator reports
  // a plateau instead of producing a visibly corrupted texture.
  if (src.index && src.attributes.uv) {
    const largeMesh = sourceTriangles > MAX_EXHAUSTIVE_REPAIR_SOURCE_TRIANGLES;
    const allowDeepPermissive =
      largeMesh && target <= Math.max(DEFAULT_DEEPEST_LOD_TRIANGLE_CAP, sourceTriangles * 0.12);
    let largeMeshFallback: {
      geometry: import('three').BufferGeometry;
      triangleCount: number;
    } | null = null;
    const releaseLargeMeshFallback = (): void => {
      largeMeshFallback?.geometry.dispose();
      largeMeshFallback = null;
    };
    const retainLargeMeshFallback = (candidate: {
      geometry: import('three').BufferGeometry;
      triangleCount: number;
    }): void => {
      if (!largeMeshFallback || candidate.triangleCount < largeMeshFallback.triangleCount) {
        largeMeshFallback?.geometry.dispose();
        largeMeshFallback = candidate;
      } else {
        candidate.geometry.dispose();
      }
    };
    // On scan-sized meshes, prefer meshoptimizer's position-only index
    // simplifier. The attribute-update variant is fast and excellent for
    // ordinary assets, but its permissive updates can fold broad triangles
    // through the surface when removing hundreds of thousands of faces. The
    // index-only path keeps every surviving source vertex/UV pair intact and
    // is the safer geometry-first choice at this scale.
    if (largeMesh) {
      // Explicit low-poly targets already require relaxing the scan's enormous
      // number of UV borders. Run that single bounded pass first. Previously
      // we built and retained a ~942k-triangle LockBorder fallback before the
      // permissive pass, briefly duplicating most of the scan in memory even
      // though the fallback was immediately discarded.
      if (allowDeepPermissive) {
        const permissive = await decimateIndexedUvMesh(src, sourceIndices, target, ['Permissive']);
        if (permissive && permissive.triangleCount < sourceTriangles) {
          return permissive;
        }
        if (permissive) retainLargeMeshFallback(permissive);
      }

      const uvSafe = await decimateIndexedUvMesh(src, sourceIndices, target, ['LockBorder']);
      if (uvSafe && uvSafe.triangleCount <= target) return uvSafe;
      if (uvSafe) retainLargeMeshFallback(uvSafe);

      // Once a large mesh is in the deep-target regime, trying the attribute
      // and second UV strategies as well only creates more full-size working
      // buffers. Return the border-safe result if the bounded permissive pass
      // was unavailable.
      if (allowDeepPermissive) {
        if (largeMeshFallback) return largeMeshFallback;
      }
    }
    const attributeAware = await decimateWithAttributes(src, sourceIndices, target);
    if (attributeAware && (!allowDeepPermissive || attributeAware.triangleCount <= target)) {
      releaseLargeMeshFallback();
      return attributeAware;
    }
    if (attributeAware) retainLargeMeshFallback(attributeAware);
    const uvSafe = await decimateIndexedUvMesh(src, sourceIndices, target);
    if (uvSafe && (!allowDeepPermissive || uvSafe.triangleCount <= target)) {
      releaseLargeMeshFallback();
      return uvSafe;
    }
    if (uvSafe) retainLargeMeshFallback(uvSafe);

    // LockBorder is the right default for preserving ordinary UV islands, but
    // on scan meshes it can freeze almost every seam and leave LOD4 at
    // hundreds of thousands of triangles. Only the deepest automatic-sized
    // reduction is allowed to relax those locks. The resulting triangles
    // still reference original position/UV pairs (no attribute synthesis),
    // and the non-manifold repair below keeps exceptional edges renderable.
    if (largeMeshFallback) return largeMeshFallback;
  }

  // Weld exact duplicate positions for the simplifier only. Keep one
  // original vertex per welded position so all original attributes remain
  // valid when the simplified index buffer is installed below.
  const positionMap = new Map<string, number>();
  const canonicalToOriginal: number[] = [];
  const canonicalPositions: number[] = [];
  const canonical = new Uint32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${x},${y},${z}`;
    let c = positionMap.get(key);
    if (c === undefined) {
      c = canonicalToOriginal.length;
      positionMap.set(key, c);
      canonicalToOriginal.push(i);
      canonicalPositions.push(x, y, z);
    }
    canonical[i] = c;
  }

  const weldedIndices: number[] = [];
  for (let i = 0; i + 2 < sourceIndices.length; i += 3) {
    const a = canonical[sourceIndices[i]];
    const b = canonical[sourceIndices[i + 1]];
    const c = canonical[sourceIndices[i + 2]];
    if (a !== b && b !== c && c !== a) weldedIndices.push(a, b, c);
  }
  if (weldedIndices.length < 12) return null;

  await MeshoptSimplifier.ready;
  if (!MeshoptSimplifier.supported) return null;

  const inputIndices = new Uint32Array(weldedIndices);
  const positions = new Float32Array(canonicalPositions);
  const targetIndexCount = target * 3;
  // Start with a conservative error and relax it only when the requested
  // budget cannot be reached. This preserves detail at LOD1 while still
  // allowing genuinely tiny low-poly levels.
  let best: Uint32Array | null = null;
  for (const error of [0.02, 0.05, 0.1, 1]) {
    const [indices] = MeshoptSimplifier.simplify(
      inputIndices,
      positions,
      3,
      targetIndexCount,
      error,
      [],
    );
    if (!best || indices.length < best.length) best = indices;
    if (indices.length <= targetIndexCount) break;
  }
  if (!best || best.length >= sourceIndices.length) return null;

  const outputIndices = new Uint32Array(best.length);
  for (let i = 0; i < best.length; i++) {
    outputIndices[i] = canonicalToOriginal[best[i]];
  }
  const geometry = src.clone();
  geometry.setIndex(new BufferAttribute(outputIndices, 1));
  if (src.groups.length === 1) {
    const group = src.groups[0];
    geometry.clearGroups();
    geometry.addGroup(0, outputIndices.length, group.materialIndex);
  }
  transferSimplifiedUvs(geometry, src, best, canonical, sourceIndices, canonicalPositions);
  repairNonManifoldTriangles(geometry);
  return { geometry, triangleCount: Math.floor(outputIndices.length / 3) };
}

/**
 * Attribute-aware meshoptimizer path. Textured meshes use UVs (and normals /
 * colors when present) in the error metric while preserving each surviving
 * vertex's original attribute values. Untextured meshes use the update path
 * so their attributes can still be averaged during aggressive simplification.
 */
async function decimateWithAttributes(
  source: import('three').BufferGeometry,
  sourceIndices: Uint32Array,
  target: number,
): Promise<{ geometry: import('three').BufferGeometry; triangleCount: number } | null> {
  await MeshoptSimplifier.ready;
  if (!MeshoptSimplifier.supported || !MeshoptSimplifier.simplifyWithUpdate) return null;
  const position = source.attributes.position;
  const layouts: { name: string; itemSize: number; weight: number; normalized: boolean }[] = [];
  for (const name of ['uv', 'normal', 'color']) {
    const attribute = source.attributes[name];
    if (!attribute || attribute.count !== position.count) continue;
    layouts.push({
      name,
      itemSize: attribute.itemSize,
      weight: name === 'uv' ? 5 : 1,
      normalized: attribute.normalized,
    });
  }
  if (layouts.length === 0) return null;

  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }
  const attributeStride = layouts.reduce((sum, layout) => sum + layout.itemSize, 0);
  const attributes = new Float32Array(position.count * attributeStride);
  const weights: number[] = [];
  for (const layout of layouts) {
    for (let component = 0; component < layout.itemSize; component++) weights.push(layout.weight);
  }
  for (let i = 0; i < position.count; i++) {
    let offset = i * attributeStride;
    for (const layout of layouts) {
      const attribute = source.attributes[layout.name];
      for (let component = 0; component < layout.itemSize; component++) {
        attributes[offset++] = attribute.getComponent(i, component);
      }
    }
  }

  // Positions are commonly duplicated at UV seams.  Permissive simplification
  // is needed to reach very small LODs, but allowing a collapse across a large
  // UV jump produces the stretched triangles visible at the deepest levels.
  // Protect only the genuinely discontinuous seam vertices; locking every
  // seam would recreate the simplifier plateau we are avoiding.
  let vertexLock: Uint8Array | null = null;
  const uvLayout = layouts.find((layout) => layout.name === 'uv' && layout.itemSize >= 2);
  if (uvLayout) {
    const remap = MeshoptSimplifier.generatePositionRemap(positions, 3);
    const groups = new Map<number, number[]>();
    for (let i = 0; i < remap.length; i++) {
      const group = groups.get(remap[i]);
      if (group) group.push(i);
      else groups.set(remap[i], [i]);
    }
    vertexLock = new Uint8Array(position.count);
    const uvOffset = layouts
      .slice(0, layouts.indexOf(uvLayout))
      .reduce((sum, layout) => sum + layout.itemSize, 0);
    const seamThreshold = 0.98;
    for (const group of groups.values()) {
      for (let left = 0; left < group.length; left++) {
        const a = group[left];
        for (let right = left + 1; right < group.length; right++) {
          const b = group[right];
          const du =
            attributes[a * attributeStride + uvOffset] - attributes[b * attributeStride + uvOffset];
          const dv =
            attributes[a * attributeStride + uvOffset + 1] -
            attributes[b * attributeStride + uvOffset + 1];
          if (Math.hypot(du, dv) > seamThreshold) {
            vertexLock[a] = 2;
            vertexLock[b] = 2;
          }
        }
      }
    }
  }

  const targetIndexCount = target * 3;
  const preserveAttributeValues = Boolean(uvLayout && MeshoptSimplifier.simplifyWithAttributes);
  let bestIndices: Uint32Array | null = null;
  let bestPositions: Float32Array | null = null;
  let bestAttributes: Float32Array | null = null;
  for (const error of [0.02, 0.05, 0.1, 0.25, 0.5, 1]) {
    const indices = new Uint32Array(sourceIndices);
    let candidateIndices: Uint32Array;
    let candidatePositions: Float32Array | null = null;
    let candidateAttributes: Float32Array | null = null;
    if (preserveAttributeValues) {
      [candidateIndices] = MeshoptSimplifier.simplifyWithAttributes(
        indices,
        positions,
        3,
        attributes,
        attributeStride,
        weights,
        vertexLock,
        targetIndexCount,
        error,
        ['Permissive'],
      );
    } else {
      candidatePositions = new Float32Array(positions);
      candidateAttributes = new Float32Array(attributes);
      const [indexCount] = MeshoptSimplifier.simplifyWithUpdate(
        indices,
        candidatePositions,
        3,
        candidateAttributes,
        attributeStride,
        weights,
        vertexLock,
        targetIndexCount,
        error,
        ['Permissive'],
      );
      candidateIndices = indices.slice(0, indexCount);
    }
    if (!bestIndices || candidateIndices.length < bestIndices.length) {
      bestIndices = candidateIndices;
      bestPositions = candidatePositions;
      bestAttributes = candidateAttributes;
    }
    if (candidateIndices.length <= targetIndexCount) break;
  }
  if (!bestIndices || bestIndices.length >= sourceIndices.length) return null;

  const geometry = source.clone();
  if (!preserveAttributeValues && bestPositions && bestAttributes) {
    geometry.setAttribute('position', new BufferAttribute(bestPositions, 3));
    let offset = 0;
    for (const layout of layouts) {
      const values = new Float32Array(position.count * layout.itemSize);
      for (let i = 0; i < position.count; i++) {
        values.set(
          bestAttributes.subarray(
            i * attributeStride + offset,
            i * attributeStride + offset + layout.itemSize,
          ),
          i * layout.itemSize,
        );
      }
      geometry.setAttribute(
        layout.name,
        new BufferAttribute(values, layout.itemSize, layout.normalized),
      );
      offset += layout.itemSize;
    }
  }
  const compactIndices = new Uint32Array(bestIndices);
  compactGeometry(geometry, compactIndices);
  geometry.setIndex(new BufferAttribute(compactIndices, 1));
  if (source.groups.length === 1) {
    const group = source.groups[0];
    geometry.clearGroups();
    geometry.addGroup(0, compactIndices.length, group.materialIndex);
  }
  repairNonManifoldTriangles(geometry);
  return { geometry, triangleCount: Math.floor(compactIndices.length / 3) };
}

/** Compact all regular vertex attributes after simplifyWithUpdate. */
function compactGeometry(geometry: import('three').BufferGeometry, indices: Uint32Array): void {
  const vertexCount = geometry.attributes.position.count;
  const [remap, unique] = MeshoptSimplifier.compactMesh(indices);
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (attribute.count !== vertexCount) continue;
    const values = createAttributeArray(attribute, unique * attribute.itemSize);
    for (let old = 0; old < vertexCount; old++) {
      const next = remap[old];
      if (next === 0xffffffff) continue;
      for (let component = 0; component < attribute.itemSize; component++) {
        values[next * attribute.itemSize + component] = attribute.getComponent(old, component);
      }
    }
    geometry.setAttribute(
      name,
      new BufferAttribute(values, attribute.itemSize, attribute.normalized),
    );
  }
}

/**
 * Create a compact geometry without first cloning the complete source.
 * Large scan meshes can have millions of vertices while a deep LOD references
 * only a few hundred of them; the direct build keeps the peak allocation
 * proportional to the requested LOD instead of briefly holding two full
 * copies of the source attributes.
 */
function createCompactedGeometry(
  source: import('three').BufferGeometry,
  indices: Uint32Array,
): import('three').BufferGeometry | null {
  const position = source.attributes.position;
  if (!position || indices.length < 3) return null;
  const [remap, unique] = MeshoptSimplifier.compactMesh(indices);
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    if (attribute.count !== position.count) continue;
    const values = createAttributeArray(attribute, unique * attribute.itemSize);
    for (let old = 0; old < position.count; old++) {
      const next = remap[old];
      if (next === 0xffffffff) continue;
      for (let component = 0; component < attribute.itemSize; component++) {
        values[next * attribute.itemSize + component] = attribute.getComponent(old, component);
      }
    }
    geometry.setAttribute(
      name,
      new BufferAttribute(values, attribute.itemSize, attribute.normalized),
    );
  }
  // Keep morph targets aligned with the compacted vertex stream. Most glTF
  // props do not use morphs, but dropping them here would make the memory-safe
  // large-mesh path a surprising regression for animated assets.
  for (const [name, morphs] of Object.entries(source.morphAttributes)) {
    geometry.morphAttributes[name] = morphs
      .filter((attribute) => attribute.count === position.count)
      .map((attribute) => {
        const values = createAttributeArray(attribute, unique * attribute.itemSize);
        for (let old = 0; old < position.count; old++) {
          const next = remap[old];
          if (next === 0xffffffff) continue;
          for (let component = 0; component < attribute.itemSize; component++) {
            values[next * attribute.itemSize + component] = attribute.getComponent(old, component);
          }
        }
        return new BufferAttribute(values, attribute.itemSize, attribute.normalized);
      });
  }
  geometry.morphTargetsRelative = source.morphTargetsRelative;
  geometry.setIndex(new BufferAttribute(indices, 1));
  if (source.groups.length === 1) {
    const group = source.groups[0];
    geometry.addGroup(0, indices.length, group.materialIndex);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

async function decimateIndexedUvMesh(
  source: import('three').BufferGeometry,
  sourceIndices: Uint32Array,
  target: number,
  flags: SimplifierFlags[] = [],
): Promise<{ geometry: import('three').BufferGeometry; triangleCount: number } | null> {
  await MeshoptSimplifier.ready;
  if (!MeshoptSimplifier.supported) return null;
  const positions = source.attributes.position;
  const positionValues = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    positionValues[i * 3] = positions.getX(i);
    positionValues[i * 3 + 1] = positions.getY(i);
    positionValues[i * 3 + 2] = positions.getZ(i);
  }
  const targetIndexCount = target * 3;
  let best: Uint32Array | null = null;
  for (const error of [0.02, 0.05, 0.1, 1]) {
    const [indices] = MeshoptSimplifier.simplify(
      sourceIndices,
      positionValues,
      3,
      targetIndexCount,
      error,
      flags,
    );
    if (!best || indices.length < best.length) best = indices;
    if (indices.length <= targetIndexCount) break;
  }
  if (!best || best.length >= sourceIndices.length) return null;
  // A reduced index buffer may reference only a tiny fraction of a large
  // source mesh. Build the compact geometry directly from the selected
  // vertices; cloning the full 1.8M-vertex source first is enough to crash a
  // constrained browser tab when several manual LOD targets are requested.
  const geometry = createCompactedGeometry(source, best);
  if (!geometry) return null;
  if (source.groups.length === 1) {
    const group = source.groups[0];
    geometry.clearGroups();
    geometry.addGroup(0, best.length, group.materialIndex);
  }
  repairNonManifoldTriangles(geometry);
  return { geometry, triangleCount: Math.floor(best.length / 3) };
}

interface SourceUvFace {
  positions: [number, number, number, number, number, number, number, number, number];
  uvs: [number, number, number, number, number, number];
  centroid: [number, number, number];
  normal: [number, number, number];
  island: number;
}

/** Transfer the atlas coordinates after position-only simplification. */
function transferSimplifiedUvs(
  geometry: import('three').BufferGeometry,
  source: import('three').BufferGeometry,
  simplifiedCanonicalIndices: Uint32Array,
  canonical: Uint32Array,
  sourceIndices: Uint32Array,
  canonicalPositions: number[],
): void {
  const sourceUv = source.attributes.uv;
  if (!sourceUv || sourceUv.itemSize < 2 || !geometry.index) return;

  const sourcePosition = source.attributes.position;
  const faces: SourceUvFace[] = [];
  const faceVertexIds: [number, number, number][] = [];
  for (let i = 0; i + 2 < sourceIndices.length; i += 3) {
    const ia = sourceIndices[i];
    const ib = sourceIndices[i + 1];
    const ic = sourceIndices[i + 2];
    const ca = canonical[ia];
    const cb = canonical[ib];
    const cc = canonical[ic];
    if (ca === cb || cb === cc || cc === ca) continue;
    const ax = sourcePosition.getX(ia);
    const ay = sourcePosition.getY(ia);
    const az = sourcePosition.getZ(ia);
    const bx = sourcePosition.getX(ib);
    const by = sourcePosition.getY(ib);
    const bz = sourcePosition.getZ(ib);
    const cx = sourcePosition.getX(ic);
    const cy = sourcePosition.getY(ic);
    const cz = sourcePosition.getZ(ic);
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    faces.push({
      positions: [ax, ay, az, bx, by, bz, cx, cy, cz],
      uvs: [
        sourceUv.getX(ia),
        sourceUv.getY(ia),
        sourceUv.getX(ib),
        sourceUv.getY(ib),
        sourceUv.getX(ic),
        sourceUv.getY(ic),
      ],
      centroid: [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3],
      normal: [nx, ny, nz],
      island: -1,
    });
    faceVertexIds.push([ia, ib, ic]);
  }
  if (faces.length === 0) return;

  // Keep UV transfer inside one source UV island. Choosing a face per corner
  // without this constraint can make a reduced triangle interpolate between
  // unrelated regions of the atlas.
  const facesByVertex = new Map<number, number[]>();
  for (let i = 0; i < faceVertexIds.length; i++) {
    for (const vertex of faceVertexIds[i]) {
      const list = facesByVertex.get(vertex);
      if (list) list.push(i);
      else facesByVertex.set(vertex, [i]);
    }
  }
  const islands: number[][] = [];
  for (let start = 0; start < faces.length; start++) {
    if (faces[start].island >= 0) continue;
    const islandId = islands.length;
    const island: number[] = [];
    const queue = [start];
    faces[start].island = islandId;
    while (queue.length) {
      const faceIndex = queue.pop()!;
      island.push(faceIndex);
      for (const vertex of faceVertexIds[faceIndex]) {
        for (const neighbor of facesByVertex.get(vertex) ?? []) {
          if (faces[neighbor].island < 0) {
            faces[neighbor].island = islandId;
            queue.push(neighbor);
          }
        }
      }
    }
    islands.push(island);
  }

  const output = geometry.toNonIndexed();
  const outputIndex = simplifiedCanonicalIndices;
  const outputPosition = output.attributes.position;
  const uvValues = new Float32Array(outputPosition.count * 2);
  for (let i = 0; i < outputIndex.length; i += 3) {
    const ca = outputIndex[i];
    const cb = outputIndex[i + 1];
    const cc = outputIndex[i + 2];
    const ax = canonicalPositions[ca * 3];
    const ay = canonicalPositions[ca * 3 + 1];
    const az = canonicalPositions[ca * 3 + 2];
    const bx = canonicalPositions[cb * 3];
    const by = canonicalPositions[cb * 3 + 1];
    const bz = canonicalPositions[cb * 3 + 2];
    const cx = canonicalPositions[cc * 3];
    const cy = canonicalPositions[cc * 3 + 1];
    const cz = canonicalPositions[cc * 3 + 2];
    const ex = bx - ax;
    const ey = by - ay;
    const ez = bz - az;
    const fx = cx - ax;
    const fy = cy - ay;
    const fz = cz - az;
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const mx = (ax + bx + cx) / 3;
    const my = (ay + by + cy) / 3;
    const mz = (az + bz + cz) / 3;
    let bestFace = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
      const face = faces[faceIndex];
      const dx = face.centroid[0] - mx;
      const dy = face.centroid[1] - my;
      const dz = face.centroid[2] - mz;
      const normalScore =
        1 - Math.abs(face.normal[0] * nx + face.normal[1] * ny + face.normal[2] * nz);
      const score = dx * dx + dy * dy + dz * dz + normalScore * 0.05;
      if (score < bestScore) {
        bestScore = score;
        bestFace = faceIndex;
      }
    }
    const islandFaces = islands[faces[bestFace].island];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = [ca, cb, cc][corner];
      let cornerFace = bestFace;
      let cornerScore = Number.POSITIVE_INFINITY;
      for (const faceIndex of islandFaces) {
        const face = faces[faceIndex];
        const dx = face.centroid[0] - mx;
        const dy = face.centroid[1] - my;
        const dz = face.centroid[2] - mz;
        const normalScore =
          1 - Math.abs(face.normal[0] * nx + face.normal[1] * ny + face.normal[2] * nz);
        const score = dx * dx + dy * dy + dz * dz + normalScore * 0.05;
        if (score < cornerScore) {
          cornerScore = score;
          cornerFace = faceIndex;
        }
      }
      const face = faces[cornerFace];
      const px = canonicalPositions[vertex * 3];
      const py = canonicalPositions[vertex * 3 + 1];
      const pz = canonicalPositions[vertex * 3 + 2];
      const uv = barycentricUv(face, px, py, pz);
      const outputVertex = i + corner;
      uvValues[outputVertex * 2] = uv[0];
      uvValues[outputVertex * 2 + 1] = uv[1];
    }
  }
  output.setAttribute('uv', new BufferAttribute(uvValues, 2));
  const indexed = BufferGeometryUtils.mergeVertices(output, 1e-10);
  geometry.copy(indexed);
}

function barycentricUv(face: SourceUvFace, px: number, py: number, pz: number): [number, number] {
  const ax = face.positions[0];
  const ay = face.positions[1];
  const az = face.positions[2];
  const abx = face.positions[3] - ax;
  const aby = face.positions[4] - ay;
  const abz = face.positions[5] - az;
  const acx = face.positions[6] - ax;
  const acy = face.positions[7] - ay;
  const acz = face.positions[8] - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d00 = abx * abx + aby * aby + abz * abz;
  const d01 = abx * acx + aby * acy + abz * acz;
  const d11 = acx * acx + acy * acy + acz * acz;
  const d20 = apx * abx + apy * aby + apz * abz;
  const d21 = apx * acx + apy * acy + apz * acz;
  const denominator = d00 * d11 - d01 * d01;
  let v = denominator ? (d11 * d20 - d01 * d21) / denominator : 0;
  let w = denominator ? (d00 * d21 - d01 * d20) / denominator : 0;
  let u = 1 - v - w;
  u = Math.max(0, Math.min(1, u));
  v = Math.max(0, Math.min(1, v));
  w = Math.max(0, Math.min(1, w));
  const total = u + v + w || 1;
  u /= total;
  v /= total;
  w /= total;
  return [
    face.uvs[0] * u + face.uvs[2] * v + face.uvs[4] * w,
    face.uvs[1] * u + face.uvs[3] * v + face.uvs[5] * w,
  ];
}

/**
 * A very aggressive simplification can make one edge belong to three faces.
 * Split only those exceptional faces by duplicating their vertices at the
 * same positions. This keeps every triangle visible (unlike dropping a face)
 * and removes the non-manifold edge that can render as a black crack/hole.
 */
function repairNonManifoldTriangles(geometry: import('three').BufferGeometry): void {
  const index = geometry.index;
  const position = geometry.attributes.position;
  if (!index || !position) return;
  const attributes = Object.values(geometry.attributes);
  if (attributes.some((attribute) => 'data' in attribute)) return;

  const indices = Uint32Array.from(index.array as ArrayLike<number>);
  const edgeFaces = new Map<string, number[]>();
  for (let i = 0; i < indices.length; i += 3) {
    for (const [a, b] of [
      [indices[i], indices[i + 1]],
      [indices[i + 1], indices[i + 2]],
      [indices[i + 2], indices[i]],
    ]) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const faces = edgeFaces.get(key);
      if (faces) faces.push(i);
      else edgeFaces.set(key, [i]);
    }
  }

  const splitFaces = new Set<number>();
  for (const faces of edgeFaces.values()) {
    for (const face of faces.slice(2)) splitFaces.add(face);
  }
  if (splitFaces.size === 0) return;

  const originalVertexCount = position.count;
  const cloneSources: number[] = [];
  for (const face of splitFaces) {
    for (let j = 0; j < 3; j++) {
      const source = indices[face + j];
      indices[face + j] = originalVertexCount + cloneSources.length;
      cloneSources.push(source);
    }
  }

  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const itemSize = attribute.itemSize;
    const Ctor = attribute.array.constructor as new (
      length: number,
    ) => Float32Array | Uint8Array | Uint16Array | Uint32Array;
    const values = new Ctor((attribute.count + cloneSources.length) * itemSize);
    values.set(attribute.array as typeof values);
    for (let i = 0; i < cloneSources.length; i++) {
      const from = cloneSources[i] * itemSize;
      const to = (attribute.count + i) * itemSize;
      for (let j = 0; j < itemSize; j++) values[to + j] = values[from + j];
    }
    geometry.setAttribute(name, new BufferAttribute(values, itemSize, attribute.normalized));
  }
  geometry.setIndex(new BufferAttribute(indices, 1));
}

/**
 * Legacy topology-safe edge-collapse decimation retained for callers that
 * need a synchronous fallback. The optimization pipeline uses
 * `meshoptDecimate` above because it handles UV-seamed assets progressively.
 *
 * Edge-collapse decimation. Picks the cheapest edge (shortest + lowest
 * UV/normal delta) and collapses its endpoints into one, removing
 * any triangle that becomes degenerate in the process.
 *
 * Topology-preserving by design:
 *   - We only collapse edges shared by exactly 2 triangles (interior
 *     manifold edges). Boundary edges (1 triangle) are skipped —
 *     collapsing them would create holes.
 *   - Non-manifold edges (used by >2 triangles) are also skipped.
 *   - The collapsed vertex stays at one original endpoint, avoiding
 *     cumulative surface drift and self-intersections at low LODs.
 *   - The one-ring link condition and simulated face-orientation checks
 *     reject collapses that would weld unrelated regions or flip faces.
 *   - The opposite "side" of an edge collapse (the two triangles that
 *     used the edge) gets removed; the surrounding ring of triangles
 *     is updated to point at the merged vertex. Triangles that share
 *     a now-degenerate pair of vertices are dropped.
 *
 * Cost function (lower = better to collapse):
 *   cost = 1.0 * edgeLength  (normalized to bbox diag)
 *        + 0.5 * uvDelta
 *        + 0.3 * (1 - dot(n1, n2))
 *
 * Throws on unrecoverable errors so the caller can keep the denser mesh.
 */
export function edgeCollapseDecimate(
  src: import('three').BufferGeometry,
  targetTris: number,
): CriticalVertexRepairResult | null {
  if (!src.attributes.position) return null;
  // glTF usually supplies indices, but indexing a triangle soup first lets
  // the same safe-collapse path handle non-indexed input as well. mergeVertices
  // includes all attributes in its hash, so UV and hard-normal seams stay split.
  const indexedSrc = src.index ? src : BufferGeometryUtils.mergeVertices(src.clone());
  if (!indexedSrc.index) return null;
  const idxArr = indexedSrc.index.array as Uint32Array | Uint16Array | Uint8Array;
  const triCount0 = idxArr.length / 3;
  if (triCount0 <= targetTris) {
    return { geometry: indexedSrc.clone(), triangleCount: triCount0, restoredVertices: 0 };
  }
  const posArr = indexedSrc.attributes.position.array as Float32Array;
  const uvArr = indexedSrc.attributes.uv?.array as Float32Array | undefined;
  const normArr = indexedSrc.attributes.normal?.array as Float32Array | undefined;
  const vCount = indexedSrc.attributes.position.count;
  // On dense meshes, retain the sharp-edge guard to protect silhouettes.
  // Very small meshes often have no smooth edges at all, so permitting
  // topology-safe sharp collapses is what lets an icosahedron/cube reach
  // genuinely tiny LOD targets.
  const allowSharpCollapses = triCount0 <= 128;
  // Assets without normals cannot use normal continuity as a seam signal, so
  // allow their boundary-adjacent interior edges and rely on the link/face
  // checks instead.
  const allowBoundaryVertexCollapses = !normArr || triCount0 <= 128;
  // Working copy of the index buffer. We mark dropped triangles by
  // setting all three indices to the same value (vCount, an out-of-range
  // sentinel).
  const triIdx = new Uint32Array(idxArr);
  // remap[v] = the live vertex that original vertex v has been folded
  // into. Initial: identity.
  const remap = new Uint32Array(vCount);
  for (let i = 0; i < vCount; i++) remap[i] = i;
  // Live flag: 1 = vertex is still a real vertex; 0 = collapsed into
  // another. The collapsed vertex's position/UV/normal arrays are
  // stale, so we use this to skip them.
  const alive = new Uint8Array(vCount);
  for (let i = 0; i < vCount; i++) alive[i] = 1;
  // Working attribute arrays (mutated in place).
  const posX = new Float32Array(posArr.length / 3);
  const posY = new Float32Array(posArr.length / 3);
  const posZ = new Float32Array(posArr.length / 3);
  for (let i = 0; i < vCount; i++) {
    posX[i] = posArr[i * 3];
    posY[i] = posArr[i * 3 + 1];
    posZ[i] = posArr[i * 3 + 2];
  }
  const uvU = uvArr ? new Float32Array(uvArr.length / 2) : null;
  const uvV = uvArr ? new Float32Array(uvArr.length / 2) : null;
  if (uvArr) {
    for (let i = 0; i < vCount; i++) {
      uvU![i] = uvArr[i * 2];
      uvV![i] = uvArr[i * 2 + 1];
    }
  }
  const nrmX = normArr ? new Float32Array(normArr.length / 3) : null;
  const nrmY = normArr ? new Float32Array(normArr.length / 3) : null;
  const nrmZ = normArr ? new Float32Array(normArr.length / 3) : null;
  if (normArr) {
    for (let i = 0; i < vCount; i++) {
      nrmX![i] = normArr[i * 3];
      nrmY![i] = normArr[i * 3 + 1];
      nrmZ![i] = normArr[i * 3 + 2];
    }
  }

  // Bounding box diagonal — for normalizing edge length in the cost
  // function.
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < vCount; i++) {
    const x = posArr[i * 3],
      y = posArr[i * 3 + 1],
      z = posArr[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) || 1;
  // Each surviving triangle keeps its original triangle ID throughout the
  // simplification. Store that face's source orientation so a sequence of
  // individually small moves cannot gradually rotate it inside-out.
  const sourceFaceX = new Float32Array(triCount0);
  const sourceFaceY = new Float32Array(triCount0);
  const sourceFaceZ = new Float32Array(triCount0);
  for (let ti = 0; ti < triCount0; ti++) {
    const a = idxArr[ti * 3];
    const b = idxArr[ti * 3 + 1];
    const c = idxArr[ti * 3 + 2];
    const ux = posX[b] - posX[a];
    const uy = posY[b] - posY[a];
    const uz = posZ[b] - posZ[a];
    const vx = posX[c] - posX[a];
    const vy = posY[c] - posY[a];
    const vz = posZ[c] - posZ[a];
    sourceFaceX[ti] = uy * vz - uz * vy;
    sourceFaceY[ti] = uz * vx - ux * vz;
    sourceFaceZ[ti] = ux * vy - uy * vx;
  }

  function liveTriCount(): number {
    let n = 0;
    const t = triIdx.length / 3;
    for (let i = 0; i < t; i++) {
      const a = remap[triIdx[i * 3]];
      const b = remap[triIdx[i * 3 + 1]];
      const c = remap[triIdx[i * 3 + 2]];
      if (a !== b && b !== c && a !== c) n++;
    }
    return n;
  }

  // Build two maps from the current state:
  //   edgeUse  — edge (canonical) → how many triangles use it (1, 2, 3+).
  //              Only edges with count === 2 are safe to collapse
  //              (interior manifold edges). 1 = boundary, 3+ = non-manifold.
  //   edgeTris — edge (canonical) → packed pair of triangle indices.
  //              Used to look up the two adjacent triangles and check
  //              the dihedral angle before collapsing.
  const edgeUse = new Map<number, number>();
  const edgeTris = new Map<number, number>();
  let vertexTris: number[][] = [];
  const boundaryVertex = new Uint8Array(vCount);
  const unpackEdge = (packed: number): [number, number] => {
    const low = Math.floor(packed / vCount);
    return [low, packed - low * vCount];
  };
  const pack2 = (t1: number, t2: number) => t1 * triIdx.length + t2;
  const unpack2 = (packed: number): [number, number] => {
    const t2 = packed % triIdx.length;
    const t1 = (packed - t2) / triIdx.length;
    return [t1, t2];
  };
  function rebuildEdges() {
    edgeUse.clear();
    edgeTris.clear();
    boundaryVertex.fill(0);
    vertexTris = Array.from({ length: vCount }, () => []);
    const t = triIdx.length / 3;
    for (let i = 0; i < t; i++) {
      const a = remap[triIdx[i * 3]];
      const b = remap[triIdx[i * 3 + 1]];
      const c = remap[triIdx[i * 3 + 2]];
      if (a === b || b === c || a === c) continue;
      vertexTris[a].push(i);
      vertexTris[b].push(i);
      vertexTris[c].push(i);
      const e1 = a < b ? a * vCount + b : b * vCount + a;
      const e2 = b < c ? b * vCount + c : c * vCount + b;
      const e3 = a < c ? a * vCount + c : c * vCount + a;
      edgeUse.set(e1, (edgeUse.get(e1) ?? 0) + 1);
      edgeUse.set(e2, (edgeUse.get(e2) ?? 0) + 1);
      edgeUse.set(e3, (edgeUse.get(e3) ?? 0) + 1);
      // Track the two triangle indices per edge (we only call this for
      // count-2 edges, so at most two triangles are stored).
      const addTris = (k: number, ti: number) => {
        const existing = edgeTris.get(k);
        if (existing === undefined) {
          edgeTris.set(k, pack2(ti, ti)); // first add — sentinel (t1 === t2)
        } else {
          const [t1] = unpack2(existing);
          edgeTris.set(k, pack2(t1, ti));
        }
      };
      addTris(e1, i);
      addTris(e2, i);
      addTris(e3, i);
    }
    for (const [k, count] of edgeUse) {
      if (count !== 1) continue;
      const [a, b] = unpackEdge(k);
      boundaryVertex[a] = 1;
      boundaryVertex[b] = 1;
    }
  }
  rebuildEdges();

  function edgeCost(a: number, b: number): number {
    const dx = posX[a] - posX[b];
    const dy = posY[a] - posY[b];
    const dz = posZ[a] - posZ[b];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) / diag;
    let uvCost = 0;
    if (uvU && uvV) {
      uvCost = (Math.abs(uvU[a] - uvU[b]) + Math.abs(uvV[a] - uvV[b])) * 0.5;
    }
    let nCost = 0;
    if (nrmX && nrmY && nrmZ) {
      const dot = nrmX[a] * nrmX[b] + nrmY[a] * nrmY[b] + nrmZ[a] * nrmZ[b];
      nCost = Math.max(0, 1 - dot);
    }
    // Edge length is weighted heavily — we want to collapse only
    // short edges (locally redundant detail) and leave long edges
    // (silhouette-defining) alone.
    return len * 5.0 + uvCost * 0.5 + nCost * 0.3;
  }

  // Collapse edge (a, b): a keeps its identity and exact source position,
  // b is folded into a. Keeping an existing endpoint prevents repeated
  // midpoint moves from drifting a low-LOD surface through itself.
  function collapse(a: number, b: number) {
    // Mark b as dead and redirect every reference to b → a.
    alive[b] = 0;
    for (let i = 0; i < remap.length; i++) {
      if (remap[i] === b) remap[i] = a;
    }
    remap[b] = a;
  }

  // Compute the dihedral angle (1 - dot of the two triangles' normals)
  // for an edge. Returns Infinity when the adjacent faces are unavailable;
  // otherwise it is a shape-preservation cost, not a hard veto.
  // dihedral = 1 - dot(n1, n2)  (0 = coplanar, 2 = flat back)
  function edgeDihedral(k: number): number {
    const packed = edgeTris.get(k);
    if (packed === undefined) return Infinity;
    const [ti1, ti2] = unpack2(packed);
    if (ti1 === ti2) return Infinity; // only one triangle recorded yet
    const triNormal = (ti: number, out: number[]) => {
      const a = remap[triIdx[ti * 3]];
      const b = remap[triIdx[ti * 3 + 1]];
      const c = remap[triIdx[ti * 3 + 2]];
      if (a === b || b === c || a === c) return false;
      const ax = posX[a],
        ay = posY[a],
        az = posZ[a];
      const bx = posX[b],
        by = posY[b],
        bz = posZ[b];
      const cx = posX[c],
        cy = posY[c],
        cz = posZ[c];
      const ux = bx - ax,
        uy = by - ay,
        uz = bz - az;
      const vx = cx - ax,
        vy = cy - ay,
        vz = cz - az;
      // n = u × v
      out[0] = uy * vz - uz * vy;
      out[1] = uz * vx - ux * vz;
      out[2] = ux * vy - uy * vx;
      const len = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
      if (len < 1e-9) return false;
      out[0] /= len;
      out[1] /= len;
      out[2] /= len;
      return true;
    };
    const n1 = [0, 0, 0];
    const n2 = [0, 0, 0];
    if (!triNormal(ti1, n1) || !triNormal(ti2, n2)) return Infinity;
    const dot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
    // Near-coplanar faces get a lower cost. Sharp edges are still allowed
    // for genuinely low-poly inputs; collapseIsSafe remains the hard veto.
    return 1 - dot;
  }

  /**
   * Enforce the edge-collapse link condition and simulate the move on every
   * affected face. The link condition prevents two unrelated parts of the
   * one-ring from being welded together; the geometric check prevents a
   * surviving triangle from becoming degenerate or turning inside-out.
   */
  function collapseIsSafe(k: number, keep: number, remove: number): boolean {
    if (!allowBoundaryVertexCollapses && (boundaryVertex[keep] || boundaryVertex[remove])) {
      return false;
    }
    const packed = edgeTris.get(k);
    if (packed === undefined) return false;
    const [edgeTriA, edgeTriB] = unpack2(packed);
    if (edgeTriA === edgeTriB) return false;

    const neighbors = (vertex: number): Set<number> => {
      const result = new Set<number>();
      for (const ti of vertexTris[vertex]) {
        const x = remap[triIdx[ti * 3]];
        const y = remap[triIdx[ti * 3 + 1]];
        const z = remap[triIdx[ti * 3 + 2]];
        if (x !== vertex) result.add(x);
        if (y !== vertex) result.add(y);
        if (z !== vertex) result.add(z);
      }
      return result;
    };

    const neighborsA = neighbors(keep);
    const neighborsB = neighbors(remove);
    const common = new Set<number>();
    for (const v of neighborsA) {
      if (neighborsB.has(v)) common.add(v);
    }

    const opposite = new Set<number>();
    for (const ti of [edgeTriA, edgeTriB]) {
      for (let corner = 0; corner < 3; corner++) {
        const v = remap[triIdx[ti * 3 + corner]];
        if (v !== keep && v !== remove) opposite.add(v);
      }
    }
    if (opposite.size !== 2 || common.size !== opposite.size) return false;
    for (const v of common) {
      if (!opposite.has(v)) return false;
    }

    const nextX = posX[keep];
    const nextY = posY[keep];
    const nextZ = posZ[keep];
    const affected = new Set<number>([...vertexTris[keep], ...vertexTris[remove]]);
    const absoluteAreaEpsilon = diag ** 4 * 1e-20;

    for (const ti of affected) {
      const ids = [remap[triIdx[ti * 3]], remap[triIdx[ti * 3 + 1]], remap[triIdx[ti * 3 + 2]]];
      if (ids.includes(keep) && ids.includes(remove)) continue; // the two removed faces

      const oldPoints = ids.map((v) => [posX[v], posY[v], posZ[v]]);
      const newPoints = ids.map((v) =>
        v === keep || v === remove ? [nextX, nextY, nextZ] : [posX[v], posY[v], posZ[v]],
      );
      const faceVector = (points: number[][]): [number, number, number] => {
        const ux = points[1][0] - points[0][0];
        const uy = points[1][1] - points[0][1];
        const uz = points[1][2] - points[0][2];
        const vx = points[2][0] - points[0][0];
        const vy = points[2][1] - points[0][1];
        const vz = points[2][2] - points[0][2];
        return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      };
      const oldFace = faceVector(oldPoints);
      const newFace = faceVector(newPoints);
      const oldArea2 = oldFace[0] ** 2 + oldFace[1] ** 2 + oldFace[2] ** 2;
      const newArea2 = newFace[0] ** 2 + newFace[1] ** 2 + newFace[2] ** 2;
      // Pre-existing zero-area input faces are not made worse by this test,
      // but every previously valid face must remain valid.
      if (oldArea2 <= absoluteAreaEpsilon) continue;
      if (newArea2 <= Math.max(absoluteAreaEpsilon, oldArea2 * 1e-8)) return false;
      const dot = oldFace[0] * newFace[0] + oldFace[1] * newFace[1] + oldFace[2] * newFace[2];
      // A small positive margin rejects near-90° folds as well as outright
      // flips; those near-edge-on faces are the next collapse's usual source
      // of visible cracks.
      if (dot <= Math.sqrt(oldArea2 * newArea2) * 0.05) return false;
      const sourceArea2 = sourceFaceX[ti] ** 2 + sourceFaceY[ti] ** 2 + sourceFaceZ[ti] ** 2;
      if (sourceArea2 > absoluteAreaEpsilon) {
        const sourceDot =
          sourceFaceX[ti] * newFace[0] +
          sourceFaceY[ti] * newFace[1] +
          sourceFaceZ[ti] * newFace[2];
        if (sourceDot <= Math.sqrt(sourceArea2 * newArea2) * 0.05) return false;
      }
    }
    return true;
  }

  // Main loop. We bound iterations at 2× the desired reduction as a
  // safety net — most meshes converge well before this.
  // Every legal interior collapse removes at least its two incident faces,
  // so this bound is sufficient while avoiding long scans after the target
  // has become unreachable.
  const maxIter = Math.max(1, triCount0 - targetTris) + 100;
  for (let iter = 0; iter < maxIter; iter++) {
    if (liveTriCount() <= targetTris) break;
    // Find the cheapest manifold edge where both endpoints are still live.
    // Dihedral angle and boundary proximity are penalties, while topology
    // and face orientation remain hard safety checks. O(E) scan — fine for
    // our mesh sizes.
    let bestCost = Infinity;
    let bestA = -1;
    let bestB = -1;
    for (const [k, count] of edgeUse) {
      if (count !== 2) continue; // skip boundary (1) and non-manifold (>2)
      const [a, b] = unpackEdge(k);
      if (!alive[a] || !alive[b]) continue;
      const dih = edgeDihedral(k);
      if (!allowSharpCollapses && dih > 0.5) continue;
      let keep = a;
      let remove = b;
      if (!collapseIsSafe(k, keep, remove)) {
        keep = b;
        remove = a;
        if (!collapseIsSafe(k, keep, remove)) continue;
      }
      // Prefer smooth edges, but allow sharp edges when a low-poly mesh has
      // no smooth alternatives left. The topology and face-orientation
      // checks above still decide whether the collapse is legal.
      const c = edgeCost(a, b) + (allowSharpCollapses ? dih * 0.5 : 0);
      if (c < bestCost) {
        bestCost = c;
        bestA = keep;
        bestB = remove;
      }
    }
    if (bestA < 0) break; // no more valid edges
    collapse(bestA, bestB);
    rebuildEdges();
  }

  // Build the output geometry. Walk triangles, keep non-degenerate
  // ones, then re-index to a contiguous range.
  const finalIdx: number[] = [];
  const t = triIdx.length / 3;
  for (let i = 0; i < t; i++) {
    const a = remap[triIdx[i * 3]];
    const b = remap[triIdx[i * 3 + 1]];
    const c = remap[triIdx[i * 3 + 2]];
    if (a !== b && b !== c && a !== c) {
      finalIdx.push(a, b, c);
    }
  }
  if (finalIdx.length === 0) return null;
  // Re-index: contiguous vertex IDs.
  const oldToNew = new Int32Array(vCount).fill(-1);
  let newCount = 0;
  for (let i = 0; i < vCount; i++) {
    if (alive[i]) oldToNew[i] = newCount++;
  }
  for (let i = 0; i < finalIdx.length; i++) finalIdx[i] = oldToNew[finalIdx[i]];
  // Build attribute arrays from the live vertices' current values.
  const newPos = new Float32Array(newCount * 3);
  const newUv = uvU ? new Float32Array(newCount * 2) : null;
  const newNrm = nrmX ? new Float32Array(newCount * 3) : null;
  for (let i = 0; i < vCount; i++) {
    if (!alive[i]) continue;
    const ni = oldToNew[i];
    newPos[ni * 3] = posX[i];
    newPos[ni * 3 + 1] = posY[i];
    newPos[ni * 3 + 2] = posZ[i];
    if (newUv && uvU && uvV) {
      newUv[ni * 2] = uvU[i];
      newUv[ni * 2 + 1] = uvV[i];
    }
    if (newNrm && nrmX && nrmY && nrmZ) {
      newNrm[ni * 3] = nrmX[i];
      newNrm[ni * 3 + 1] = nrmY[i];
      newNrm[ni * 3 + 2] = nrmZ[i];
    }
  }
  const newGeo = new BufferGeometry();
  newGeo.setAttribute('position', new BufferAttribute(newPos, 3));
  if (newUv) newGeo.setAttribute('uv', new BufferAttribute(newUv, 2));
  if (newNrm) newGeo.setAttribute('normal', new BufferAttribute(newNrm, 3));
  newGeo.setIndex(new BufferAttribute(new Uint32Array(finalIdx), 1));
  if (newNrm) newGeo.computeVertexNormals();
  return finishDecimation(
    indexedSrc,
    { geometry: newGeo, triangleCount: finalIdx.length / 3 },
    targetTris,
  );
}
