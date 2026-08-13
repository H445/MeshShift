declare module 'virtual:meshshift-assimp' {
  const factory: (options?: { locateFile?: (file: string) => string }) => Promise<unknown>;
  export default factory;
}
