/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLOUDFLARE_PLAYBACK_URL?: string;
  readonly VITE_CLOUDFLARE_WHIP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
