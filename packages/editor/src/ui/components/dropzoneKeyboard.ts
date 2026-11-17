/**
 * ファイルのドロップゾーン (`role="button"` + `tabindex="0"` の div) をキーボードで押せるようにする (#743)。
 *
 * ゲート・ローダのドロップゾーンは見た目を保つため `<button>` にせず div のままにしている。div は
 * Enter / Space で click が起きないので、ボタンと同じキーで `activate` (ファイル選択を開く) を呼ぶ。
 * Space はページのスクロールを止めるため既定動作を取り消す。
 */
export function makeDropzoneKeyboardOperable(dropzone: HTMLElement, activate: () => void): void {
  dropzone.addEventListener('keydown', (e) => {
    if (e.target !== dropzone || e.repeat) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  });
}
