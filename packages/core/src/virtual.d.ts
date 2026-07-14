// Virtual modules provided by the storylark-core Vite preset
// (defineStorylarkConfig in ../vite/index.mjs).
declare module 'virtual:storylark-config' {
  import type { Brand } from './lib/types';
  const config: Brand;
  export default config;
}

// Side-effect module: @fontsource imports generated from the brand's `fonts`.
declare module 'virtual:storylark-fonts';
