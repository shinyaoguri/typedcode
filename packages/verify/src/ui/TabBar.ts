/**
 * TabBar - VSCode-like tab management with drag & drop
 */
export type TabStatus = 'pending' | 'verifying' | 'success' | 'warning' | 'error';

export interface Tab {
  id: string;
  filename: string;
  status: TabStatus;
  progress?: number; // 0-100 for verifying status
}

/** ドラッグ状態 */
interface DragState {
  isDragging: boolean;
  isPending: boolean;
  draggedTabId: string | null;
  draggedElement: HTMLElement | null;
  placeholder: HTMLElement | null;
  ghost: HTMLElement | null;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  initialIndex: number;
}

export class TabBar {
  private container: HTMLElement;
  private tabbar: HTMLElement;

  private tabs: Map<string, Tab> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string | null = null;

  private onTabSelect: (id: string) => void;
  private onTabClose: (id: string) => void;

  // ドラッグ&ドロップ関連
  private dragState: DragState = {
    isDragging: false,
    isPending: false,
    draggedTabId: null,
    draggedElement: null,
    placeholder: null,
    ghost: null,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
    initialIndex: -1,
  };
  private boundMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: ((e: MouseEvent) => void) | null = null;

  /** ドラッグ開始の移動閾値（ピクセル） */
  private static readonly DRAG_THRESHOLD = 5;

  constructor(callbacks: {
    onTabSelect: (id: string) => void;
    onTabClose: (id: string) => void;
  }) {
    this.onTabSelect = callbacks.onTabSelect;
    this.onTabClose = callbacks.onTabClose;

    this.container = document.getElementById('tabbar-container')!;
    this.tabbar = document.getElementById('tabbar')!;
  }

  addTab(tab: Tab): void {
    this.tabs.set(tab.id, tab);
    this.tabOrder.push(tab.id);
    this.show();
    this.render();
  }

  removeTab(id: string): void {
    this.tabs.delete(id);
    const orderIndex = this.tabOrder.indexOf(id);
    if (orderIndex !== -1) {
      this.tabOrder.splice(orderIndex, 1);
    }
    if (this.activeTabId === id) {
      // Select first remaining tab or hide
      this.activeTabId = this.tabOrder[0] || null;
    }
    if (this.tabs.size === 0) {
      this.hide();
    }
    this.render();
  }

  updateTabStatus(id: string, status: TabStatus, progress?: number): void {
    const tab = this.tabs.get(id);
    if (tab) {
      const statusChanged = tab.status !== status;
      tab.status = status;
      if (progress !== undefined) {
        tab.progress = progress;
      }

      // ステータスが変わった場合のみ再レンダリング
      if (statusChanged) {
        this.render();
      } else if (progress !== undefined) {
        // 進捗のみの更新は部分更新
        this.updateTabProgress(id, progress);
      }
    }
  }

  updateTabProgress(id: string, progress: number): void {
    const tab = this.tabs.get(id);
    if (tab) {
      tab.progress = progress;
      // Only update progress bar, not entire tab bar
      const progressEl = this.tabbar.querySelector(`[data-id="${id}"] .tab-progress-bar`) as HTMLElement;
      if (progressEl) {
        progressEl.style.width = `${progress}%`;
      }
    }
  }

  setActiveTab(id: string): void {
    if (this.activeTabId === id) return;
    this.activeTabId = id;
    this.render();
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  hasTab(id: string): boolean {
    return this.tabs.has(id);
  }

  show(): void {
    this.container.style.display = 'block';
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  clear(): void {
    this.tabs.clear();
    this.tabOrder = [];
    this.activeTabId = null;
    this.hide();
    this.render();
  }

  /**
   * タブの順序を変更
   */
  reorderTab(fromIndex: number, toIndex: number): boolean {
    if (fromIndex < 0 || fromIndex >= this.tabOrder.length ||
        toIndex < 0 || toIndex >= this.tabOrder.length ||
        fromIndex === toIndex) {
      return false;
    }

    const [movedId] = this.tabOrder.splice(fromIndex, 1);
    if (!movedId) return false;

    this.tabOrder.splice(toIndex, 0, movedId);
    return true;
  }

  private render(): void {
    const fragment = document.createDocumentFragment();

    // tabOrderに従って描画
    for (const tabId of this.tabOrder) {
      const tab = this.tabs.get(tabId);
      if (tab) {
        const tabEl = this.createTabElement(tab);
        fragment.appendChild(tabEl);
      }
    }

    this.tabbar.innerHTML = '';
    this.tabbar.appendChild(fragment);
  }

  private createTabElement(tab: Tab): HTMLElement {
    const tabEl = document.createElement('div');
    tabEl.className = `tab${tab.id === this.activeTabId ? ' active' : ''}`;
    tabEl.dataset.id = tab.id;

    const icon = document.createElement('div');
    icon.className = 'tab-icon';
    icon.innerHTML = '<i class="fas fa-file-code"></i>';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.filename;
    title.title = tab.filename;

    const status = document.createElement('div');
    status.className = `tab-status ${tab.status}`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';
    closeBtn.title = '閉じる';

    tabEl.appendChild(icon);
    tabEl.appendChild(title);
    tabEl.appendChild(status);
    tabEl.appendChild(closeBtn);

    // Progress bar for verifying status
    if (tab.status === 'verifying') {
      const progressContainer = document.createElement('div');
      progressContainer.className = 'tab-progress';
      const progressBar = document.createElement('div');
      progressBar.className = 'tab-progress-bar';
      progressBar.style.width = `${tab.progress || 0}%`;
      progressContainer.appendChild(progressBar);
      tabEl.appendChild(progressContainer);
    }

    // Close button click
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onTabClose(tab.id);
    });

    // ドラッグイベントを設定
    this.setupDragEvents(tabEl, tab.id);

    return tabEl;
  }

  // ========================================
  // ドラッグ&ドロップ関連メソッド
  // ========================================

  /**
   * タブ要素にドラッグイベントを設定
   */
  private setupDragEvents(tabEl: HTMLElement, tabId: string): void {
    tabEl.addEventListener('mousedown', (e: MouseEvent) => {
      // 閉じるボタンは除外
      const target = e.target as HTMLElement;
      if (target.closest('.tab-close')) {
        return;
      }

      // 左クリックのみ
      if (e.button !== 0) return;

      this.startDrag(e, tabEl, tabId);
    });
  }

  /**
   * ドラッグ準備（mousedown時）
   */
  private startDrag(e: MouseEvent, tabEl: HTMLElement, tabId: string): void {
    const rect = tabEl.getBoundingClientRect();
    const index = this.tabOrder.indexOf(tabId);

    if (index === -1) return;

    // 保留状態で初期化
    this.dragState = {
      isDragging: false,
      isPending: true,
      draggedTabId: tabId,
      draggedElement: tabEl,
      placeholder: null,
      ghost: null,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      initialIndex: index,
    };

    // グローバルイベントリスナー
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
  }

  /**
   * 実際にドラッグを開始（閾値を超えた時）
   */
  private beginActualDrag(): void {
    if (!this.dragState.draggedElement) return;

    const tabEl = this.dragState.draggedElement;

    // ゴースト要素を作成
    const ghost = this.createGhost(tabEl);
    document.body.appendChild(ghost);

    this.dragState.isDragging = true;
    this.dragState.isPending = false;
    this.dragState.ghost = ghost;
    this.dragState.placeholder = this.createPlaceholder();

    // ゴーストの初期位置を設定
    this.updateGhostPosition(this.dragState.startX, this.dragState.startY);

    // ドラッグ中のスタイル
    tabEl.classList.add('dragging');
    document.body.classList.add('tab-dragging');
  }

  /**
   * ドラッグ中のマウス移動
   */
  private handleMouseMove(e: MouseEvent): void {
    // 保留状態の場合、閾値を超えたらドラッグを開始
    if (this.dragState.isPending) {
      const dx = e.clientX - this.dragState.startX;
      const dy = e.clientY - this.dragState.startY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance >= TabBar.DRAG_THRESHOLD) {
        this.beginActualDrag();
      } else {
        return;
      }
    }

    if (!this.dragState.isDragging || !this.dragState.draggedElement) return;

    // ゴーストの位置を更新
    this.updateGhostPosition(e.clientX, e.clientY);

    // ドロップ位置の更新
    this.updateDropPosition(e.clientX);
  }

  /**
   * ドラッグ終了
   */
  private handleMouseUp(e: MouseEvent): void {
    // 保留状態（閾値を超えずにマウスアップ）の場合は単なるクリック
    if (this.dragState.isPending) {
      const tabId = this.dragState.draggedTabId;
      this.cleanupDrag();

      if (tabId) {
        this.setActiveTab(tabId);
        this.onTabSelect(tabId);
      }
      return;
    }

    if (!this.dragState.isDragging) return;

    // 最終的なドロップ位置を計算
    const newIndex = this.calculateDropIndex(e.clientX);

    // 位置が変わった場合のみ順序を更新
    if (newIndex !== -1 && newIndex !== this.dragState.initialIndex) {
      this.reorderTab(this.dragState.initialIndex, newIndex);
    }

    // クリーンアップ
    this.cleanupDrag();
  }

  /**
   * ドロップ位置のインデックスを計算
   */
  private calculateDropIndex(clientX: number): number {
    const tabElements = Array.from(
      this.tabbar.querySelectorAll('.tab')
    ) as HTMLElement[];

    let dropIndex = this.tabOrder.length - 1;

    for (let i = 0; i < tabElements.length; i++) {
      const tab = tabElements[i]!;

      // ドラッグ中のタブはスキップ
      if (tab === this.dragState.draggedElement) {
        continue;
      }

      const rect = tab.getBoundingClientRect();
      const midPoint = rect.left + rect.width / 2;

      if (clientX < midPoint) {
        const tabId = tab.dataset.id;
        const tabIndex = this.tabOrder.indexOf(tabId!);

        if (tabIndex !== -1) {
          if (tabIndex > this.dragState.initialIndex) {
            dropIndex = tabIndex - 1;
          } else {
            dropIndex = tabIndex;
          }
        }
        break;
      }
    }

    return dropIndex;
  }

  /**
   * プレースホルダの位置を更新
   */
  private updateDropPosition(clientX: number): void {
    const placeholder = this.dragState.placeholder;
    if (!placeholder) return;

    const tabElements = Array.from(
      this.tabbar.querySelectorAll('.tab')
    ) as HTMLElement[];

    // プレースホルダを一旦削除
    placeholder.remove();

    let insertBeforeElement: HTMLElement | null = null;

    for (let i = 0; i < tabElements.length; i++) {
      const tab = tabElements[i]!;
      const rect = tab.getBoundingClientRect();
      const midPoint = rect.left + rect.width / 2;

      if (clientX < midPoint) {
        if (tab === this.dragState.draggedElement) {
          continue;
        }
        insertBeforeElement = tab;
        break;
      }
    }

    if (insertBeforeElement) {
      this.tabbar.insertBefore(placeholder, insertBeforeElement);
    } else {
      this.tabbar.appendChild(placeholder);
    }
  }

  /**
   * ゴースト要素を作成
   */
  private createGhost(sourceElement: HTMLElement): HTMLElement {
    const ghost = document.createElement('div');
    ghost.className = 'tab-ghost';

    const icon = sourceElement.querySelector('.tab-icon');
    const title = sourceElement.querySelector('.tab-title');

    if (icon) {
      ghost.appendChild(icon.cloneNode(true));
    }
    if (title) {
      ghost.appendChild(title.cloneNode(true));
    }

    return ghost;
  }

  /**
   * ゴーストの位置を更新
   */
  private updateGhostPosition(clientX: number, clientY: number): void {
    const ghost = this.dragState.ghost;
    if (!ghost) return;

    ghost.style.left = `${clientX - this.dragState.offsetX}px`;
    ghost.style.top = `${clientY - this.dragState.offsetY}px`;
  }

  /**
   * プレースホルダを作成
   */
  private createPlaceholder(): HTMLElement {
    const placeholder = document.createElement('div');
    placeholder.className = 'tab-placeholder';
    return placeholder;
  }

  /**
   * ドラッグ終了時のクリーンアップ
   */
  private cleanupDrag(): void {
    if (this.dragState.draggedElement) {
      this.dragState.draggedElement.classList.remove('dragging');
    }

    this.dragState.placeholder?.remove();
    this.dragState.ghost?.remove();

    document.body.classList.remove('tab-dragging');

    if (this.boundMouseMove) {
      document.removeEventListener('mousemove', this.boundMouseMove);
      this.boundMouseMove = null;
    }
    if (this.boundMouseUp) {
      document.removeEventListener('mouseup', this.boundMouseUp);
      this.boundMouseUp = null;
    }

    this.dragState = {
      isDragging: false,
      isPending: false,
      draggedTabId: null,
      draggedElement: null,
      placeholder: null,
      ghost: null,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0,
      initialIndex: -1,
    };

    // UIを更新（タブ順序を反映）
    this.render();
  }
}
