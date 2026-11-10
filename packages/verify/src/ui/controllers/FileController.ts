/**
 * FileController - ファイル処理を担当するコントローラー
 */
import type { FileProcessor, ParsedFileData } from '../../services/FileProcessor';
import type { ScreenshotService } from '../../services/ScreenshotService';
import type { VerifyTabManager } from '../../state/VerifyTabManager';
import type { UIStateManager } from '../../state/UIStateManager';
import type { VerificationQueue } from '../../state/VerificationQueue';
import type { Sidebar } from '../Sidebar';
import type { StatusBarUI } from '../StatusBarUI';
import type { ProofFile, VerifyScreenshot, ContentMismatchInfo, VerifyTabState } from '../../types';
import { t } from '../../i18n/index';
import { DiffService } from '../../services/DiffService';
import { examPackageErrorKey } from '../../services/examPackageError';
import {
  isProofFile,
  isSubmissionSourceEntry,
  matchSubmissionSources,
  normalizeProofLanguage,
  parseExamPackageManifestResult,
  submissionSeverity,
  type ExamPackageManifest,
} from '@typedcode/shared';
import type { FileStatus } from '../Sidebar';
import type { TabStatus } from '../TabBar';

/** 隠し file input を開いて 1 ファイルを返す (キャンセルは null)。 */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const done = (f: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    // キャンセル検出 (フォーカス復帰時に change が来なければ null)
    window.addEventListener('focus', () => setTimeout(() => done(null), 300), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** proof として読めたか (#292)。読めなければ、タブ / 行に出すエラー文言を持つ。 */
type ProofReading = { ok: true; proofData: ProofFile } | { ok: false; error: string };

/** rawData を proof として読む。JSON 破損と proof 構造なしを区別したエラー文言にする (#292)。 */
function readProof(filename: string, rawData: string): ProofReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch (error) {
    console.error('Error parsing JSON:', error);
    return { ok: false, error: t('errors.jsonParseError', { filename }) };
  }
  if (!isProofFile(parsed)) return { ok: false, error: t('errors.proofNotAProof', { filename }) };
  return { ok: true, proofData: parsed as unknown as ProofFile };
}

/**
 * 取り込み時にコンテナ (ZIP・フォルダ) が渡した入力。proof の中身からは決まらないので、
 * 外部更新で同じタブを取り込み直すときはこれを使い回し、proof 由来の状態だけを取り直す (#695)。
 */
interface ImportInput {
  /** 取り込んだときのファイル名 (照合の path・エラー文言・キューの filename) */
  filename: string;
  folderId?: string;
  screenshots?: VerifyScreenshot[];
  /** コンテナが渡した記録開始時刻。無ければ proof から計算する */
  startTimestamp?: number;
}

/**
 * proof タブの状態のうち、取り込んだ proof (と取り込みの入力) から決まるもの一式。
 * 初回取り込みも外部更新もこれで組み立てる (#695)。一部だけ差し替えると、表示する本文と
 * 検証した証明が別物になる (古い proofData と新しい検証結果が混ざる)。
 */
function proofSnapshot(input: ImportInput, reading: ProofReading): Omit<VerifyTabState, 'id' | 'filename'> {
  const reset = {
    progress: 0,
    progressDetails: undefined,
    verificationResult: null,
    examManifest: undefined,
    associatedSourceMismatch: undefined,
  };
  if (!reading.ok) {
    return {
      ...reset,
      language: 'unknown',
      status: 'error',
      proofData: null,
      error: reading.error,
      screenshots: undefined,
      startTimestamp: undefined,
    };
  }
  const { proofData } = reading;
  return {
    ...reset,
    // proof.json は攻撃者が組み立てられる入力。自己申告の language をそのまま状態に入れると
    // 表示層の className に届く (#248)。取り込み口で allowlist に落とす。
    language: normalizeProofLanguage(proofData.language),
    status: 'pending',
    proofData,
    error: undefined,
    screenshots: input.screenshots,
    startTimestamp: input.startTimestamp || computeStartTimestamp(proofData),
  };
}

/** 同梱ソース候補の照合の材料。比較はバイト厳密なので、BOM を落とさない生バイトを優先する (#293)。 */
function sourceMaterial(fileData: ParsedFileData): { bytes: Uint8Array; text: string } {
  return {
    // バイト列を持たない入力 (他の経路) は再符号化で代える。BOM はここで失われるので、持てる経路では持たせている。
    bytes: fileData.rawBytes ?? new TextEncoder().encode(fileData.rawData),
    text: fileData.rawData,
  };
}

/** コンテナが記録開始時刻を渡さなかったとき、export 時刻から最後のイベントの経過時間を引いて求める。 */
function computeStartTimestamp(proofData: ProofFile): number | undefined {
  const events = proofData.proof?.events;
  if (!proofData.metadata?.timestamp || !(events?.length > 0)) return undefined;
  const totalTime = events[events.length - 1]?.timestamp ?? 0;
  return new Date(proofData.metadata.timestamp).getTime() - totalTime;
}

export interface FileControllerDependencies {
  fileProcessor: FileProcessor;
  tabManager: VerifyTabManager;
  uiState: UIStateManager;
  /** `remove` は外部更新で取り込み直すとき、旧 proof の検証を止めるのに使う (#695) */
  verificationQueue: Pick<VerificationQueue, 'enqueue' | 'remove' | 'reverifyWithManifest'>;
  sidebar: Sidebar;
  statusBar: StatusBarUI;
  generateId: () => string;
  onScreenshotServiceUpdate?: (service: ScreenshotService) => void;
  onStatusBarUpdate?: () => void;
  /** 開いているタブの見た目を更新する (照合結果が後から付いたとき用。タブが開いていなければ何もしない) */
  tabBar?: { hasTab(id: string): boolean; updateTabStatus(id: string, status: TabStatus, progress?: number): void };
  /**
   * 検証済みの proof タブに提出物の照合結果が付いた / 変わったときの通知。status の出所は
   * VerificationController なので、再計算はそちらに任せる (ここで status を導出し直さない)。
   */
  onSubmissionChange?: (tabId: string) => void;
  /** 外部更新でタブを取り込み直したときの通知 (表示中なら描き直す。#695) */
  onFileReplaced?: (tabId: string) => void;
}

/**
 * 1 つのフォルダ (ZIP のルート・サブフォルダ・FSA のフォルダ) に集まった、提出物の照合の材料 (#293)。
 * `path` はフォルダ内のファイル名 (ZIP のサブフォルダは別フォルダとして扱われ、別の registry になる)。
 */
interface SubmissionFolder {
  proofs: Array<{ tabId: string; path: string; filename: unknown; language: unknown; content: unknown }>;
  unreadable: Array<{ tabId: string; path: string }>;
  sources: Array<{ tabId: string; path: string; bytes: Uint8Array; text: string }>;
}

export class FileController {
  private deps: FileControllerDependencies;

  /**
   * フォルダごとの提出物照合の材料 (folderId -> 材料)。ファイルを足すたびに登録するだけで、
   * 照合 (`settleSubmission`) は全ファイルが揃ってから行う (途中で判定すると、まだ読んでいないソースが
   * 「欠落」に見える)。対応規則と比較は shared の `matchSubmissionSources` が持つ (verify-cli と同一実装)。
   */
  private submissionFolders: Map<string, SubmissionFolder> = new Map();

  /** タブ ID -> 取り込み時のコンテナ由来の入力。外部更新 (`replaceFile`) で使い回す (#695) */
  private importInputs: Map<string, ImportInput> = new Map();

  constructor(deps: FileControllerDependencies) {
    this.deps = deps;
  }

  /**
   * 試験モード (ADR-0006): 当該タブの exam proof に問題パッケージ (.tcexam) を読み込み、
   * 完全束縛検証 (署名/復号/内容) を含めて再検証する。grader 用。
   */
  async loadExamManifestForTab(tabId: string): Promise<void> {
    const tab = this.deps.tabManager.getTab(tabId);
    if (!tab?.proofData?.exam) return;

    const file = await pickFile('.tcexam,application/json');
    if (!file) return;

    let manifest: ExamPackageManifest;
    try {
      const parsed = parseExamPackageManifestResult(JSON.parse(await file.text()));
      if (!parsed.ok) {
        // #223: 「壊れている」と「この検証器より新しい / もう対応しない形式」を出し分ける
        this.deps.statusBar.setError(t(examPackageErrorKey(parsed)));
        return;
      }
      manifest = parsed.manifest;
    } catch {
      this.deps.statusBar.setError(t('errors.examInvalidPackage'));
      return;
    }

    // タブを再検証状態にして、問題パッケージ付きで再検証する。
    this.deps.tabManager.updateTab(tabId, {
      examManifest: manifest,
      status: 'pending',
      progress: 0,
      verificationResult: null,
    });
    // キューは完了した proof を手放しているので、タブの持つ proof を渡す (#331)
    this.deps.verificationQueue.reverifyWithManifest(tabId, manifest, tab.proofData);
  }

  /**
   * ファイルを処理
   */
  async processFile(file: File): Promise<void> {
    try {
      const result = await this.deps.fileProcessor.process(file);

      if (!result.success) {
        this.deps.statusBar.setError(result.error || t('errors.fileReadError'));
        return;
      }

      // ZIPファイルの場合はフォルダ階層を作成
      let rootFolderId: string | undefined;
      const folderMap = new Map<string, string>(); // path -> folderId

      if (file.name.endsWith('.zip') && result.folderPaths) {
        rootFolderId = this.createFolderForZip(file.name);
        folderMap.set('', rootFolderId);

        // フォルダパスをソート（親フォルダが先に処理されるように）
        const sortedPaths = result.folderPaths.sort((a, b) => a.localeCompare(b));

        for (const folderPath of sortedPaths) {
          const folderId = this.deps.generateId();
          const parts = folderPath.split('/');
          const folderName = parts[parts.length - 1];
          const parentPath = parts.slice(0, -1).join('/');
          const parentId = folderMap.get(parentPath) ?? rootFolderId;
          const depth = parts.length;

          // screenshotsフォルダはデフォルトで閉じた状態
          const isScreenshotsFolder = folderName === 'screenshots' || folderPath.startsWith('screenshots/');
          const expanded = isScreenshotsFolder ? false : depth <= 1;

          this.deps.sidebar.addHierarchicalFolder({
            id: folderId,
            name: folderName ?? '',
            path: folderPath,
            parentId,
            expanded,
            depth,
          });
          folderMap.set(folderPath, folderId);
        }
      } else if (file.name.endsWith('.zip')) {
        rootFolderId = this.createFolderForZip(file.name);
        folderMap.set('', rootFolderId);
      }

      // スクリーンショットサービスを保存（ZIPに含まれている場合）
      if (result.screenshotService && this.deps.onScreenshotServiceUpdate) {
        this.deps.onScreenshotServiceUpdate(result.screenshotService);
      }

      // 2パスで処理: 1) proofファイル、2) plaintext/imageファイル
      // これにより、plaintextファイル処理時にproofのcontentを参照できる
      const proofFiles = result.files.filter((f) => f.type === 'proof');
      const otherFiles = result.files.filter((f) => f.type !== 'proof');

      // パス1: proofファイルを先に処理
      for (const fileData of proofFiles) {
        let folderId = rootFolderId;
        if (fileData.relativePath) {
          const parts = fileData.relativePath.split('/');
          const parentPath = parts.slice(0, -1).join('/');
          folderId = folderMap.get(parentPath) ?? rootFolderId;
        }
        this.addFileToVerification(
          fileData.filename,
          fileData.rawData,
          folderId,
          fileData.relativePath,
          result.screenshots,
          result.startTimestamp
        );
      }

      // パス2: plaintext/imageファイルを処理
      for (const fileData of otherFiles) {
        // ファイルの親フォルダを特定
        let folderId = rootFolderId;
        if (fileData.relativePath) {
          const parts = fileData.relativePath.split('/');
          const parentPath = parts.slice(0, -1).join('/');
          folderId = folderMap.get(parentPath) ?? rootFolderId;
        }

        if (fileData.type === 'image') {
          this.addImageFile(fileData, folderId);
        } else {
          this.addPlaintextFile(fileData, folderId);
        }
      }

      // 全ファイルが揃ったので、同梱ソースと proof.content を照合する (#293)
      this.settleSubmission();
    } catch (error) {
      console.error('Error processing file:', error);
      this.deps.statusBar.setError(`${t('errors.fileReadError')}: ${file.name}`);
    }
  }

  /**
   * ZIP用フォルダを作成
   */
  private createFolderForZip(zipFilename: string): string {
    const folderId = this.deps.generateId();
    // ZIPファイル名から拡張子を除去してフォルダ名とする
    const folderName = this.deps.uiState.generateFolderName(zipFilename.replace(/\.zip$/i, ''));

    this.deps.sidebar.addFolder({
      id: folderId,
      name: folderName,
      expanded: true, // デフォルトで展開
    });

    return folderId;
  }

  /**
   * プレーンテキストファイルを追加（読み取り専用）
   *
   * 同梱ソースの候補なら、提出物照合の材料として登録する。照合そのものは `settleSubmission` が
   * 全ファイルが揃ってから行う (#293)。proof の有無・照合の結果によらず、ソースは常に平文タブとして開ける。
   */
  addPlaintextFile(fileData: ParsedFileData, folderId?: string): void {
    const id = this.deps.generateId();
    const displayName = this.deps.uiState.generateDisplayName(fileData.filename, folderId);
    this.importInputs.set(id, { filename: fileData.filename, folderId });

    if (folderId && isSubmissionSourceEntry(fileData.filename)) {
      this.submissionFolderOf(folderId).sources.push({
        tabId: id,
        path: fileData.filename,
        ...sourceMaterial(fileData),
      });
    }

    // Add to tab manager (plaintext file - no verification)
    this.deps.tabManager.addTab({
      id,
      filename: displayName,
      language: fileData.language,
      status: 'success',
      progress: 100,
      proofData: null,
      verificationResult: null,
      isPlaintext: true, // プレーンテキストフラグ
      plaintextContent: fileData.rawData,
    });

    // Add to sidebar (file list)
    this.deps.sidebar.addFile({
      id,
      filename: displayName,
      status: 'success',
      folderId,
      // FSA フォルダの監視が外部更新・削除をパスで引く (#695。無いと同梱ソースの更新が届かない)
      relativePath: fileData.relativePath,
      isProof: false, // プレーンテキストファイル
    });

    this.deps.onStatusBarUpdate?.();
  }

  /**
   * 画像ファイルを追加（プレビュー表示用）
   */
  addImageFile(fileData: ParsedFileData, folderId?: string): void {
    const id = this.deps.generateId();
    const displayName = this.deps.uiState.generateDisplayName(fileData.filename, folderId);
    this.importInputs.set(id, { filename: fileData.filename, folderId });

    // Add to tab manager (image file - no verification)
    this.deps.tabManager.addTab({
      id,
      filename: displayName,
      language: 'image',
      status: 'success', // 画像ファイルは常に「成功」状態
      progress: 100,
      proofData: null,
      verificationResult: null,
      isImage: true,
      imageBlob: fileData.imageBlob,
    });

    // Add to sidebar (file list)
    this.deps.sidebar.addFile({
      id,
      filename: displayName,
      status: 'success',
      folderId,
      relativePath: fileData.relativePath, // FSA フォルダの監視がパスで引く (#695)
      isProof: false,
      isImage: true, // 画像ファイル
    });

    this.deps.onStatusBarUpdate?.();
  }

  /**
   * 検証用ファイルを追加
   *
   * proof として読めないファイルは黙って捨てず、error のタブ/行として残す (#292)。
   * 壊れた proof を消すと、そのタブが未検証のまま全体が通ったように見える。検証キューには載せない。
   */
  addFileToVerification(
    filename: string,
    rawData: string,
    folderId?: string,
    relativePath?: string,
    screenshots?: VerifyScreenshot[],
    startTimestamp?: number
  ): void {
    console.log('[FileController] addFileToVerification:', {
      filename,
      screenshotsCount: screenshots?.length ?? 0,
      startTimestamp,
    });

    const id = this.deps.generateId();
    // 表示名を生成（重複がある場合は番号を付ける）
    const displayName = this.deps.uiState.generateDisplayName(filename, folderId);
    const input: ImportInput = { filename, folderId, screenshots, startTimestamp };
    this.importInputs.set(id, input);

    const reading = readProof(filename, rawData);
    this.registerProofMaterial(id, input, reading);
    const snapshot = proofSnapshot(input, reading);

    this.deps.tabManager.addTab({ id, filename: displayName, ...snapshot });
    this.deps.sidebar.addFile({
      id,
      filename: displayName,
      status: snapshot.status as FileStatus,
      folderId, // フォルダに属する場合
      relativePath, // File System Access API用のパス
      isProof: true, // 検証用ファイル
    });

    this.deps.uiState.incrementTotal();
    if (reading.ok) {
      this.deps.verificationQueue.enqueue({ id, filename, rawData });
    } else {
      // 読めない proof は総数と完了数の両方に数える (handleError と同じ。片方だけだと進捗表示が終わらない)。
      this.deps.uiState.incrementCompleted();
      this.deps.statusBar.setError(reading.error);
    }

    this.deps.onStatusBarUpdate?.();
  }

  /**
   * 外部更新 (FSA フォルダの監視) で変わったファイルを、同じタブ ID で取り込み直す (#695)。
   *
   * 初回取り込みと同じ関数 (`readProof` / `proofSnapshot` / `sourceMaterial`) で、表示状態・照合の材料・
   * 検証の対象を新しい内容の 1 スナップショットに揃える。コンテナ由来の入力 (フォルダ・スクリーンショット・
   * 記録開始時刻) は取り込み時のものを使い回す。タブの種類 (proof / 平文 / 画像) は取り込み時のまま。
   */
  replaceFile(tabId: string, fileData: ParsedFileData): void {
    const tab = this.deps.tabManager.getTab(tabId);
    if (!tab) return;
    const input = this.importInputs.get(tabId) ?? { filename: fileData.filename };

    if (tab.isPlaintext) {
      this.deps.tabManager.updateTab(tabId, { plaintextContent: fileData.rawData });
      const source = this.findSourceMaterial(tabId);
      if (source) Object.assign(source, sourceMaterial(fileData));
    } else if (tab.isImage) {
      this.deps.tabManager.updateTab(tabId, { imageBlob: fileData.imageBlob });
    } else {
      this.replaceProof(tabId, tab.status, input, fileData.rawData);
    }

    if (input.folderId) this.settleSubmission(input.folderId);
    this.deps.onFileReplaced?.(tabId);
    this.deps.onStatusBarUpdate?.();
  }

  /** proof タブを新しい rawData で取り込み直す。旧 proof の検証は止め、遅れて届く旧結果は queue が捨てる。 */
  private replaceProof(
    tabId: string,
    previousStatus: VerifyTabState['status'],
    input: ImportInput,
    rawData: string
  ): void {
    this.deps.verificationQueue.remove(tabId);

    const reading = readProof(input.filename, rawData);
    this.registerProofMaterial(tabId, input, reading);
    const snapshot = proofSnapshot(input, reading);
    this.deps.tabManager.updateTab(tabId, snapshot);

    const status = snapshot.status as FileStatus;
    this.deps.sidebar.updateFileStatus(tabId, status, 0);
    if (this.deps.tabBar?.hasTab(tabId)) this.deps.tabBar.updateTabStatus(tabId, status as TabStatus, 0);

    // 「検証中 N/M」を合わせる。検証中だった旧 proof の完了は二度と来ない (TabController.forgetFile と同じ考え方)。
    const wasInFlight = previousStatus === 'pending' || previousStatus === 'verifying';
    if (reading.ok) {
      // 済んでいた proof を検証に回し直すなら、総数に 1 件足す (完了したときに済みへ数えられる)
      if (!wasInFlight) this.deps.uiState.incrementTotal();
      this.deps.verificationQueue.enqueue({ id: tabId, filename: input.filename, rawData });
    } else {
      // 検証中だった proof が読めなくなったら、検証の完了を待たずに済みへ数える
      if (wasInFlight) this.deps.uiState.incrementCompleted();
      this.deps.statusBar.setError(reading.error);
    }
  }

  /**
   * proof タブを提出物照合の材料に登録する (#293)。登録済みなら位置を保って差し替える
   * (読める ↔ 読めないの入れ替えは、もう片方の一覧から外して移す)。
   * 自己申告の欄は未検証なので unknown のまま渡す。読めない proof もタブ番号の欠番として渡す
   * (後続タブのソース名を確定できなくなる)。
   */
  private registerProofMaterial(tabId: string, input: ImportInput, reading: ProofReading): void {
    if (!input.folderId) return;
    const folder = this.submissionFolderOf(input.folderId);
    const proofAt = folder.proofs.findIndex((p) => p.tabId === tabId);
    const unreadableAt = folder.unreadable.findIndex((u) => u.tabId === tabId);

    if (reading.ok) {
      const claim = reading.proofData as { filename?: unknown; language?: unknown; content?: unknown };
      const entry = {
        tabId,
        path: input.filename,
        filename: claim.filename,
        language: claim.language,
        content: claim.content,
      };
      if (unreadableAt !== -1) folder.unreadable.splice(unreadableAt, 1);
      if (proofAt !== -1) folder.proofs[proofAt] = entry;
      else folder.proofs.push(entry);
    } else {
      const entry = { tabId, path: input.filename };
      if (proofAt !== -1) folder.proofs.splice(proofAt, 1);
      if (unreadableAt !== -1) folder.unreadable[unreadableAt] = entry;
      else folder.unreadable.push(entry);
    }
  }

  /** 同梱ソース候補として登録したタブの照合の材料 (候補でなければ undefined)。 */
  private findSourceMaterial(tabId: string): SubmissionFolder['sources'][number] | undefined {
    for (const folder of this.submissionFolders.values()) {
      const source = folder.sources.find((s) => s.tabId === tabId);
      if (source) return source;
    }
    return undefined;
  }

  /**
   * 一覧から外されたファイルを照合の材料から外し、残りで照合し直す (#293)。
   * 外したファイルが相手だった proof / ソースの結論も、残りの材料に合わせて変わる。
   */
  forgetSubmissionFiles(tabIds: readonly string[]): void {
    const gone = new Set(tabIds);
    for (const id of gone) this.importInputs.delete(id);
    for (const folder of this.submissionFolders.values()) {
      folder.proofs = folder.proofs.filter((p) => !gone.has(p.tabId));
      folder.unreadable = folder.unreadable.filter((u) => !gone.has(u.tabId));
      folder.sources = folder.sources.filter((s) => !gone.has(s.tabId));
    }
    this.settleSubmission();
  }

  private submissionFolderOf(folderId: string): SubmissionFolder {
    let folder = this.submissionFolders.get(folderId);
    if (!folder) {
      folder = { proofs: [], unreadable: [], sources: [] };
      this.submissionFolders.set(folderId, folder);
    }
    return folder;
  }

  /**
   * 集めた材料でフォルダ単位に提出物を照合し、結果をタブ / サイドバーに反映する (#293)。
   * `folderId` を省くと材料のある全フォルダが対象。何度呼んでも同じ結果になる (毎回、状態を付け直す)。
   *
   * 結論は verify-cli と同じ shared の関数 (`matchSubmissionSources` / `submissionSeverity`) が出す:
   * - 不一致 / 対応が曖昧: proof タブと同梱ソースのタブを error にする。整合性 (integrity) のバッジは変えない
   * - ソース欠落 / 孤立ソース: warning
   */
  settleSubmission(folderId?: string): void {
    for (const id of folderId !== undefined ? [folderId] : [...this.submissionFolders.keys()]) {
      this.settleSubmissionFolder(id);
    }
  }

  private settleSubmissionFolder(folderId: string): void {
    const folder = this.submissionFolders.get(folderId);
    // proof の無いフォルダは照合する相手がいない。ソースは平文タブとして開けるまま (status も success のまま)。
    if (!folder || folder.proofs.length + folder.unreadable.length === 0) return;

    const report = matchSubmissionSources({
      proofs: folder.proofs.map((p) => ({
        path: p.path,
        filename: p.filename,
        language: p.language,
        content: p.content,
      })),
      unreadableProofPaths: folder.unreadable.map((u) => u.path),
      sources: folder.sources.map((s) => ({ path: s.path, bytes: s.bytes })),
    });

    // 付け直しなので、まず全ソースタブを既定 (success・不一致表示なし) に戻す。
    const sourceUpdates = new Map<string, Partial<VerifyTabState>>();
    for (const source of folder.sources) {
      sourceUpdates.set(source.tabId, {
        status: 'success',
        hasContentMismatch: false,
        diffResult: undefined,
        associatedProofContent: undefined,
      });
    }
    const sourceByPath = new Map(folder.sources.map((s) => [s.path, s]));

    report.pairs.forEach((pair, i) => {
      const proof = folder.proofs[i]!;
      const severity = submissionSeverity(report, pair);
      let info: ContentMismatchInfo | undefined;

      if (pair.status !== 'match') {
        let additions = 0;
        let deletions = 0;
        const source = pair.expectedSource === undefined ? undefined : sourceByPath.get(pair.expectedSource);
        if (pair.status === 'mismatch' && source && typeof proof.content === 'string') {
          // 行単位の差分は表示用 (結論には使わない)。バイト単位で違うのに行は同じ (CRLF・BOM) こともある。
          const diff = DiffService.compare(source.text, proof.content);
          additions = diff.stats.additions;
          deletions = diff.stats.deletions;
          sourceUpdates.set(source.tabId, {
            status: 'error',
            hasContentMismatch: true,
            diffResult: diff,
            associatedProofContent: proof.content,
          });
        }
        info = {
          filename: pair.expectedSource ?? proof.path,
          additions,
          deletions,
          kind: pair.status,
          severity: severity === 'failure' ? 'error' : 'warning',
        };
      }

      const before = this.deps.tabManager.getTab(proof.tabId)?.associatedSourceMismatch;
      this.deps.tabManager.updateTab(proof.tabId, { associatedSourceMismatch: info });
      // 検証が先に終わっていたら、status を付け直す (出所は VerificationController)
      if (JSON.stringify(before) !== JSON.stringify(info)) this.deps.onSubmissionChange?.(proof.tabId);
    });

    // どの proof の期待名にも当たらないソースは warning (exit code 相当のものではない)
    for (const orphan of report.orphanSources) {
      const source = sourceByPath.get(orphan);
      if (source) sourceUpdates.set(source.tabId, { status: 'warning' });
    }

    for (const [tabId, updates] of sourceUpdates) {
      this.deps.tabManager.updateTab(tabId, updates);
      const status = updates.status as FileStatus;
      this.deps.sidebar.updateFileStatus(tabId, status);
      if (this.deps.tabBar?.hasTab(tabId)) this.deps.tabBar.updateTabStatus(tabId, status as TabStatus);
    }
    this.deps.onStatusBarUpdate?.();
  }
}
