/**
 * 教材フォルダ (ADR-0051) の純粋なモジュール群。UI・File System Access API・IndexedDB には触れない。
 */

export * from './copyProblem.js';
export * from './definitions.js';
export * from './examBundle.js';
export * from './paths.js';
export type { WorkspaceReader } from './reader.js';
