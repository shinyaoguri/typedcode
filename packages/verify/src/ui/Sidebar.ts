/**
 * Sidebar - File tree with verification status (VSCode-like)
 */
import type { HierarchicalFolder } from '../types.js';

export type FileStatus = 'pending' | 'verifying' | 'success' | 'warning' | 'error';

export interface SidebarFile {
  id: string;
  filename: string;
  status: FileStatus;
  progress?: number;
  folderId?: string; // フォルダに属する場合のフォルダID
  relativePath?: string; // フォルダ内の相対パス
  isProof?: boolean; // 検証用ファイル（true）かプレーンテキスト（false）か
}

export interface SidebarFolder {
  id: string;
  name: string;
  expanded: boolean;
  parentId?: string; // 親フォルダID（階層対応）
  path?: string; // フォルダパス
  depth?: number; // ネストの深さ
}

export class Sidebar {
  private sidebar: HTMLElement;
  private fileList: HTMLElement;
  private emptyState: HTMLElement;
  private resizeHandle: HTMLElement;
  private addFileBtn: HTMLElement;
  private addFolderBtn: HTMLElement | null;

  private files: Map<string, SidebarFile> = new Map();
  private folders: Map<string, SidebarFolder> = new Map();
  private foldersByPath: Map<string, string> = new Map(); // path -> folderId
  private filesByPath: Map<string, string> = new Map(); // path -> fileId
  private activeFileId: string | null = null;
  private isResizing = false;
  private isDragOver = false;

  private onFileSelect: (id: string) => void;
  private onAddFile: () => void;
  private onAddFolder: () => void;
  private onFileRemove: (id: string) => void;
  private onFilesDropped: (files: FileList) => void;
  private onFolderRemove: (folderId: string) => void;

  constructor(callbacks: {
    onFileSelect: (id: string) => void;
    onAddFile: () => void;
    onAddFolder?: () => void;
    onFileRemove?: (id: string) => void;
    onFilesDropped?: (files: FileList) => void;
    onFolderRemove?: (folderId: string) => void;
  }) {
    this.onFileSelect = callbacks.onFileSelect;
    this.onAddFile = callbacks.onAddFile;
    this.onAddFolder = callbacks.onAddFolder || (() => {});
    this.onFileRemove = callbacks.onFileRemove || (() => {});
    this.onFilesDropped = callbacks.onFilesDropped || (() => {});
    this.onFolderRemove = callbacks.onFolderRemove || (() => {});

    this.sidebar = document.getElementById('sidebar')!;
    this.fileList = document.getElementById('file-list')!;
    this.emptyState = document.getElementById('sidebar-empty')!;
    this.resizeHandle = document.getElementById('resize-handle')!;
    this.addFileBtn = document.getElementById('add-file-btn')!;
    this.addFolderBtn = document.getElementById('add-folder-btn');

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Add file button
    this.addFileBtn.addEventListener('click', () => {
      this.onAddFile();
    });

    // Add folder button
    if (this.addFolderBtn) {
      this.addFolderBtn.addEventListener('click', () => {
        this.onAddFolder();
      });
    }

    // Resize handle
    this.resizeHandle.addEventListener('mousedown', this.startResize.bind(this));
    document.addEventListener('mousemove', this.handleResize.bind(this));
    document.addEventListener('mouseup', this.stopResize.bind(this));

    // Drag & Drop for sidebar
    this.sidebar.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.isDragOver) {
        this.isDragOver = true;
        this.sidebar.classList.add('drag-over');
      }
    });

    this.sidebar.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = this.sidebar.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        this.isDragOver = false;
        this.sidebar.classList.remove('drag-over');
      }
    });

    this.sidebar.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.isDragOver = false;
      this.sidebar.classList.remove('drag-over');

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        this.onFilesDropped(files);
      }
    });
  }

  private startResize(e: MouseEvent): void {
    e.preventDefault();
    this.isResizing = true;
    this.resizeHandle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  private handleResize(e: MouseEvent): void {
    if (!this.isResizing) return;

    const newWidth = e.clientX - 48;
    const minWidth = 150;
    const maxWidth = 400;

    if (newWidth >= minWidth && newWidth <= maxWidth) {
      this.sidebar.style.width = `${newWidth}px`;
    }
  }

  private stopResize(): void {
    if (!this.isResizing) return;
    this.isResizing = false;
    this.resizeHandle.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  // フォルダを追加
  addFolder(folder: SidebarFolder): void {
    this.folders.set(folder.id, folder);
    if (folder.path) {
      this.foldersByPath.set(folder.path, folder.id);
    }
    this.render();
  }

  // 階層フォルダを追加（HierarchicalFolder型から変換）
  addHierarchicalFolder(folder: HierarchicalFolder): void {
    const sidebarFolder: SidebarFolder = {
      id: folder.id,
      name: folder.name,
      expanded: folder.expanded,
      parentId: folder.parentId ?? undefined,
      path: folder.path,
      depth: folder.depth,
    };
    this.folders.set(folder.id, sidebarFolder);
    if (folder.path) {
      this.foldersByPath.set(folder.path, folder.id);
    }
    this.render();
  }

  // 複数の階層フォルダを一括追加（レンダリングは最後に1回のみ）
  addHierarchicalFolders(folders: HierarchicalFolder[]): void {
    for (const folder of folders) {
      const sidebarFolder: SidebarFolder = {
        id: folder.id,
        name: folder.name,
        expanded: folder.expanded,
        parentId: folder.parentId ?? undefined,
        path: folder.path,
        depth: folder.depth,
      };
      this.folders.set(folder.id, sidebarFolder);
      if (folder.path) {
        this.foldersByPath.set(folder.path, folder.id);
      }
    }
    this.render();
  }

  // パスからフォルダを検索
  findFolderByPath(path: string): SidebarFolder | undefined {
    const folderId = this.foldersByPath.get(path);
    if (folderId) {
      return this.folders.get(folderId);
    }
    return undefined;
  }

  // パスからファイルを検索
  findFileByPath(path: string): SidebarFile | undefined {
    const fileId = this.filesByPath.get(path);
    if (fileId) {
      return this.files.get(fileId);
    }
    return undefined;
  }

  // パスからフォルダIDを取得
  getFolderIdByPath(path: string): string | undefined {
    return this.foldersByPath.get(path);
  }

  // フォルダを削除（中のファイルも削除）
  removeFolder(folderId: string): void {
    const folder = this.folders.get(folderId);
    if (folder?.path) {
      this.foldersByPath.delete(folder.path);
    }
    this.folders.delete(folderId);

    // 子フォルダも削除
    const childFolders: string[] = [];
    this.folders.forEach((f, id) => {
      if (f.parentId === folderId) {
        childFolders.push(id);
      }
    });
    childFolders.forEach((id) => this.removeFolder(id));

    // フォルダ内のファイルも削除
    const filesToRemove: string[] = [];
    this.files.forEach((file, id) => {
      if (file.folderId === folderId) {
        filesToRemove.push(id);
      }
    });
    filesToRemove.forEach((id) => {
      const file = this.files.get(id);
      if (file?.relativePath) {
        this.filesByPath.delete(file.relativePath);
      }
      this.files.delete(id);
    });
    this.render();
  }

  // パスでフォルダを削除
  removeFolderByPath(path: string): void {
    const folderId = this.foldersByPath.get(path);
    if (folderId) {
      this.removeFolder(folderId);
    }
  }

  // フォルダの展開状態を切り替え
  toggleFolder(folderId: string): void {
    const folder = this.folders.get(folderId);
    if (folder) {
      folder.expanded = !folder.expanded;
      this.render();
    }
  }

  // ファイルを追加
  addFile(file: SidebarFile): void {
    this.files.set(file.id, file);
    if (file.relativePath) {
      this.filesByPath.set(file.relativePath, file.id);
    }
    this.render();
  }

  // 複数のファイルを一括追加（レンダリングは最後に1回のみ）
  addFiles(files: SidebarFile[]): void {
    for (const file of files) {
      this.files.set(file.id, file);
      if (file.relativePath) {
        this.filesByPath.set(file.relativePath, file.id);
      }
    }
    this.render();
  }

  removeFile(id: string): void {
    const file = this.files.get(id);
    if (file?.relativePath) {
      this.filesByPath.delete(file.relativePath);
    }
    this.files.delete(id);
    if (this.activeFileId === id) {
      this.activeFileId = null;
    }
    this.render();
  }

  // パスでファイルを削除
  removeFileByPath(path: string): void {
    const fileId = this.filesByPath.get(path);
    if (fileId) {
      this.removeFile(fileId);
    }
  }

  // パスからファイルIDを取得
  getFileIdByPath(path: string): string | undefined {
    return this.filesByPath.get(path);
  }

  updateFileStatus(id: string, status: FileStatus, progress?: number): void {
    const file = this.files.get(id);
    if (file) {
      const statusChanged = file.status !== status;
      file.status = status;
      if (progress !== undefined) {
        file.progress = progress;
      }

      // ステータスが変わった場合のみ再レンダリング
      // 進捗のみの更新は部分更新で対応
      if (statusChanged) {
        this.render();
      } else if (progress !== undefined) {
        // 進捗バーのみ更新
        this.updateFileProgressBar(id, progress);
      }
    }
  }

  private updateFileProgressBar(id: string, progress: number): void {
    const progressEl = this.fileList.querySelector(`[data-id="${id}"] .file-item-progress-bar`) as HTMLElement;
    if (progressEl) {
      progressEl.style.width = `${progress}%`;
    }
  }

  updateFileProgress(id: string, progress: number): void {
    const file = this.files.get(id);
    if (file) {
      file.progress = progress;
      const progressEl = this.fileList.querySelector(`[data-id="${id}"] .file-item-progress-bar`) as HTMLElement;
      if (progressEl) {
        progressEl.style.width = `${progress}%`;
      }
    }
  }

  setActiveFile(id: string): void {
    this.activeFileId = id;
    this.render();
  }

  getActiveFileId(): string | null {
    return this.activeFileId;
  }

  getFileCount(): number {
    return this.files.size;
  }

  getFolderCount(): number {
    return this.folders.size;
  }

  // フォルダ内のファイルIDを取得
  getFilesInFolder(folderId: string): string[] {
    const fileIds: string[] = [];
    this.files.forEach((file, id) => {
      if (file.folderId === folderId) {
        fileIds.push(id);
      }
    });
    return fileIds;
  }

  clear(): void {
    this.files.clear();
    this.folders.clear();
    this.foldersByPath.clear();
    this.filesByPath.clear();
    this.activeFileId = null;
    this.render();
  }

  private render(): void {
    // Show/hide empty state
    if (this.files.size === 0 && this.folders.size === 0) {
      this.emptyState.style.display = 'flex';
      this.fileList.innerHTML = '';
      this.fileList.appendChild(this.emptyState);
      return;
    }

    this.emptyState.style.display = 'none';

    const fragment = document.createDocumentFragment();

    // ルートフォルダ（親なし）を取得してレンダリング
    const rootFolders = Array.from(this.folders.values()).filter(
      (f) => !f.parentId
    );

    // フォルダをソートして表示（名前順）
    rootFolders.sort((a, b) => a.name.localeCompare(b.name));

    for (const folder of rootFolders) {
      this.renderFolderRecursive(folder, fragment, 0);
    }

    // フォルダに属さないファイル（単体JSON）をレンダリング
    const rootFiles = Array.from(this.files.values()).filter((f) => !f.folderId);
    rootFiles.sort((a, b) => a.filename.localeCompare(b.filename));

    for (const file of rootFiles) {
      const fileEl = this.createFileItem(file, 0);
      fragment.appendChild(fileEl);
    }

    this.fileList.innerHTML = '';
    this.fileList.appendChild(fragment);
  }

  // フォルダを再帰的にレンダリング
  private renderFolderRecursive(
    folder: SidebarFolder,
    container: DocumentFragment | HTMLElement,
    depth: number
  ): void {
    const folderEl = this.createFolderItem(folder, depth);
    container.appendChild(folderEl);

    // フォルダが展開されている場合
    if (folder.expanded) {
      // 子フォルダをレンダリング
      const childFolders = Array.from(this.folders.values()).filter(
        (f) => f.parentId === folder.id
      );
      childFolders.sort((a, b) => a.name.localeCompare(b.name));

      for (const childFolder of childFolders) {
        this.renderFolderRecursive(childFolder, container, depth + 1);
      }

      // フォルダ内のファイルをレンダリング
      const filesInFolder = Array.from(this.files.values()).filter(
        (f) => f.folderId === folder.id
      );
      filesInFolder.sort((a, b) => a.filename.localeCompare(b.filename));

      for (const file of filesInFolder) {
        const fileEl = this.createFileItem(file, depth + 1);
        container.appendChild(fileEl);
      }
    }
  }

  private createFolderItem(folder: SidebarFolder, depth: number = 0): HTMLElement {
    const item = document.createElement('div');
    item.className = 'folder-item';
    item.dataset.folderId = folder.id;
    item.style.paddingLeft = `${8 + depth * 16}px`;

    const chevron = document.createElement('div');
    chevron.className = `folder-chevron${folder.expanded ? ' expanded' : ''}`;
    chevron.innerHTML = '<i class="fas fa-chevron-right"></i>';

    const icon = document.createElement('div');
    icon.className = 'folder-icon';
    icon.innerHTML = folder.expanded
      ? '<i class="fas fa-folder-open"></i>'
      : '<i class="fas fa-folder"></i>';

    const name = document.createElement('div');
    name.className = 'folder-name';
    name.textContent = folder.name;
    name.title = folder.path || folder.name;

    // フォルダ内のファイル数と子フォルダ数を計算
    const fileCount = this.getFilesInFolder(folder.id).length;
    const childFolderCount = Array.from(this.folders.values()).filter(
      (f) => f.parentId === folder.id
    ).length;
    const totalCount = fileCount + childFolderCount;

    const count = document.createElement('div');
    count.className = 'folder-count';
    count.textContent = `${totalCount}`;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'folder-remove';
    removeBtn.innerHTML = '<i class="fas fa-times"></i>';
    removeBtn.title = 'フォルダを削除';

    item.appendChild(chevron);
    item.appendChild(icon);
    item.appendChild(name);
    item.appendChild(count);
    item.appendChild(removeBtn);

    // フォルダクリックで展開/折りたたみ
    item.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.folder-remove')) {
        this.toggleFolder(folder.id);
      }
    });

    // 削除ボタン
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onFolderRemove(folder.id);
    });

    return item;
  }

  private createFileItem(file: SidebarFile, depth: number): HTMLElement {
    const item = document.createElement('div');
    const isProof = file.isProof !== false; // デフォルトはtrue（JSONファイル）
    item.className = `file-item${file.id === this.activeFileId ? ' active' : ''}${isProof ? ' proof-file' : ' plaintext-file'}`;
    item.dataset.id = file.id;
    item.style.paddingLeft = `${12 + depth * 16}px`;

    const icon = document.createElement('div');
    icon.className = 'file-item-icon';
    // 検証用ファイルは盾アイコン、プレーンテキストはファイルアイコン
    icon.innerHTML = isProof
      ? '<i class="fas fa-shield-halved"></i>'
      : '<i class="fas fa-file-code"></i>';

    const name = document.createElement('div');
    name.className = 'file-item-name';
    name.textContent = file.filename;
    name.title = file.filename;

    const status = document.createElement('div');
    status.className = `file-item-status ${file.status}`;
    status.innerHTML = this.getStatusIcon(file.status);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'file-item-remove';
    removeBtn.innerHTML = '<i class="fas fa-times"></i>';
    removeBtn.title = '削除';

    item.appendChild(icon);
    item.appendChild(name);
    item.appendChild(status);
    item.appendChild(removeBtn);

    // Progress bar for verifying status
    if (file.status === 'verifying') {
      const progressContainer = document.createElement('div');
      progressContainer.className = 'file-item-progress';
      const progressBar = document.createElement('div');
      progressBar.className = 'file-item-progress-bar';
      progressBar.style.width = `${file.progress || 0}%`;
      progressContainer.appendChild(progressBar);
      item.appendChild(progressContainer);
    }

    item.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.file-item-remove')) {
        this.setActiveFile(file.id);
        this.onFileSelect(file.id);
      }
    });

    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showRemoveConfirmation(file);
    });

    return item;
  }

  /**
   * ファイル削除の確認ダイアログを表示
   */
  private showRemoveConfirmation(file: SidebarFile): void {
    // 既存のダイアログがあれば削除
    const existingDialog = document.querySelector('.remove-confirm-dialog');
    if (existingDialog) {
      existingDialog.remove();
    }

    const overlay = document.createElement('div');
    overlay.className = 'remove-confirm-dialog';

    const dialog = document.createElement('div');
    dialog.className = 'remove-confirm-content';

    const message = document.createElement('p');
    message.className = 'remove-confirm-message';
    message.textContent = `「${file.filename}」をリストから削除しますか？`;

    const buttons = document.createElement('div');
    buttons.className = 'remove-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'remove-confirm-btn cancel';
    cancelBtn.textContent = 'キャンセル';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'remove-confirm-btn confirm';
    confirmBtn.textContent = '削除';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    dialog.appendChild(message);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // アニメーション用に少し遅延
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
    });

    const closeDialog = (): void => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 150);
    };

    cancelBtn.addEventListener('click', closeDialog);

    confirmBtn.addEventListener('click', () => {
      closeDialog();
      this.onFileRemove(file.id);
    });

    // オーバーレイクリックでキャンセル
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeDialog();
      }
    });

    // Escapeキーでキャンセル
    const handleKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        closeDialog();
        document.removeEventListener('keydown', handleKeydown);
      }
    };
    document.addEventListener('keydown', handleKeydown);
  }

  private getStatusIcon(status: FileStatus): string {
    switch (status) {
      case 'pending':
        return '<i class="fas fa-circle"></i>';
      case 'verifying':
        return '<i class="fas fa-spinner fa-spin"></i>';
      case 'success':
        return '<i class="fas fa-check-circle"></i>';
      case 'warning':
        return '<i class="fas fa-exclamation-triangle"></i>';
      case 'error':
        return '<i class="fas fa-times-circle"></i>';
      default:
        return '';
    }
  }
}
