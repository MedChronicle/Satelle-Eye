/// <reference types="vite/client" />

declare const __APP_MODE__: string
declare const __BUILD_TIME__: string

interface ImportMetaEnv {
  readonly VITE_PORT?: string
  readonly VITE_HOST?: string
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
