/**
 * Content Security Policy for the packaged renderer.
 *
 * Three.js' ImageBitmapLoader decodes embedded model textures by fetching
 * temporary blob/data URLs. Those URLs therefore belong in `connect-src` as
 * well as `img-src`; omitting them leaves geometry visible but materials white
 * in the desktop preview.
 */
export const DESKTOP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  // Assimp's generated Emscripten bindings use Function constructors. The
  // renderer still loads only packaged code; this is the narrow, documented
  // exception required by the vendored runtime.
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
].join('; ');
