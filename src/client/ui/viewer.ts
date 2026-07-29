/**
 * Tiny three.js viewer factory. Used for both panes (input + output preview).
 * Features:
 *  - Bright multi-source lighting (ambient + hemisphere + 3-point directional)
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

export interface ViewerHandle {
  setScene(root: THREE.Object3D): void;
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
}

export type ViewerAxis = 'x' | 'y' | 'z' | null;

const IDLE_ROTATE_DELAY_MS = 2500;
const IDLE_ROTATE_SPEED = 0.35; // rad/s

export function createViewer(canvas: HTMLCanvasElement): ViewerHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  const scene = new THREE.Scene();
  scene.background = null; // CSS gradient shows through

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(2, 1.5, 2.5);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.minDistance = 0.2;
  controls.maxDistance = 50;

  // --- Bright multi-source lighting (no shadows) --------------------------
  const hemi = new THREE.HemisphereLight(0xc8d4ff, 0x2a2f3a, 0.7);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(4, 6, 5);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9ec5ff, 0.8);
  fill.position.set(-5, 3, -3);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffe6c8, 0.6);
  rim.position.set(0, 4, -6);
  scene.add(rim);

  // Content root — we put the FBX / GLTF scene here.
  const root = new THREE.Group();
  scene.add(root);

  // Wireframe state — toggled by setWireframe(). Applied to every
  // material on every setScene() so the new scene picks up the state.
  let wireframe = false;
  function applyWireframe(scope: THREE.Object3D) {
    scope.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.material) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        // `wireframe` is supported on every built-in material.
        (mat as { wireframe?: boolean }).wireframe = wireframe;
        mat.needsUpdate = true;
      }
    });
  }

  // --- Idle auto-rotation ------------------------------------------------
  let autoRotateEnabled = true;
  let autoRotate = true;
  let lastUserInteraction = 0;
  let axisLock: ViewerAxis = null;
  const axisLockListeners = new Set<(axis: ViewerAxis) => void>();
  function notifyUser() {
    autoRotate = false;
    lastUserInteraction = performance.now();
  }
  function handlePointerDown() {
    // A lock is an audit pose, not a drag trap. The first orbit gesture
    // immediately returns this viewer to free rotation.
    if (axisLock !== null) setAxisLock(null);
    notifyUser();
  }
  controls.addEventListener('start', notifyUser);
  canvas.addEventListener('pointerdown', handlePointerDown, { capture: true });
  canvas.addEventListener('wheel', notifyUser, { passive: true });
  canvas.addEventListener('touchstart', notifyUser, { passive: true });
  setInterval(() => {
    if (
      autoRotateEnabled &&
      !autoRotate &&
      performance.now() - lastUserInteraction > IDLE_ROTATE_DELAY_MS
    ) {
      autoRotate = true;
    }
  }, 500);

  let raf = 0;
  let lastFrame = performance.now();
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    if (autoRotate && axisLock === null) {
      root.rotation.y += IDLE_ROTATE_SPEED * dt;
    }

    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // Resize handling
  const ro = new ResizeObserver(() => handleResize());
  ro.observe(canvas);

  function handleResize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return;
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
      frameContent(axisLock);
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
    clear() {
      while (root.children.length) {
        const c = root.children[0];
        root.remove(c);
        disposeObject(c);
      }
    },
    resize: handleResize,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      pmrem.dispose();
      controls.dispose();
      renderer.dispose();
      root.traverse(disposeObject);
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
