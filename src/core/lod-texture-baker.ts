import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DoubleSide,
  Material,
  MirroredRepeatWrapping,
  Ray,
  RepeatWrapping,
  Source,
  Texture,
  Triangle,
  Vector3,
} from 'three';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import * as watlas from 'watlas';

const TEXTURE_SLOTS = [
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

const INVALID_FACE = 0xffffffff;
const ATLAS_PADDING = 8;
let watlasReady: Promise<void> | null = null;

interface SourceTexturePixels {
  data: Uint8ClampedArray;
  height: number;
  texture: Texture;
  width: number;
}

interface ProjectionMap {
  barycentricA: Float32Array;
  barycentricB: Float32Array;
  faces: Uint32Array;
  height: number;
  width: number;
}

export interface UnwrappedLodGeometry {
  geometry: BufferGeometry;
  height: number;
  width: number;
}

export interface BakedLod {
  geometry: BufferGeometry;
  material: Material;
  resolution: number;
  textureCount: number;
}

export interface LodTextureBaker {
  bake(
    simplifiedGeometry: BufferGeometry,
    lodLevel: number,
    lodTriangles: number,
    sourceTriangles: number,
  ): Promise<BakedLod | null>;
}

/**
 * Build a new, non-overlapping UV atlas with xatlas/watlas. Every other vertex
 * attribute is copied through xatlas' xref so seams introduced by the atlas do
 * not change the simplified surface.
 */
export async function unwrapLodGeometry(
  source: BufferGeometry,
  requestedResolution: number,
): Promise<UnwrappedLodGeometry | null> {
  const sourcePosition = source.attributes.position;
  const sourceIndex = source.index;
  if (!sourcePosition || !sourceIndex || sourceIndex.count < 3) return null;

  watlasReady ??= watlas.Initialize();
  await watlasReady;

  // Some valid glTF assets omit NORMAL and rely on renderer-generated face
  // normals. Face-by-face bake rays are visibly discontinuous on curved,
  // aggressively simplified surfaces, so generate smooth projection normals
  // on a clone before xatlas introduces additional UV-seam vertices. Keeping
  // this clone separate avoids mutating LOD1/LOD2 or the caller's source mesh.
  const preparedSource =
    source.attributes.normal?.count === sourcePosition.count ? source : source.clone();
  const ownsPreparedSource = preparedSource !== source;
  if (ownsPreparedSource) preparedSource.computeVertexNormals();

  const position = preparedSource.attributes.position;

  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }
  const indices = Uint32Array.from(sourceIndex.array as ArrayLike<number>);
  const normal = preparedSource.attributes.normal;
  let normals: Float32Array | undefined;
  if (normal && normal.count === position.count) {
    normals = new Float32Array(normal.count * 3);
    for (let i = 0; i < normal.count; i++) {
      normals[i * 3] = normal.getX(i);
      normals[i * 3 + 1] = normal.getY(i);
      normals[i * 3 + 2] = normal.getZ(i);
    }
  }

  const atlas = new watlas.Atlas();
  try {
    atlas.addMesh({
      vertexPositionData: positions,
      vertexCount: position.count,
      vertexPositionStride: 12,
      vertexNormalData: normals,
      vertexNormalStride: normals ? 12 : undefined,
      indexData: indices,
      indexCount: indices.length,
    });
    atlas.generate(
      {
        fixWinding: true,
        maxIterations: 4,
        normalDeviationWeight: 2,
        textureSeamWeight: 1,
      },
      {
        bilinear: true,
        blockAlign: false,
        bruteForce: true,
        padding: ATLAS_PADDING,
        resolution: Math.max(64, Math.floor(requestedResolution)),
        rotateCharts: true,
        rotateChartsToAxis: true,
      },
    );
    if (atlas.meshCount !== 1 || atlas.atlasCount !== 1 || !atlas.width || !atlas.height) {
      return null;
    }

    const atlasMesh = atlas.getMesh(0);
    const outputIndices = new Uint32Array(atlasMesh.indexCount);
    atlasMesh.getIndexArray(outputIndices);
    const xrefs = new Uint32Array(atlasMesh.vertexCount);
    const uvs = new Float32Array(atlasMesh.vertexCount * 2);
    for (let i = 0; i < atlasMesh.vertexCount; i++) {
      const vertex = atlasMesh.getVertex(i);
      xrefs[i] = vertex.xref;
      uvs[i * 2] = vertex.uv[0] / atlas.width;
      uvs[i * 2 + 1] = vertex.uv[1] / atlas.height;
    }

    const geometry = new BufferGeometry();
    for (const [name, attribute] of Object.entries(preparedSource.attributes)) {
      if (name === 'uv' || attribute.count !== position.count || 'data' in attribute) continue;
      const ArrayConstructor = attribute.array.constructor as new (
        length: number,
      ) => typeof attribute.array;
      const values = new ArrayConstructor(atlasMesh.vertexCount * attribute.itemSize);
      for (let i = 0; i < atlasMesh.vertexCount; i++) {
        const sourceVertex = xrefs[i];
        for (let component = 0; component < attribute.itemSize; component++) {
          values[i * attribute.itemSize + component] =
            attribute.array[sourceVertex * attribute.itemSize + component];
        }
      }
      geometry.setAttribute(
        name,
        new BufferAttribute(values, attribute.itemSize, attribute.normalized),
      );
    }
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.setIndex(new BufferAttribute(outputIndices, 1));
    if (preparedSource.groups.length === 1) {
      geometry.addGroup(0, outputIndices.length, preparedSource.groups[0].materialIndex);
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { geometry, width: atlas.width, height: atlas.height };
  } finally {
    atlas.delete();
    if (ownsPreparedSource) preparedSource.dispose();
  }
}

/**
 * Prepare a selected-to-active style texture baker. The high-detail source is
 * indexed once with a BVH and its texture pixels are decoded once, then reused
 * for every generated LOD.
 */
export async function createLodTextureBaker(
  sourceGeometry: BufferGeometry,
  sourceMaterial: Material | Material[],
  maxTextureSize: number,
): Promise<LodTextureBaker | null> {
  if (
    typeof document === 'undefined' ||
    Array.isArray(sourceMaterial) ||
    !sourceGeometry.index ||
    !sourceGeometry.attributes.position ||
    !sourceGeometry.attributes.uv
  ) {
    return null;
  }

  const materialRecord = sourceMaterial as unknown as Record<string, unknown>;
  const textures = new Map<Texture, SourceTexturePixels>();
  for (const slot of TEXTURE_SLOTS) {
    const value = materialRecord[slot];
    if (!(value instanceof Texture) || textures.has(value)) continue;
    const pixels = readTexturePixels(value);
    if (!pixels) return null;
    textures.set(value, pixels);
  }
  if (textures.size === 0) return null;

  const projectionGeometry = createProjectionGeometry(sourceGeometry);
  const bvh = new MeshBVH(projectionGeometry, { indirect: true });
  const sourceBounds = projectionGeometry.boundingBox;
  const projectionDistance = sourceBounds
    ? sourceBounds.getSize(new Vector3()).length()
    : Number.POSITIVE_INFINITY;

  return {
    async bake(simplifiedGeometry, lodLevel, lodTriangles, sourceTriangles) {
      const requestedResolution = chooseBakeResolution(
        maxTextureSize,
        lodTriangles,
        sourceTriangles,
      );
      const unwrapped = await unwrapLodGeometry(simplifiedGeometry, requestedResolution);
      if (!unwrapped) return null;

      try {
        const projection = await buildProjectionMap(
          unwrapped.geometry,
          projectionGeometry,
          bvh,
          unwrapped.width,
          unwrapped.height,
          projectionDistance,
        );
        if (!projection) {
          unwrapped.geometry.dispose();
          return null;
        }

        const bakedMaterial = sourceMaterial.clone();
        bakedMaterial.name = `${sourceMaterial.name || 'material'}_LOD${lodLevel}`;
        const bakedRecord = bakedMaterial as unknown as Record<string, unknown>;
        const bakedTextures = new Map<Texture, Texture>();
        for (const slot of TEXTURE_SLOTS) {
          const sourceTexture = materialRecord[slot];
          if (!(sourceTexture instanceof Texture)) continue;
          let bakedTexture = bakedTextures.get(sourceTexture);
          if (!bakedTexture) {
            const pixels = textures.get(sourceTexture);
            if (!pixels) continue;
            bakedTexture = bakeTexture(pixels, projection, projectionGeometry, lodLevel);
            bakedTextures.set(sourceTexture, bakedTexture);
          }
          bakedRecord[slot] = bakedTexture;
        }
        bakedMaterial.needsUpdate = true;
        return {
          geometry: unwrapped.geometry,
          material: bakedMaterial,
          resolution: Math.max(unwrapped.width, unwrapped.height),
          textureCount: bakedTextures.size,
        };
      } catch {
        unwrapped.geometry.dispose();
        return null;
      }
    },
  };
}

function chooseBakeResolution(
  maxTextureSize: number,
  lodTriangles: number,
  sourceTriangles: number,
): number {
  const maximum = Math.max(64, Math.min(4096, maxTextureSize));
  const texelDensityScale = Math.sqrt(Math.max(0.001, lodTriangles / sourceTriangles));
  const ideal = Math.max(256, maximum * texelDensityScale);
  return Math.min(maximum, 2 ** Math.floor(Math.log2(ideal)));
}

function createProjectionGeometry(source: BufferGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  const position = source.attributes.position;
  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  for (const [name, attribute] of Object.entries(source.attributes)) {
    if (!name.startsWith('uv') || attribute.count !== position.count) continue;
    const values = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) {
      for (let component = 0; component < attribute.itemSize; component++) {
        values[i * attribute.itemSize + component] = attribute.getComponent(i, component);
      }
    }
    geometry.setAttribute(name, new BufferAttribute(values, attribute.itemSize));
  }
  geometry.setIndex(
    new BufferAttribute(Uint32Array.from(source.index!.array as ArrayLike<number>), 1),
  );
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function readTexturePixels(texture: Texture): SourceTexturePixels | null {
  const image = texture.image as
    | (CanvasImageSource & {
        height?: number;
        naturalHeight?: number;
        naturalWidth?: number;
        videoHeight?: number;
        videoWidth?: number;
        width?: number;
      })
    | undefined;
  if (!image) return null;
  const width = image.width || image.naturalWidth || image.videoWidth || 0;
  const height = image.height || image.naturalHeight || image.videoHeight || 0;
  if (!width || !height) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    return {
      texture,
      width,
      height,
      data: context.getImageData(0, 0, width, height).data,
    };
  } catch {
    return null;
  }
}

async function buildProjectionMap(
  lodGeometry: BufferGeometry,
  sourceGeometry: BufferGeometry,
  bvh: MeshBVH,
  width: number,
  height: number,
  maxDistance: number,
): Promise<ProjectionMap | null> {
  const lodIndex = lodGeometry.index;
  const lodPosition = lodGeometry.attributes.position;
  const lodNormal = lodGeometry.attributes.normal;
  const lodUv = lodGeometry.attributes.uv;
  const sourceIndex = sourceGeometry.index;
  const sourcePosition = sourceGeometry.attributes.position;
  if (!lodIndex || !lodPosition || !lodUv || !sourceIndex || !sourcePosition) return null;

  const pixelCount = width * height;
  const faces = new Uint32Array(pixelCount);
  faces.fill(INVALID_FACE);
  const barycentricA = new Float32Array(pixelCount);
  const barycentricB = new Float32Array(pixelCount);

  const point = new Vector3();
  const normal = new Vector3();
  const direction = new Vector3();
  const faceNormal = new Vector3();
  const edgeA = new Vector3();
  const edgeB = new Vector3();
  const ray = new Ray();
  const closestTarget: HitPointInfo = {
    point: new Vector3(),
    distance: 0,
    faceIndex: 0,
  };
  const sourceA = new Vector3();
  const sourceB = new Vector3();
  const sourceC = new Vector3();
  const sourceBarycentric = new Vector3();

  for (let triangle = 0; triangle < lodIndex.count / 3; triangle++) {
    const ia = lodIndex.getX(triangle * 3);
    const ib = lodIndex.getX(triangle * 3 + 1);
    const ic = lodIndex.getX(triangle * 3 + 2);
    const ax = lodUv.getX(ia) * width;
    const ay = lodUv.getY(ia) * height;
    const bx = lodUv.getX(ib) * width;
    const by = lodUv.getY(ib) * height;
    const cx = lodUv.getX(ic) * width;
    const cy = lodUv.getY(ic) * height;
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denominator) < 1e-12) continue;

    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 1));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx) + 1));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy) - 1));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy) + 1));
    const pa = new Vector3(lodPosition.getX(ia), lodPosition.getY(ia), lodPosition.getZ(ia));
    const pb = new Vector3(lodPosition.getX(ib), lodPosition.getY(ib), lodPosition.getZ(ib));
    const pc = new Vector3(lodPosition.getX(ic), lodPosition.getY(ic), lodPosition.getZ(ic));
    edgeA.subVectors(pb, pa);
    edgeB.subVectors(pc, pa);
    faceNormal.crossVectors(edgeA, edgeB).normalize();

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denominator;
        const wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denominator;
        const wc = 1 - wa - wb;
        if (wa < -1e-5 || wb < -1e-5 || wc < -1e-5) continue;

        point.copy(pa).multiplyScalar(wa).addScaledVector(pb, wb).addScaledVector(pc, wc);
        if (lodNormal) {
          normal.set(lodNormal.getX(ia), lodNormal.getY(ia), lodNormal.getZ(ia)).multiplyScalar(wa);
          direction
            .set(lodNormal.getX(ib), lodNormal.getY(ib), lodNormal.getZ(ib))
            .multiplyScalar(wb);
          normal.add(direction);
          direction
            .set(lodNormal.getX(ic), lodNormal.getY(ic), lodNormal.getZ(ic))
            .multiplyScalar(wc);
          normal.add(direction).normalize();
        } else {
          normal.copy(faceNormal);
        }

        let hitPoint: Vector3 | null = null;
        let hitFace = -1;
        // Prefer the nearest source surface. A simplified triangle can sit
        // inside a curved/high-detail shell; normal rays from that point may
        // hit the opposite side first and paint a completely unrelated atlas
        // island (the dark wedges seen on LOD1/LOD2). The closest-point query
        // remains on the local source surface and is the stable reprojection
        // choice. Rays are retained as a fallback for points just outside a
        // thin/open surface where the nearest query exceeds the projection
        // distance.
        const closest = bvh.closestPointToPoint(point, closestTarget);
        if (closest && closest.distance <= maxDistance) {
          hitPoint = closest.point;
          hitFace = closest.faceIndex;
        } else {
          ray.set(point, normal);
          const forwardHit = bvh.raycastFirst(ray, DoubleSide, 1e-7, maxDistance);
          direction.copy(normal).negate();
          ray.set(point, direction);
          const backwardHit = bvh.raycastFirst(ray, DoubleSide, 1e-7, maxDistance);
          const rayHit =
            forwardHit && backwardHit
              ? forwardHit.distance <= backwardHit.distance
                ? forwardHit
                : backwardHit
              : forwardHit || backwardHit;
          if (typeof rayHit?.faceIndex === 'number') {
            hitPoint = rayHit.point;
            hitFace = rayHit.faceIndex;
          }
        }
        if (!hitPoint || hitFace < 0) continue;

        const sa = sourceIndex.getX(hitFace * 3);
        const sb = sourceIndex.getX(hitFace * 3 + 1);
        const sc = sourceIndex.getX(hitFace * 3 + 2);
        sourceA.set(sourcePosition.getX(sa), sourcePosition.getY(sa), sourcePosition.getZ(sa));
        sourceB.set(sourcePosition.getX(sb), sourcePosition.getY(sb), sourcePosition.getZ(sb));
        sourceC.set(sourcePosition.getX(sc), sourcePosition.getY(sc), sourcePosition.getZ(sc));
        if (!Triangle.getBarycoord(hitPoint, sourceA, sourceB, sourceC, sourceBarycentric)) {
          continue;
        }
        const pixel = y * width + x;
        faces[pixel] = hitFace;
        barycentricA[pixel] = sourceBarycentric.x;
        barycentricB[pixel] = sourceBarycentric.y;
      }
    }
    if ((triangle & 7) === 7) await yieldToBrowser();
  }

  // A ray can miss on a broad, aggressively simplified triangle even though
  // the triangle itself is valid in the atlas. A small padding dilation keeps
  // chart edges clean, but leaving larger missed regions as zeroed pixels
  // produces the black/transparent wedges visible on LOD1/LOD2. Expand in a
  // few bounded passes so every atlas sample gets a nearby source mapping;
  // this only fills unused atlas gaps and never changes the mesh UVs.
  dilateProjectionMap(faces, barycentricA, barycentricB, width, height, ATLAS_PADDING);
  const dilationRadii = [16, 64, 255];
  for (const radius of dilationRadii) {
    if (!faces.some((face) => face === INVALID_FACE)) break;
    dilateProjectionMap(faces, barycentricA, barycentricB, width, height, radius);
  }
  return { faces, barycentricA, barycentricB, width, height };
}

function dilateProjectionMap(
  faces: Uint32Array,
  barycentricA: Float32Array,
  barycentricB: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const pixelCount = width * height;
  const queue = new Uint32Array(pixelCount);
  const distance = new Uint8Array(pixelCount);
  let head = 0;
  let tail = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (faces[pixel] !== INVALID_FACE) queue[tail++] = pixel;
  }
  while (head < tail) {
    const pixel = queue[head++];
    const nextDistance = distance[pixel] + 1;
    if (nextDistance > radius) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const neighbors = [
      x > 0 ? pixel - 1 : -1,
      x + 1 < width ? pixel + 1 : -1,
      y > 0 ? pixel - width : -1,
      y + 1 < height ? pixel + width : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || faces[neighbor] !== INVALID_FACE) continue;
      faces[neighbor] = faces[pixel];
      barycentricA[neighbor] = barycentricA[pixel];
      barycentricB[neighbor] = barycentricB[pixel];
      distance[neighbor] = nextDistance;
      queue[tail++] = neighbor;
    }
  }
}

function bakeTexture(
  source: SourceTexturePixels,
  projection: ProjectionMap,
  sourceGeometry: BufferGeometry,
  lodLevel: number,
): Texture {
  const sourceTexture = source.texture;
  const uvName = sourceTexture.channel > 0 ? `uv${sourceTexture.channel}` : 'uv';
  const sourceUv = sourceGeometry.attributes[uvName] ?? sourceGeometry.attributes.uv;
  const sourceIndex = sourceGeometry.index!;
  sourceTexture.updateMatrix();
  const transform = sourceTexture.matrix.elements;

  const canvas = document.createElement('canvas');
  canvas.width = projection.width;
  canvas.height = projection.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('could not create texture bake canvas');
  const output = context.createImageData(projection.width, projection.height);
  const rgba = output.data;

  for (let pixel = 0; pixel < projection.faces.length; pixel++) {
    const face = projection.faces[pixel];
    if (face === INVALID_FACE) continue;
    const ia = sourceIndex.getX(face * 3);
    const ib = sourceIndex.getX(face * 3 + 1);
    const ic = sourceIndex.getX(face * 3 + 2);
    const wa = projection.barycentricA[pixel];
    const wb = projection.barycentricB[pixel];
    const wc = 1 - wa - wb;
    const u = sourceUv.getX(ia) * wa + sourceUv.getX(ib) * wb + sourceUv.getX(ic) * wc;
    const v = sourceUv.getY(ia) * wa + sourceUv.getY(ib) * wb + sourceUv.getY(ic) * wc;
    const transformedU = transform[0] * u + transform[3] * v + transform[6];
    let transformedV = transform[1] * u + transform[4] * v + transform[7];
    if (sourceTexture.flipY) transformedV = 1 - transformedV;
    sampleBilinear(source, transformedU, transformedV, rgba, pixel * 4);
  }
  context.putImageData(output, 0, 0);

  const baked = sourceTexture.clone();
  baked.name = `${sourceTexture.name || 'texture'}_LOD${lodLevel}_baked`;
  // Texture.clone() deliberately shares Texture.source. A dedicated Source is
  // required here or the last LOD bake replaces every earlier atlas (and LOD0).
  baked.source = new Source(canvas);
  baked.channel = 0;
  baked.flipY = false;
  baked.wrapS = ClampToEdgeWrapping;
  baked.wrapT = ClampToEdgeWrapping;
  baked.offset.set(0, 0);
  baked.repeat.set(1, 1);
  baked.center.set(0, 0);
  baked.rotation = 0;
  baked.matrixAutoUpdate = true;
  if (baked.mipmaps) baked.mipmaps.length = 0;
  baked.needsUpdate = true;
  return baked;
}

function sampleBilinear(
  source: SourceTexturePixels,
  inputU: number,
  inputV: number,
  output: Uint8ClampedArray,
  outputOffset: number,
): void {
  const u = wrapCoordinate(inputU, source.texture.wrapS);
  const v = wrapCoordinate(inputV, source.texture.wrapT);
  const x = u * source.width - 0.5;
  const y = v * source.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const ix0 = wrapPixel(x0, source.width, source.texture.wrapS);
  const ix1 = wrapPixel(x1, source.width, source.texture.wrapS);
  const iy0 = wrapPixel(y0, source.height, source.texture.wrapT);
  const iy1 = wrapPixel(y1, source.height, source.texture.wrapT);
  const p00 = (iy0 * source.width + ix0) * 4;
  const p10 = (iy0 * source.width + ix1) * 4;
  const p01 = (iy1 * source.width + ix0) * 4;
  const p11 = (iy1 * source.width + ix1) * 4;
  for (let channel = 0; channel < 4; channel++) {
    const top = source.data[p00 + channel] * (1 - tx) + source.data[p10 + channel] * tx;
    const bottom = source.data[p01 + channel] * (1 - tx) + source.data[p11 + channel] * tx;
    output[outputOffset + channel] = Math.round(top * (1 - ty) + bottom * ty);
  }
}

function wrapCoordinate(value: number, wrapping: number): number {
  if (wrapping === RepeatWrapping) return value - Math.floor(value);
  if (wrapping === MirroredRepeatWrapping) {
    const period = Math.floor(value);
    const fraction = value - period;
    return Math.abs(period) % 2 === 1 ? 1 - fraction : fraction;
  }
  return Math.max(0, Math.min(1, value));
}

function wrapPixel(value: number, size: number, wrapping: number): number {
  if (wrapping === RepeatWrapping) return ((value % size) + size) % size;
  return Math.max(0, Math.min(size - 1, value));
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
