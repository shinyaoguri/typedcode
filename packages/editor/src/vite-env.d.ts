/// <reference types="vite/client" />

// Vite Worker imports
declare module '*?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module 'monaco-editor/esm/vs/language/json/json.worker?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module 'monaco-editor/esm/vs/language/css/css.worker?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module 'monaco-editor/esm/vs/language/html/html.worker?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module 'monaco-editor/esm/vs/language/typescript/ts.worker?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
  // reCAPTCHA v3 configuration
  readonly VITE_RECAPTCHA_SITE_KEY?: string;
  readonly VITE_API_URL?: string;
  /**
   * E2E 専用 (dev ビルドのみ読む)。起動時の空き容量の試験で書く量 (bytes) を小さくする (#626)。
   * 本番ビルドでは読まない (`services/StorageCapacityProbe.ts` の `import.meta.env.DEV` のガードごと除去される)
   */
  readonly VITE_STORAGE_PROBE_BYTES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
