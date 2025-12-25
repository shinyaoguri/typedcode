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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
