/**
 * Monaco 同梱の TypeScript worker で TS を JS に transpile する (#605)
 *
 * 以前は `typescript` パッケージの `transpileModule` を editor のバンドルに入れていた (約 3.6 MB)。
 * Monaco は言語機能のために同じコンパイラを worker に持っているので、それに emit させる。
 * 型チェックはしない (構文の診断だけを返す = 以前の transpileModule と同等)。
 * compilerOptions は Monaco の既定 (`typescriptDefaults`。target ESNext) のままで、top-level await は残る
 * (実行側の JS sandbox が対応している)。
 */

import * as monaco from 'monaco-editor';
import type { TranspileDiagnostic } from './transpileDiagnostics.js';

export interface MonacoTranspileResult {
  outputText: string;
  /** 構文の診断 (型の診断は含まない) */
  diagnostics: TranspileDiagnostic[];
}

let modelSeq = 0;

/**
 * 使い捨てのモデルを作って worker に transpile させる。モデルは必ず dispose する。
 * `getTypeScriptWorker` は typescript 言語の setup より前だと reject するが、setup は
 * typescript のモデルが初めて作られたときに走るので、モデルを先に作ってから呼ぶ。
 */
export async function transpileWithMonaco(code: string): Promise<MonacoTranspileResult> {
  modelSeq++;
  const uri = monaco.Uri.parse(`inmemory://typedcode-run/${modelSeq}.ts`);
  const model = monaco.editor.createModel(code, 'typescript', uri);
  try {
    const getWorker = await monaco.typescript.getTypeScriptWorker();
    const worker = await getWorker(uri);
    const fileName = uri.toString();
    const diagnostics = await worker.getSyntacticDiagnostics(fileName);
    const emit = await worker.getEmitOutput(fileName);
    const jsFile = emit.outputFiles.find((f) => f.name.endsWith('.js'));
    return {
      outputText: jsFile?.text ?? '',
      diagnostics,
    };
  } finally {
    model.dispose();
  }
}
