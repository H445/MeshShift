/**
 * Tiny three.js viewer factory. Used for both panes (input + output preview).
 * Features:
 *  - Neutral multi-source lighting (ambient + hemisphere + 3-point directional)
 *  - PMREM environment for PBR reflections
 *  - Idle auto-rotation ("turnstyle") that pauses on user interaction
 *    and resumes after a few seconds of inactivity
 *
 * Designed to be robust: no shadow setup, no ground plane, no model
 * repositioning. The camera framing is simple and predictable — it just
 * frames whatever you put in, no matter the coordinate system.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { DetailPin } from '../../shared/options.js';

export interface DetailPinPick {
  meshKey: string;
  meshName: string;
  lodLevel: number;
  position: [number, number, number];
}

export interface ViewerFrameSample {
  fps: number;
  frameMs: number;
}

export interface ViewerHandle {
  setScene(root: THREE.Object3D): void;
  /** Render the current scene into a regular 2D canvas for a lightweight snapshot. */
  captureSnapshot(targetCanvas: HTMLCanvasElement): boolean;
  clear(): void;
  resize(): void;
  dispose(): void;
  /** Snap to a world-axis audit view and lock orbit rotation until cleared. */
  setAxisLock(axis: ViewerAxis): void;
  /** Returns the currently locked world axis, or null for free orbiting. */
  getAxisLock(): ViewerAxis;
  /** Subscribe to lock changes, including an automatic unlock on drag. */
  onAxisLockChange(listener: (axis: ViewerAxis) => void): () => void;
  /** Toggle wireframe rendering on the current scene. */
  setWireframe(on: boolean): void;
  /** Returns the current wireframe state. */
  isWireframe(): boolean;
  /** Enable/disable idle auto-rotation for this viewer. */
  setAutoRotate(enabled: boolean): void;
  /** Returns whether idle auto-rotation is enabled. */
  isAutoRotate(): boolean;
  /** Subscribe to one-second render cadence samples for adaptive previews. */
  onPerformanceSample(listener: (sample: ViewerFrameSample) => void): () => void;
  /**
   * Enable click-to-pin interaction. Model clicks place pins while empty-space
   * drags and wheel gestures remain available for orbiting and zooming.
   */
  setDetailPinEditMode(enabled: boolean): void;
  isDetailPinEditMode(): boolean;
  /** Render persistent pin markers over the solid or wireframe model. */
  setDetailPins(pins: readonly DetailPin[]): void;
  /** Highlight one persistent pin marker, or clear the current selection. */
  setSelectedDetailPin(pinId: string | null): void;
  /** Subscribe to snapped mesh-vertex picks while detail-pin editing is active. */
  onDetailPointPick(listener: (pick: DetailPinPick) => void): () => void;
}

export type ViewerAxis = 'x' | 'y' | 'z' | null;

const IDLE_ROTATE_DELAY_MS = 2500;
const IDLE_ROTATE_SPEED = 0.35; // rad/s
const MAX_PREVIEW_DEVICE_PIXEL_RATIO = 1.5;
const MAX_PREVIEW_RENDER_PIXELS = 1_200_000;

export function createViewer(canvas: HTMLCanvasElement): ViewerHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral tone mapping preserves texture contrast much more faithfully than
  // the previous bright ACES setup. That setup made scan noise nearly
  // invisible in the browser even though the lossless exported texture still
  // contained it, so an FBX opened in a DCC appeared to have changed.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new THREE.Scene();
  scene.background = null; // CSS gradient shows through

  const pmrem = new THREE.PMREMGenerator(renderer);
  const environmentTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = environmentTarget.texture;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(2, 1.5, 2.5);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.minDistance = 0.2;
  controls.maxDistance = 50;

  // --- Neutral multi-source lighting (no shadows) -------------------------
  // Keep the summed diffuse energy near a conventional studio preview. This
  // still makes unlit sides readable without washing out base-color detail.
  const hemi = new THREE.HemisphereLight(0xc8d4ff, 0x2a2f3a, 0.35);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xffffff, 0.15);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(4, 6, 5);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9ec5ff, 0.3);
  fill.position.set(-5, 3, -3);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffe6c8, 0.25);
  rim.position.set(0, 4, -6);
  scene.add(rim);

  // Content root — we put the FBX / GLTF scene here.
  const root = new THREE.Group();
  scene.add(root);
  let detailPins: readonly DetailPin[] = [];
  let selectedDetailPinId: string | null = null;
  let detailPinEditMode = false;
  let detailPinMarkers: THREE.Group | null = null;
  let detailPinHoverMarker: THREE.Mesh | null = null;
  const detailPointListeners = new Set<(pick: DetailPinPick) => void>();
  const pinRaycaster = new THREE.Raycaster();
  const pinPointer = new THREE.Vector2();
  let pinPointerStart: { x: number; y: number } | null = null;

  // Wireframe state — toggled by setWireframe(). Applied to every
  // material on every setScene() so the new scene picks up the state.
  let wireframe = false;
  function applyWireframe(scope: THREE.Object3D) {
    scope.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.userData.__detailPinMarker) return;
      if (!m.material) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        // `wireframe` is supported on every built-in material.
        (mat as { wireframe?: boolean }).wireframe = wireframe;
        mat.needsUpdate = true;
      }
    });
  }

  function disposeDetailPinMarkers(): void {
    if (!detailPinMarkers) return;
    root.remove(detailPinMarkers);
    disposeObject(detailPinMarkers);
    detailPinMarkers = null;
  }

  function disposeDetailPinHoverMarker(): void {
    if (!detailPinHoverMarker) return;
    root.remove(detailPinHoverMarker);
    disposeObject(detailPinHoverMarker);
    detailPinHoverMarker = null;
  }

  function detailPinMarkerRadius(): number {
    root.updateWorldMatrix(true, true);
    const contentBounds = new THREE.Box3();
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && !mesh.userData.__detailPinMarker) {
        contentBounds.expandByObject(mesh);
      }
    });
    const size = contentBounds.getSize(new THREE.Vector3());
    return Math.max(1e-5, Math.max(size.x, size.y, size.z) * 0.012);
  }

  function refreshDetailPinMarkers(): void {
    disposeDetailPinMarkers();
    if (detailPins.length === 0 || root.children.length === 0) return;
    const markerRadius = detailPinMarkerRadius();
    const markers = new THREE.Group();
    markers.name = 'MeshShift detail pins';
    markers.userData.__detailPinMarker = true;

    for (const pin of detailPins) {
      const candidateMeshes: THREE.Mesh[] = [];
      root.traverse((object) => {
        if ((object as THREE.Mesh).isMesh && object.userData.meshShiftMeshKey === pin.meshKey) {
          candidateMeshes.push(object as THREE.Mesh);
        }
      });
      const targetMesh =
        candidateMeshes.find((mesh) => !mesh.name.match(/_LOD\d+$/i)) ?? candidateMeshes[0];
      if (!targetMesh) continue;

      const localPoint = new THREE.Vector3(...pin.position);
      const rootPoint = root.worldToLocal(targetMesh.localToWorld(localPoint));
      const selected = selectedDetailPinId === pin.id;
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(markerRadius * (selected ? 1.45 : 1), 12, 8),
        new THREE.MeshBasicMaterial({
          color: selected ? 0xffe06b : 0x39c5ff,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      marker.position.copy(rootPoint);
      marker.renderOrder = 10_000;
      marker.name = `Detail pin ${pin.id}`;
      marker.userData.__detailPinMarker = true;
      marker.userData.detailPinId = pin.id;
      markers.add(marker);
    }
    detailPinMarkers = markers;
    root.add(markers);
  }

  // --- Idle auto-rotation ------------------------------------------------
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let autoRotateEnabled = !reducedMotion;
  let autoRotate = !reducedMotion;
  let lastUserInteraction = 0;
  let axisLock: ViewerAxis = null;
  const axisLockListeners = new Set<(axis: ViewerAxis) => void>();
  const performanceListeners = new Set<(sample: ViewerFrameSample) => void>();
  function notifyUser() {
    autoRotate = false;
    lastUserInteraction = performance.now();
  }

  function detailPinIntersection(clientX: number, clientY: number): THREE.Intersection | undefined {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    pinPointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    pinRaycaster.setFromCamera(pinPointer, camera);
    return pinRaycaster
      .intersectObjects(root.children, true)
      .find(
        (intersection) =>
          (intersection.object as THREE.Mesh).isMesh &&
          intersection.object.visible &&
          !intersection.object.userData.__detailPinMarker &&
          typeof intersection.object.userData.meshShiftMeshKey === 'string',
      );
  }

  function nearestDetailPoint(
    clientX: number,
    clientY: number,
  ): { pick: DetailPinPick; rootPoint: THREE.Vector3 } | undefined {
    const hit = detailPinIntersection(clientX, clientY);
    const mesh = hit?.object as THREE.Mesh | undefined;
    const face = hit?.face;
    const position = mesh?.geometry?.attributes.position;
    if (!hit || !mesh || !face || !position) return undefined;

    const hitLocal = mesh.worldToLocal(hit.point.clone());
    const vertices = [face.a, face.b, face.c];
    let nearestVertex = vertices[0];
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const vertex of vertices) {
      const dx = position.getX(vertex) - hitLocal.x;
      const dy = position.getY(vertex) - hitLocal.y;
      const dz = position.getZ(vertex) - hitLocal.z;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestVertex = vertex;
      }
    }

    const localPoint = new THREE.Vector3(
      position.getX(nearestVertex),
      position.getY(nearestVertex),
      position.getZ(nearestVertex),
    );
    const lodMatch = /_LOD(\d+)$/i.exec(mesh.name);
    return {
      pick: {
        meshKey: mesh.userData.meshShiftMeshKey as string,
        meshName: mesh.name.replace(/_LOD\d+$/i, '') || 'mesh',
        lodLevel: lodMatch ? Number(lodMatch[1]) : 0,
        position: [localPoint.x, localPoint.y, localPoint.z],
      },
      rootPoint: root.worldToLocal(mesh.localToWorld(localPoint)),
    };
  }

  function updateDetailPinHoverMarker(clientX: number, clientY: number): void {
    const point = detailPinEditMode ? nearestDetailPoint(clientX, clientY) : undefined;
    if (!point) {
      disposeDetailPinHoverMarker();
      return;
    }

    if (!detailPinHoverMarker) {
      const markerRadius = detailPinMarkerRadius();
      detailPinHoverMarker = new THREE.Mesh(
        new THREE.SphereGeometry(1, 12, 8),
        new THREE.MeshBasicMaterial({
          color: 0xffc857,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      detailPinHoverMarker.userData.__detailPinMarker = true;
      detailPinHoverMarker.name = 'MeshShift detail pin hover';
      detailPinHoverMarker.renderOrder = 10_001;
      detailPinHoverMarker.scale.setScalar(markerRadius * 1.55);
      root.add(detailPinHoverMarker);
    }
    detailPinHoverMarker.position.copy(point.rootPoint);
  }

  function handlePointerDown(event: PointerEvent) {
    if (detailPinEditMode) {
      const hit = detailPinIntersection(event.clientX, event.clientY);
      pinPointerStart = hit ? { x: event.clientX, y: event.clientY } : null;
      // A model-surface gesture belongs to the pin editor. Empty-space drags
      // continue through to OrbitControls when the view is in Free mode.
      controls.enableRotate = !hit && axisLock === null;
      return;
    }
    // A lock is an audit pose, not a drag trap. The first orbit gesture
    // immediately returns this viewer to free rotation.
    if (axisLock !== null) setAxisLock(null);
    notifyUser();
  }
  function handlePointerUp(event: PointerEvent): void {
    if (!detailPinEditMode) return;
    const pointerStart = pinPointerStart;
    pinPointerStart = null;
    controls.enableRotate = axisLock === null;
    if (!pointerStart) return;
    const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
    if (moved > 5) return;

    const point = nearestDetailPoint(event.clientX, event.clientY);
    if (!point) return;
    for (const listener of detailPointListeners) listener(point.pick);
  }
  function handlePointerCancel(): void {
    pinPointerStart = null;
    controls.enableRotate = axisLock === null;
  }
  function handlePointerMove(event: PointerEvent): void {
    updateDetailPinHoverMarker(event.clientX, event.clientY);
  }
  function handlePointerLeave(): void {
    disposeDetailPinHoverMarker();
  }
  controls.addEventListener('start', notifyUser);
  canvas.addEventListener('pointerdown', handlePointerDown, { capture: true });
  canvas.addEventListener('pointerup', handlePointerUp, { capture: true });
  canvas.addEventListener('pointercancel', handlePointerCancel, { capture: true });
  canvas.addEventListener('pointermove', handlePointerMove, { capture: true });
  canvas.addEventListener('pointerleave', handlePointerLeave, { capture: true });
  canvas.addEventListener('wheel', notifyUser, { passive: true });
  canvas.addEventListener('touchstart', notifyUser, { passive: true });
  const idleTimer = window.setInterval(() => {
    if (
      autoRotateEnabled &&
      !autoRotate &&
      performance.now() - lastUserInteraction > IDLE_ROTATE_DELAY_MS
    ) {
      autoRotate = true;
    }
  }, 500);

  let sampledFrameCount = 0;
  let sampleWindowStart = performance.now();
  let raf = 0;
  let lastFrame = performance.now();
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    if (autoRotate && axisLock === null) {
      root.rotation.y += IDLE_ROTATE_SPEED * dt;
    }

    // Hidden panes still own a WebGL context, but rendering them every frame
    // wastes GPU time while the user is looking at the other pane. This is
    // especially noticeable after a large source scene has been loaded.
    if (!canvas.hidden && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      controls.update();
      renderer.render(scene, camera);
      sampledFrameCount += 1;
      if (now - sampleWindowStart >= 1000) {
        const sample = {
          fps: (sampledFrameCount * 1000) / (now - sampleWindowStart),
          frameMs: (now - sampleWindowStart) / sampledFrameCount,
        };
        sampledFrameCount = 0;
        sampleWindowStart = now;
        for (const listener of performanceListeners) listener(sample);
      }
    } else {
      // Do not let time spent hidden turn the first visible sample into a
      // false low-FPS reading.
      sampledFrameCount = 0;
      sampleWindowStart = now;
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // Resize handling
  const ro = new ResizeObserver(() => handleResize());
  ro.observe(canvas);

  function handleResize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return;
    const nativePixelRatio = window.devicePixelRatio || 1;
    const pixelBudgetRatio = Math.sqrt(MAX_PREVIEW_RENDER_PIXELS / (w * h));
    renderer.setPixelRatio(
      Math.min(nativePixelRatio, MAX_PREVIEW_DEVICE_PIXEL_RATIO, pixelBudgetRatio),
    );
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  handleResize();

  // Simple, robust camera framing.
  // Uses world-space bounds, frames the target in the middle of the view,
  // and never touches the model itself.
  function frameContent(viewAxis: ViewerAxis = null) {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    // Frame so the longest dimension fills ~70% of the view, with padding.
    const fov = (camera.fov * Math.PI) / 180;
    const fitDist = maxDim / 2 / Math.tan(fov / 2) / 0.7;

    // Free orbit starts from a 3/4 view. Axis locks use a world-axis camera
    // position so every LOD can be audited from repeatable, comparable views.
    const dir =
      viewAxis === 'x'
        ? new THREE.Vector3(1, 0, 0)
        : viewAxis === 'y'
          ? new THREE.Vector3(0, 1, 0)
          : viewAxis === 'z'
            ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0.85, 0.45, 1).normalize();
    camera.up.set(0, 1, 0);
    // A top view cannot use the default Y-up vector because it is parallel
    // to the view direction. Z-up keeps the top audit view upright.
    if (viewAxis === 'y') camera.up.set(0, 0, -1);
    camera.position.copy(center.clone().add(dir.multiplyScalar(fitDist)));
    controls.target.copy(center);
    camera.near = Math.max(0.01, fitDist / 1000);
    camera.far = fitDist * 100;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    controls.update();
  }

  function setAxisLock(nextAxis: ViewerAxis) {
    const changed = axisLock !== nextAxis;
    axisLock = nextAxis;
    root.rotation.set(0, 0, 0);
    controls.enableRotate = nextAxis === null;
    autoRotate = false;
    lastUserInteraction = performance.now();
    frameContent(nextAxis);
    if (changed) {
      for (const listener of axisLockListeners) listener(axisLock);
    }
  }

  return {
    setScene(sceneToShow: THREE.Object3D) {
      disposeDetailPinMarkers();
      disposeDetailPinHoverMarker();
      while (root.children.length) {
        const c = root.children[0];
        root.remove(c);
        disposeObject(c);
      }
      root.rotation.set(0, 0, 0);

      // Material hardening — FBX files (especially those exported by
      // assimp) frequently arrive with:
      //   - FrontSide rendering + mixed normals (=> black silhouette)
      //   - diffuse color (0,0,0) when the material was meant to come
      //     from a texture that didn't transfer
      //   - missing or broken texture references
      // We make every material robust against all three so the preview
      // is always visible, even if the FBX is imperfect.
      sceneToShow.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh || !m.material) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          // Force two-sided rendering — the #1 cause of black silhouettes
          // in FBX previews is mixed/inverted normals.
          mat.side = THREE.DoubleSide;

          // Make sure sRGB is set on any texture maps. three.js auto-detects
          // this for most loaders, but FBX-inherited materials can be off.
          const phongLike = mat as THREE.MeshPhongMaterial;
          if (phongLike.map) phongLike.map.colorSpace = THREE.SRGBColorSpace;
          const standardLike = mat as THREE.MeshStandardMaterial;
          if (standardLike.map) standardLike.map.colorSpace = THREE.SRGBColorSpace;
          if (standardLike.emissiveMap) standardLike.emissiveMap.colorSpace = THREE.SRGBColorSpace;

          // FBX-output-assimp workaround: assimp's FBX exporter sometimes
          // writes a texture REFERENCE but no image data, which makes the
          // GLSL sampler return (0,0,0) and the material render black.
          // If the material's color is white (the default) and we detect a
          // texture is referenced but its image hasn't loaded, we can't
          // tell yet whether the texture will be valid once it loads. As a
          // safe fallback for the OUTPUT-only case, the viewer shows a
          // procedural color derived from the material name. This way the
          // geometry is at least visible — better than a black silhouette.
          const col = (mat as { color?: THREE.Color }).color;
          if (col && col.r + col.g + col.b < 0.05) {
            col.setRGB(0.7, 0.7, 0.7);
          }
          if (col && mat.userData.__proceduralColor) {
            const pc = mat.userData.__proceduralColor as THREE.Color;
            col.copy(pc);
          }

          mat.needsUpdate = true;
        }
      });

      root.add(sceneToShow);
      // Apply the current wireframe state to the new scene's materials.
      applyWireframe(sceneToShow);
      refreshDetailPinMarkers();
      frameContent(axisLock);
    },
    captureSnapshot(targetCanvas: HTMLCanvasElement) {
      if (root.children.length === 0) return false;
      handleResize();
      if (renderer.domElement.width === 0 || renderer.domElement.height === 0) return false;
      controls.update();
      renderer.render(scene, camera);
      const context = targetCanvas.getContext('2d');
      if (!context) return false;
      targetCanvas.width = renderer.domElement.width;
      targetCanvas.height = renderer.domElement.height;
      context.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      context.drawImage(renderer.domElement, 0, 0, targetCanvas.width, targetCanvas.height);
      return true;
    },
    setAxisLock,
    getAxisLock() {
      return axisLock;
    },
    onAxisLockChange(listener) {
      axisLockListeners.add(listener);
      return () => axisLockListeners.delete(listener);
    },
    setWireframe(on: boolean) {
      if (on === wireframe) return;
      wireframe = on;
      applyWireframe(root);
    },
    isWireframe() {
      return wireframe;
    },
    setAutoRotate(enabled: boolean) {
      autoRotateEnabled = enabled;
      autoRotate = enabled;
      lastUserInteraction = performance.now();
    },
    isAutoRotate() {
      return autoRotateEnabled;
    },
    onPerformanceSample(listener) {
      performanceListeners.add(listener);
      return () => performanceListeners.delete(listener);
    },
    setDetailPinEditMode(enabled: boolean) {
      detailPinEditMode = enabled;
      pinPointerStart = null;
      if (!enabled) disposeDetailPinHoverMarker();
      controls.enabled = true;
      controls.enableRotate = axisLock === null;
      canvas.classList.toggle('detail-pin-editing', enabled);
      if (enabled) {
        autoRotate = false;
        lastUserInteraction = performance.now();
      }
    },
    isDetailPinEditMode() {
      return detailPinEditMode;
    },
    setDetailPins(pins: readonly DetailPin[]) {
      detailPins = pins.map((pin) => ({
        ...pin,
        position: [...pin.position] as [number, number, number],
      }));
      if (!detailPins.some((pin) => pin.id === selectedDetailPinId)) {
        selectedDetailPinId = null;
      }
      refreshDetailPinMarkers();
    },
    setSelectedDetailPin(pinId: string | null) {
      if (pinId !== null && !detailPins.some((pin) => pin.id === pinId)) return;
      if (selectedDetailPinId === pinId) return;
      selectedDetailPinId = pinId;
      refreshDetailPinMarkers();
    },
    onDetailPointPick(listener) {
      detailPointListeners.add(listener);
      return () => detailPointListeners.delete(listener);
    },
    clear() {
      disposeDetailPinMarkers();
      disposeDetailPinHoverMarker();
      while (root.children.length) {
        const c = root.children[0];
        root.remove(c);
        disposeObject(c);
      }
    },
    resize: handleResize,
    dispose() {
      cancelAnimationFrame(raf);
      window.clearInterval(idleTimer);
      ro.disconnect();
      controls.removeEventListener('start', notifyUser);
      performanceListeners.clear();
      canvas.removeEventListener('pointerdown', handlePointerDown, true);
      canvas.removeEventListener('pointerup', handlePointerUp, true);
      canvas.removeEventListener('pointercancel', handlePointerCancel, true);
      canvas.removeEventListener('pointermove', handlePointerMove, true);
      canvas.removeEventListener('pointerleave', handlePointerLeave, true);
      canvas.removeEventListener('wheel', notifyUser);
      canvas.removeEventListener('touchstart', notifyUser);
      disposeObject(root);
      environmentTarget.dispose();
      pmrem.dispose();
      controls.dispose();
      renderer.dispose();
      axisLockListeners.clear();
      detailPointListeners.clear();
    },
  };
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    const materials = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const material of materials) {
      // A viewer can replace the output scene many times during LOD audits.
      // Disposing only materials leaves their decoded atlas textures and GPU
      // allocations behind, eventually crashing the tab after a few previews.
      const record = material as unknown as Record<string, unknown>;
      for (const value of Object.values(record)) {
        if (value && typeof value === 'object' && 'isTexture' in value) {
          (value as THREE.Texture).dispose();
        }
      }
      material.dispose();
    }
  });
}
