/**
 * WelcomePanel - Initial welcome screen with drag-and-drop
 */
export class WelcomePanel {
  private panel: HTMLElement;
  private dropZone: HTMLElement;
  private browseBtn: HTMLElement;
  private fileInput: HTMLInputElement;

  private onFilesSelected: (files: FileList) => void;

  constructor(callbacks: {
    onFilesSelected: (files: FileList) => void;
  }) {
    this.onFilesSelected = callbacks.onFilesSelected;

    this.panel = document.getElementById('welcome-panel')!;
    this.dropZone = document.getElementById('drop-zone')!;
    this.browseBtn = document.getElementById('browse-btn')!;
    this.fileInput = document.getElementById('file-input')! as HTMLInputElement;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Browse button
    this.browseBtn.addEventListener('click', () => {
      this.fileInput.click();
    });

    // File input change
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files && this.fileInput.files.length > 0) {
        this.onFilesSelected(this.fileInput.files);
        this.fileInput.value = ''; // Reset for next selection
      }
    });

    // Drag and drop
    this.dropZone.addEventListener('dragover', this.handleDragOver.bind(this));
    this.dropZone.addEventListener('dragleave', this.handleDragLeave.bind(this));
    this.dropZone.addEventListener('drop', this.handleDrop.bind(this));

    // Also handle drag on the entire panel
    this.panel.addEventListener('dragover', this.handleDragOver.bind(this));
    this.panel.addEventListener('dragleave', this.handleDragLeave.bind(this));
    this.panel.addEventListener('drop', this.handleDrop.bind(this));

    // Keyboard shortcut (Ctrl+O)
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault();
        this.fileInput.click();
      }
    });
  }

  private handleDragOver(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.dropZone.classList.add('dragover');
  }

  private handleDragLeave(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.dropZone.classList.remove('dragover');
  }

  private handleDrop(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.dropZone.classList.remove('dragover');

    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      this.onFilesSelected(e.dataTransfer.files);
    }
  }

  show(): void {
    this.panel.style.display = 'flex';
  }

  hide(): void {
    this.panel.style.display = 'none';
  }

  isVisible(): boolean {
    return this.panel.style.display !== 'none';
  }
}
