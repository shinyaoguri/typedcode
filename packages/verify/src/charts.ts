import type { StoredEvent, KeystrokeDynamicsData, MousePositionData, FocusChangeData, VisibilityChangeData, InputType } from '@typedcode/shared';
import type { IntegratedTimelineCache, MouseTrajectoryCache } from './types.js';
import {
  integratedTimeline,
  integratedTimelineCanvas,
  mouseTrajectorySection,
  mouseTrajectoryCanvas,
  mouseEventCountEl,
  focusEventCountEl,
  visibilityEventCountEl,
  keyDownCountEl,
  avgDwellTimeEl,
  avgFlightTimeEl,
  modalTimelineCanvas,
  modalMouseCanvas,
  modalMouseSection,
} from './elements.js';

// キャッシュ
let integratedTimelineCache: IntegratedTimelineCache | null = null;
let mouseTrajectoryCache: MouseTrajectoryCache | null = null;

// 外部からアクセスできるように
export function getIntegratedTimelineCache(): IntegratedTimelineCache | null {
  return integratedTimelineCache;
}

export function getMouseTrajectoryCache(): MouseTrajectoryCache | null {
  return mouseTrajectoryCache;
}

/**
 * キャンバスを初期化（デバイスピクセル比を考慮）
 */
function initCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const dpr = window.devicePixelRatio ?? 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  return { ctx, width: rect.width, height: rect.height };
}

/**
 * 統合タイムラインを描画（タイピング速度、フォーカス状態、キーストローク）
 */
export function drawIntegratedTimeline(events: StoredEvent[], currentEvents: StoredEvent[]): void {
  if (!integratedTimelineCanvas || !events || events.length === 0) {
    return;
  }

  // イベントを抽出
  const mouseEvents = events.filter(e => e.type === 'mousePositionChange');
  const focusEvents = events.filter(e => e.type === 'focusChange');
  const visibilityEvents = events.filter(e => e.type === 'visibilityChange');
  const keyDownEvents = events.filter(e => e.type === 'keyDown');
  const keyUpEvents = events.filter(e => e.type === 'keyUp');

  // 統計情報を更新
  if (mouseEventCountEl) mouseEventCountEl.textContent = String(mouseEvents.length);
  if (focusEventCountEl) focusEventCountEl.textContent = String(focusEvents.length);
  if (visibilityEventCountEl) visibilityEventCountEl.textContent = String(visibilityEvents.length);
  if (keyDownCountEl) keyDownCountEl.textContent = String(keyDownEvents.length);

  // Dwell/Flight Time の平均を計算
  const dwellTimes: number[] = [];
  keyUpEvents.forEach(event => {
    const data = event.data as KeystrokeDynamicsData | null;
    if (data && typeof data === 'object' && 'dwellTime' in data && data.dwellTime !== undefined) {
      dwellTimes.push(data.dwellTime);
    }
  });
  const avgDwellTime = dwellTimes.length > 0
    ? dwellTimes.reduce((a, b) => a + b, 0) / dwellTimes.length
    : 0;
  if (avgDwellTimeEl) avgDwellTimeEl.textContent = `${avgDwellTime.toFixed(1)}ms`;

  const flightTimes: number[] = [];
  keyDownEvents.forEach(event => {
    const data = event.data as KeystrokeDynamicsData | null;
    if (data && typeof data === 'object' && 'flightTime' in data && data.flightTime !== undefined) {
      flightTimes.push(data.flightTime);
    }
  });
  const avgFlightTime = flightTimes.length > 0
    ? flightTimes.reduce((a, b) => a + b, 0) / flightTimes.length
    : 0;
  if (avgFlightTimeEl) avgFlightTimeEl.textContent = `${avgFlightTime.toFixed(1)}ms`;

  // マウス軌跡を描画（別キャンバス）
  if (mouseEvents.length > 0) {
    if (mouseTrajectorySection) mouseTrajectorySection.style.display = 'block';
    drawMouseTrajectory(mouseEvents, currentEvents);
  } else {
    if (mouseTrajectorySection) mouseTrajectorySection.style.display = 'none';
  }

  // 統合キャンバスを描画
  const canvasInit = initCanvas(integratedTimelineCanvas);
  if (!canvasInit) return;
  const { ctx, width, height } = canvasInit;

  const padding = { top: 30, right: 20, bottom: 50, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const lastEvent = events[events.length - 1];
  const totalTime = lastEvent?.timestamp ?? 0;

  // 背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // === タイピング速度データを準備 ===
  const windowSize = 5000;
  const typingSpeedData: { time: number; speed: number }[] = [];
  const externalInputMarkers: { time: number; type: InputType }[] = [];

  for (let time = 0; time <= totalTime; time += 1000) {
    const windowStart = Math.max(0, time - windowSize);
    const windowEnd = time;

    let charCount = 0;
    events.forEach(event => {
      if (event.timestamp >= windowStart && event.timestamp <= windowEnd) {
        if (event.type === 'contentChange' && event.data &&
            event.inputType !== 'insertFromPaste' && event.inputType !== 'insertFromDrop') {
          charCount += (typeof event.data === 'string' ? event.data.length : 0);
        }
      }
    });

    const speed = charCount / (windowSize / 1000);
    typingSpeedData.push({ time: time / 1000, speed });
  }

  events.forEach(event => {
    if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
      externalInputMarkers.push({
        time: event.timestamp / 1000,
        type: event.inputType
      });
    }
  });

  // === キーストロークデータを準備 ===
  const keyUpData: { time: number; dwellTime: number; key: string; eventIndex: number }[] = [];
  const keyDownData: { time: number; flightTime: number; key: string; eventIndex: number }[] = [];
  let maxKeystrokeTime = 0;

  keyUpEvents.forEach(event => {
    const data = event.data as KeystrokeDynamicsData | null;
    if (data && typeof data === 'object' && 'dwellTime' in data && data.dwellTime !== undefined) {
      const eventIndex = currentEvents.findIndex(e => e.sequence === event.sequence);
      keyUpData.push({
        time: event.timestamp,
        dwellTime: data.dwellTime,
        key: data.key,
        eventIndex
      });
      maxKeystrokeTime = Math.max(maxKeystrokeTime, data.dwellTime);
    }
  });

  keyDownEvents.forEach(event => {
    const data = event.data as KeystrokeDynamicsData | null;
    if (data && typeof data === 'object' && 'flightTime' in data && data.flightTime !== undefined) {
      const eventIndex = currentEvents.findIndex(e => e.sequence === event.sequence);
      keyDownData.push({
        time: event.timestamp,
        flightTime: data.flightTime,
        key: data.key,
        eventIndex
      });
      maxKeystrokeTime = Math.max(maxKeystrokeTime, data.flightTime);
    }
  });

  maxKeystrokeTime = Math.ceil(maxKeystrokeTime / 100) * 100 || 300;
  const maxSpeed = Math.max(...typingSpeedData.map(d => d.speed), 1);
  const yMaxSpeed = Math.ceil(maxSpeed * 1.2);

  // キャッシュを保存
  integratedTimelineCache = {
    totalTime,
    padding,
    chartWidth,
    chartHeight,
    typingSpeedData,
    externalInputMarkers,
    focusEvents,
    visibilityEvents,
    keyUpData,
    keyDownData,
    maxSpeed: yMaxSpeed,
    maxKeystrokeTime
  };

  // レイアウト: 上からフォーカスバー、タイピング速度、キーストローク
  const focusBarHeight = 12;
  const visibilityBarHeight = 12;
  const gapBetweenBars = 6;
  const focusAreaHeight = focusBarHeight + gapBetweenBars + visibilityBarHeight + 20;
  const speedChartHeight = (chartHeight - focusAreaHeight) * 0.5;
  const keystrokeChartHeight = (chartHeight - focusAreaHeight) * 0.5;

  const focusY = padding.top;
  const visibilityY = focusY + focusBarHeight + gapBetweenBars;
  const speedChartY = focusY + focusAreaHeight;
  const keystrokeY = speedChartY + speedChartHeight;

  // === フォーカス・Visibilityバーを描画 ===
  drawFocusBar(ctx, focusEvents, padding.left, focusY, chartWidth, focusBarHeight, totalTime, true);
  drawFocusBar(ctx, visibilityEvents, padding.left, visibilityY, chartWidth, visibilityBarHeight, totalTime, false);

  // ラベル
  ctx.fillStyle = '#666';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Focus', padding.left - 5, focusY + focusBarHeight / 2 + 3);
  ctx.fillText('Tab', padding.left - 5, visibilityY + visibilityBarHeight / 2 + 3);

  // === タイピング速度を描画 ===
  // グリッド線
  ctx.strokeStyle = '#e9ecef';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = speedChartY + (speedChartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }

  // Y軸ラベル
  ctx.fillStyle = '#666';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = speedChartY + (speedChartHeight / 4) * i;
    const value = yMaxSpeed - (yMaxSpeed / 4) * i;
    ctx.fillText(value.toFixed(0), padding.left - 5, y + 3);
  }

  // 外部入力マーカー
  externalInputMarkers.forEach(marker => {
    const x = padding.left + (marker.time / (totalTime / 1000)) * chartWidth;
    ctx.fillStyle = 'rgba(255, 193, 7, 0.3)';
    ctx.fillRect(x - 2, speedChartY, 4, speedChartHeight);
  });

  // タイピング速度ライン
  ctx.strokeStyle = '#667eea';
  ctx.lineWidth = 2;
  ctx.beginPath();

  typingSpeedData.forEach((point, index) => {
    const x = padding.left + (point.time / (totalTime / 1000)) * chartWidth;
    const y = speedChartY + speedChartHeight - (point.speed / yMaxSpeed) * speedChartHeight;

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();

  // === キーストロークを描画 ===
  // グリッド線
  ctx.strokeStyle = '#e9ecef';
  for (let i = 0; i <= 4; i++) {
    const y = keystrokeY + (keystrokeChartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }

  // Y軸ラベル
  for (let i = 0; i <= 4; i++) {
    const y = keystrokeY + (keystrokeChartHeight / 4) * i;
    const value = maxKeystrokeTime - (maxKeystrokeTime / 4) * i;
    ctx.fillText(`${value.toFixed(0)}`, padding.left - 5, y + 3);
  }

  // Dwell Time（青い点）
  ctx.fillStyle = 'rgba(102, 126, 234, 0.6)';
  keyUpData.forEach(point => {
    const x = padding.left + (point.time / totalTime) * chartWidth;
    const y = keystrokeY + keystrokeChartHeight - (point.dwellTime / maxKeystrokeTime) * keystrokeChartHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Flight Time（緑の点）
  ctx.fillStyle = 'rgba(40, 167, 69, 0.6)';
  keyDownData.forEach(point => {
    const x = padding.left + (point.time / totalTime) * chartWidth;
    const y = keystrokeY + keystrokeChartHeight - (point.flightTime / maxKeystrokeTime) * keystrokeChartHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // === X軸（時間） ===
  const timeStep = Math.ceil(totalTime / 1000 / 10);
  for (let t = 0; t <= totalTime / 1000; t += timeStep) {
    const x = padding.left + (t / (totalTime / 1000)) * chartWidth;
    ctx.strokeStyle = '#e9ecef';
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();

    ctx.fillStyle = '#666';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${t.toFixed(0)}s`, x, height - padding.bottom + 15);
  }

  // Y軸ラベル（セクション名）
  ctx.fillStyle = '#333';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.save();
  ctx.translate(12, speedChartY + speedChartHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('速度 (文字/秒)', 0, 0);
  ctx.restore();

  ctx.save();
  ctx.translate(12, keystrokeY + keystrokeChartHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('キー (ms)', 0, 0);
  ctx.restore();
}

/**
 * フォーカス/Visibility バーを描画
 */
function drawFocusBar(
  ctx: CanvasRenderingContext2D,
  events: StoredEvent[],
  x: number,
  y: number,
  width: number,
  height: number,
  totalTime: number,
  isFocus: boolean
): void {
  let lastTime = 0;
  let lastState = true;

  events.forEach(event => {
    const data = isFocus
      ? (event.data as FocusChangeData | null)
      : (event.data as VisibilityChangeData | null);
    if (!data || typeof data !== 'object') return;

    const state = isFocus ? ('focused' in data && data.focused) : ('visible' in data && data.visible);

    const startX = x + (lastTime / totalTime) * width;
    const endX = x + (event.timestamp / totalTime) * width;

    ctx.fillStyle = lastState ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)';
    ctx.fillRect(startX, y, endX - startX, height);

    lastTime = event.timestamp;
    lastState = !!state;
  });

  // 最後のセグメント
  const lastX = x + (lastTime / totalTime) * width;
  ctx.fillStyle = lastState ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)';
  ctx.fillRect(lastX, y, x + width - lastX, height);
}

/**
 * マウス軌跡を描画
 */
function drawMouseTrajectory(mouseEvents: StoredEvent[], currentEvents: StoredEvent[]): void {
  if (!mouseTrajectoryCanvas) return;

  const canvasInit = initCanvas(mouseTrajectoryCanvas);
  if (!canvasInit) return;
  const { ctx, width, height } = canvasInit;

  const padding = { top: 20, right: 20, bottom: 20, left: 20 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // 背景
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, width, height);

  // マウス位置データを抽出（イベントインデックス付き）
  const positions: { x: number; y: number; time: number; eventIndex: number }[] = [];
  let maxX = 0;
  let maxY = 0;

  mouseEvents.forEach(event => {
    const data = event.data as MousePositionData | null;
    if (data && typeof data === 'object' && 'x' in data && 'y' in data) {
      const eventIndex = currentEvents.findIndex(e => e.sequence === event.sequence);
      positions.push({ x: data.x, y: data.y, time: event.timestamp, eventIndex });
      maxX = Math.max(maxX, data.x);
      maxY = Math.max(maxY, data.y);
    }
  });

  if (positions.length === 0) return;

  // スケーリング
  const scaleX = chartWidth / (maxX || 1);
  const scaleY = chartHeight / (maxY || 1);
  const scale = Math.min(scaleX, scaleY);

  // キャッシュを保存
  mouseTrajectoryCache = { positions, scale, padding, maxX, maxY };

  // 時間に基づいて色を変化させる
  const startTime = positions[0]?.time ?? 0;
  const endTime = positions[positions.length - 1]?.time ?? 1;
  const timeRange = endTime - startTime || 1;

  // 軌跡を描画
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1]!;
    const curr = positions[i]!;

    // 時間に基づいて色を計算（青→緑→黄→赤）
    const t = (curr.time - startTime) / timeRange;
    const hue = (1 - t) * 240; // 青(240)から赤(0)へ
    ctx.strokeStyle = `hsla(${hue}, 80%, 50%, 0.7)`;

    ctx.beginPath();
    ctx.moveTo(padding.left + prev.x * scale, padding.top + prev.y * scale);
    ctx.lineTo(padding.left + curr.x * scale, padding.top + curr.y * scale);
    ctx.stroke();
  }

  // 開始点と終了点を強調
  if (positions.length > 0) {
    const start = positions[0]!;
    const end = positions[positions.length - 1]!;

    // 開始点（緑）
    ctx.fillStyle = '#28a745';
    ctx.beginPath();
    ctx.arc(padding.left + start.x * scale, padding.top + start.y * scale, 6, 0, Math.PI * 2);
    ctx.fill();

    // 終了点（赤）
    ctx.fillStyle = '#dc3545';
    ctx.beginPath();
    ctx.arc(padding.left + end.x * scale, padding.top + end.y * scale, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // 凡例
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#28a745';
  ctx.fillText('● 開始', width - 100, 20);
  ctx.fillStyle = '#dc3545';
  ctx.fillText('● 終了', width - 50, 20);
}

/**
 * マウス軌跡チャート上に現在位置マーカーを更新
 */
export function updateMouseTrajectoryMarker(eventIndex: number, currentEvents: StoredEvent[]): void {
  if (!mouseTrajectoryCanvas || !mouseTrajectoryCache) return;

  const canvasInit = initCanvas(mouseTrajectoryCanvas);
  if (!canvasInit) return;
  const { ctx, width, height } = canvasInit;

  const { positions, scale, padding } = mouseTrajectoryCache;

  // 現在のイベントインデックスまでの最後のマウス位置を見つける
  let currentPos: { x: number; y: number } | null = null;
  const visitedPositions: { x: number; y: number }[] = [];

  for (const pos of positions) {
    if (pos.eventIndex < eventIndex) {
      visitedPositions.push({ x: pos.x, y: pos.y });
      currentPos = { x: pos.x, y: pos.y };
    } else if (pos.eventIndex === eventIndex) {
      visitedPositions.push({ x: pos.x, y: pos.y });
      currentPos = { x: pos.x, y: pos.y };
      break;
    }
  }

  // 背景
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, width, height);

  // 全軌跡を薄く描画
  if (positions.length > 1) {
    ctx.strokeStyle = 'rgba(100, 100, 100, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const first = positions[0]!;
    ctx.moveTo(padding.left + first.x * scale, padding.top + first.y * scale);
    for (let i = 1; i < positions.length; i++) {
      const pos = positions[i]!;
      ctx.lineTo(padding.left + pos.x * scale, padding.top + pos.y * scale);
    }
    ctx.stroke();
  }

  // 訪問済み軌跡を明るく描画
  if (visitedPositions.length > 1) {
    const startTime = positions[0]?.time ?? 0;
    const endTime = positions[positions.length - 1]?.time ?? 1;
    const timeRange = endTime - startTime || 1;

    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < visitedPositions.length; i++) {
      const prev = visitedPositions[i - 1]!;
      const curr = visitedPositions[i]!;

      // 対応するpositionsのインデックスを探して時間を取得
      const posIndex = positions.findIndex(p => p.x === curr.x && p.y === curr.y);
      const currTime = posIndex >= 0 ? positions[posIndex]!.time : startTime;
      const t = (currTime - startTime) / timeRange;
      const hue = (1 - t) * 240;
      ctx.strokeStyle = `hsla(${hue}, 80%, 50%, 0.8)`;

      ctx.beginPath();
      ctx.moveTo(padding.left + prev.x * scale, padding.top + prev.y * scale);
      ctx.lineTo(padding.left + curr.x * scale, padding.top + curr.y * scale);
      ctx.stroke();
    }
  }

  // 開始点
  if (positions.length > 0) {
    const start = positions[0]!;
    ctx.fillStyle = '#28a745';
    ctx.beginPath();
    ctx.arc(padding.left + start.x * scale, padding.top + start.y * scale, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 現在位置マーカー（黄色の円）
  if (currentPos) {
    // 外側の輪郭
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(padding.left + currentPos.x * scale, padding.top + currentPos.y * scale, 10, 0, Math.PI * 2);
    ctx.stroke();

    // 内側の円
    ctx.fillStyle = '#ffc107';
    ctx.beginPath();
    ctx.arc(padding.left + currentPos.x * scale, padding.top + currentPos.y * scale, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  // 終了点（全て訪問済みの場合）
  if (eventIndex >= currentEvents.length && positions.length > 0) {
    const end = positions[positions.length - 1]!;
    ctx.fillStyle = '#dc3545';
    ctx.beginPath();
    ctx.arc(padding.left + end.x * scale, padding.top + end.y * scale, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // 凡例
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#28a745';
  ctx.fillText('● 開始', width - 140, 20);
  ctx.fillStyle = '#ffc107';
  ctx.fillText('● 現在', width - 90, 20);
  ctx.fillStyle = '#dc3545';
  ctx.fillText('● 終了', width - 40, 20);
}

/**
 * 統合タイムラインに現在位置マーカーを描画
 */
export function updateIntegratedTimelineMarker(eventIndex: number, currentEvents: StoredEvent[]): void {
  if (!integratedTimelineCanvas || !integratedTimelineCache) return;
  if (currentEvents.length === 0) return;

  const ctx = integratedTimelineCanvas.getContext('2d');
  if (!ctx) return;

  const { totalTime, padding, chartHeight } = integratedTimelineCache;

  // 現在のイベントのタイムスタンプを取得
  const currentEvent = eventIndex > 0 && eventIndex <= currentEvents.length
    ? currentEvents[eventIndex - 1]
    : null;
  const currentTime = currentEvent?.timestamp ?? 0;

  // 現在位置のX座標を計算
  const rect = integratedTimelineCanvas.getBoundingClientRect();
  const chartWidth = rect.width - padding.left - padding.right;
  const markerX = padding.left + (currentTime / totalTime) * chartWidth;

  // マーカーを描画（縦線）
  ctx.strokeStyle = '#ffc107';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(markerX, padding.top);
  ctx.lineTo(markerX, padding.top + chartHeight);
  ctx.stroke();

  // マーカーの三角形（上）
  ctx.fillStyle = '#ffc107';
  ctx.beginPath();
  ctx.moveTo(markerX, padding.top - 8);
  ctx.lineTo(markerX - 5, padding.top);
  ctx.lineTo(markerX + 5, padding.top);
  ctx.closePath();
  ctx.fill();
}

/**
 * 統合タイムラインを表示
 */
export function showIntegratedTimeline(): void {
  if (integratedTimeline) integratedTimeline.style.display = 'block';
}

/**
 * 統合タイムラインを非表示
 */
export function hideIntegratedTimeline(): void {
  if (integratedTimeline) integratedTimeline.style.display = 'none';
}

// イベントデータをキャッシュ（モーダル描画用）
let cachedEvents: StoredEvent[] = [];
let cachedCurrentEvents: StoredEvent[] = [];

/**
 * イベントデータをキャッシュ
 */
export function cacheEventsForModal(events: StoredEvent[], currentEvents: StoredEvent[]): void {
  cachedEvents = events;
  cachedCurrentEvents = currentEvents;
}

/**
 * モーダル用のチャートを描画
 */
export function drawModalCharts(): void {
  if (cachedEvents.length === 0) return;

  // モーダル用タイムラインを描画
  if (modalTimelineCanvas) {
    drawTimelineOnCanvas(modalTimelineCanvas, cachedEvents, cachedCurrentEvents);
  }

  // モーダル用マウス軌跡を描画
  const mouseEvents = cachedEvents.filter(e => e.type === 'mousePositionChange');
  if (mouseEvents.length > 0 && modalMouseCanvas) {
    if (modalMouseSection) modalMouseSection.style.display = 'block';
    drawMouseTrajectoryOnCanvas(modalMouseCanvas, mouseEvents, cachedCurrentEvents);
  } else {
    if (modalMouseSection) modalMouseSection.style.display = 'none';
  }
}

/**
 * 指定されたキャンバスにタイムラインを描画
 */
function drawTimelineOnCanvas(canvas: HTMLCanvasElement, events: StoredEvent[], _currentEvents: StoredEvent[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio ?? 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;

  const focusEvents = events.filter(e => e.type === 'focusChange');
  const visibilityEvents = events.filter(e => e.type === 'visibilityChange');
  const keyDownEvents = events.filter(e => e.type === 'keyDown');
  const keyUpEvents = events.filter(e => e.type === 'keyUp');

  const padding = { top: 30, right: 20, bottom: 50, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const lastEvent = events[events.length - 1];
  const totalTime = lastEvent?.timestamp ?? 0;

  // 背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // タイピング速度データを準備
  const windowSize = 5000;
  const typingSpeedData: { time: number; speed: number }[] = [];
  const externalInputMarkers: { time: number; type: InputType }[] = [];

  for (let time = 0; time <= totalTime; time += 1000) {
    const windowStart = Math.max(0, time - windowSize);
    const windowEnd = time;

    let charCount = 0;
    events.forEach(event => {
      if (event.timestamp >= windowStart && event.timestamp <= windowEnd) {
        if (event.type === 'contentChange' && event.data &&
            event.inputType !== 'insertFromPaste' && event.inputType !== 'insertFromDrop') {
          charCount += (typeof event.data === 'string' ? event.data.length : 0);
        }
      }
    });

    const speed = charCount / (windowSize / 1000);
    typingSpeedData.push({ time: time / 1000, speed });
  }

  events.forEach(event => {
    if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
      externalInputMarkers.push({
        time: event.timestamp / 1000,
        type: event.inputType
      });
    }
  });

  // キーストロークデータを準備
  const keyUpData: { time: number; dwellTime: number }[] = [];
  const keyDownData: { time: number; flightTime: number }[] = [];
  let maxKeystrokeTime = 0;

  keyUpEvents.forEach(event => {
    const data = event.data as KeystrokeDynamicsData | null;
    if (data && typeof data === 'object' && 'dwellTime' in data && data.dwellTime !== undefined) {
      keyUpData.push({ time: event.timestamp, dwellTime: data.dwellTime });
      maxKeystrokeTime = Math.max(maxKeystrokeTime, data.dwellTime);
    }
  });

  keyDownEvents.forEach(event => {
    const data = event.data as KeystrokeDynamicsData | null;
    if (data && typeof data === 'object' && 'flightTime' in data && data.flightTime !== undefined) {
      keyDownData.push({ time: event.timestamp, flightTime: data.flightTime });
      maxKeystrokeTime = Math.max(maxKeystrokeTime, data.flightTime);
    }
  });

  maxKeystrokeTime = Math.ceil(maxKeystrokeTime / 100) * 100 || 300;
  const maxSpeed = Math.max(...typingSpeedData.map(d => d.speed), 1);
  const yMaxSpeed = Math.ceil(maxSpeed * 1.2);

  // レイアウト
  const focusBarHeight = 12;
  const visibilityBarHeight = 12;
  const gapBetweenBars = 6;
  const focusAreaHeight = focusBarHeight + gapBetweenBars + visibilityBarHeight + 20;
  const speedChartHeight = (chartHeight - focusAreaHeight) * 0.5;
  const keystrokeChartHeight = (chartHeight - focusAreaHeight) * 0.5;

  const focusY = padding.top;
  const visibilityY = focusY + focusBarHeight + gapBetweenBars;
  const speedChartY = focusY + focusAreaHeight;
  const keystrokeY = speedChartY + speedChartHeight;

  // フォーカス・Visibilityバー
  drawFocusBarOnCtx(ctx, focusEvents, padding.left, focusY, chartWidth, focusBarHeight, totalTime, true);
  drawFocusBarOnCtx(ctx, visibilityEvents, padding.left, visibilityY, chartWidth, visibilityBarHeight, totalTime, false);

  ctx.fillStyle = '#666';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Focus', padding.left - 5, focusY + focusBarHeight / 2 + 3);
  ctx.fillText('Tab', padding.left - 5, visibilityY + visibilityBarHeight / 2 + 3);

  // タイピング速度グリッド
  ctx.strokeStyle = '#e9ecef';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = speedChartY + (speedChartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }

  ctx.fillStyle = '#666';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = speedChartY + (speedChartHeight / 4) * i;
    const value = yMaxSpeed - (yMaxSpeed / 4) * i;
    ctx.fillText(value.toFixed(0), padding.left - 5, y + 3);
  }

  // 外部入力マーカー
  externalInputMarkers.forEach(marker => {
    const x = padding.left + (marker.time / (totalTime / 1000)) * chartWidth;
    ctx.fillStyle = 'rgba(255, 193, 7, 0.3)';
    ctx.fillRect(x - 2, speedChartY, 4, speedChartHeight);
  });

  // タイピング速度ライン
  ctx.strokeStyle = '#667eea';
  ctx.lineWidth = 2;
  ctx.beginPath();
  typingSpeedData.forEach((point, index) => {
    const x = padding.left + (point.time / (totalTime / 1000)) * chartWidth;
    const y = speedChartY + speedChartHeight - (point.speed / yMaxSpeed) * speedChartHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  // キーストロークグリッド
  ctx.strokeStyle = '#e9ecef';
  for (let i = 0; i <= 4; i++) {
    const y = keystrokeY + (keystrokeChartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }

  for (let i = 0; i <= 4; i++) {
    const y = keystrokeY + (keystrokeChartHeight / 4) * i;
    const value = maxKeystrokeTime - (maxKeystrokeTime / 4) * i;
    ctx.fillText(`${value.toFixed(0)}`, padding.left - 5, y + 3);
  }

  // Dwell Time
  ctx.fillStyle = 'rgba(102, 126, 234, 0.6)';
  keyUpData.forEach(point => {
    const x = padding.left + (point.time / totalTime) * chartWidth;
    const y = keystrokeY + keystrokeChartHeight - (point.dwellTime / maxKeystrokeTime) * keystrokeChartHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Flight Time
  ctx.fillStyle = 'rgba(40, 167, 69, 0.6)';
  keyDownData.forEach(point => {
    const x = padding.left + (point.time / totalTime) * chartWidth;
    const y = keystrokeY + keystrokeChartHeight - (point.flightTime / maxKeystrokeTime) * keystrokeChartHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // X軸
  const timeStep = Math.ceil(totalTime / 1000 / 10);
  for (let t = 0; t <= totalTime / 1000; t += timeStep) {
    const x = padding.left + (t / (totalTime / 1000)) * chartWidth;
    ctx.strokeStyle = '#e9ecef';
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();

    ctx.fillStyle = '#666';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${t.toFixed(0)}s`, x, height - padding.bottom + 15);
  }

  // Y軸ラベル
  ctx.fillStyle = '#333';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.save();
  ctx.translate(12, speedChartY + speedChartHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('速度 (文字/秒)', 0, 0);
  ctx.restore();

  ctx.save();
  ctx.translate(12, keystrokeY + keystrokeChartHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('キー (ms)', 0, 0);
  ctx.restore();
}

/**
 * フォーカスバーを描画（汎用）
 */
function drawFocusBarOnCtx(
  ctx: CanvasRenderingContext2D,
  events: StoredEvent[],
  x: number,
  y: number,
  width: number,
  height: number,
  totalTime: number,
  isFocus: boolean
): void {
  let lastTime = 0;
  let lastState = true;

  events.forEach(event => {
    const data = isFocus
      ? (event.data as FocusChangeData | null)
      : (event.data as VisibilityChangeData | null);
    if (!data || typeof data !== 'object') return;

    const state = isFocus ? ('focused' in data && data.focused) : ('visible' in data && data.visible);

    const startX = x + (lastTime / totalTime) * width;
    const endX = x + (event.timestamp / totalTime) * width;

    ctx.fillStyle = lastState ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)';
    ctx.fillRect(startX, y, endX - startX, height);

    lastTime = event.timestamp;
    lastState = !!state;
  });

  const lastX = x + (lastTime / totalTime) * width;
  ctx.fillStyle = lastState ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)';
  ctx.fillRect(lastX, y, x + width - lastX, height);
}

/**
 * 指定されたキャンバスにマウス軌跡を描画
 */
function drawMouseTrajectoryOnCanvas(canvas: HTMLCanvasElement, mouseEvents: StoredEvent[], _currentEvents: StoredEvent[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio ?? 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;

  const padding = { top: 20, right: 20, bottom: 20, left: 20 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // 背景
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, width, height);

  // マウス位置データを抽出
  const positions: { x: number; y: number; time: number }[] = [];
  let maxX = 0;
  let maxY = 0;

  mouseEvents.forEach(event => {
    const data = event.data as MousePositionData | null;
    if (data && typeof data === 'object' && 'x' in data && 'y' in data) {
      positions.push({ x: data.x, y: data.y, time: event.timestamp });
      maxX = Math.max(maxX, data.x);
      maxY = Math.max(maxY, data.y);
    }
  });

  if (positions.length === 0) return;

  const scaleX = chartWidth / (maxX || 1);
  const scaleY = chartHeight / (maxY || 1);
  const scale = Math.min(scaleX, scaleY);

  const startTime = positions[0]?.time ?? 0;
  const endTime = positions[positions.length - 1]?.time ?? 1;
  const timeRange = endTime - startTime || 1;

  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1]!;
    const curr = positions[i]!;

    const t = (curr.time - startTime) / timeRange;
    const hue = (1 - t) * 240;
    ctx.strokeStyle = `hsla(${hue}, 80%, 50%, 0.7)`;

    ctx.beginPath();
    ctx.moveTo(padding.left + prev.x * scale, padding.top + prev.y * scale);
    ctx.lineTo(padding.left + curr.x * scale, padding.top + curr.y * scale);
    ctx.stroke();
  }

  // 開始点と終了点
  if (positions.length > 0) {
    const start = positions[0]!;
    const end = positions[positions.length - 1]!;

    ctx.fillStyle = '#28a745';
    ctx.beginPath();
    ctx.arc(padding.left + start.x * scale, padding.top + start.y * scale, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#dc3545';
    ctx.beginPath();
    ctx.arc(padding.left + end.x * scale, padding.top + end.y * scale, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // 凡例
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#28a745';
  ctx.fillText('● 開始', width - 100, 20);
  ctx.fillStyle = '#dc3545';
  ctx.fillText('● 終了', width - 50, 20);
}
