import type { ExportedProof, StoredEvent, InputType } from '../types.js';

// Extended proof data with content and language
export interface ProofFile extends ExportedProof {
  content: string;
  language: string;
}

// Content cache type
export type ContentCache = Map<number, string>;

// Loading log state
export interface LoadingLog {
  container: HTMLElement | null;
  logList: HTMLElement | null;
  startTime: number;
}

// Mouse trajectory cache
export interface MouseTrajectoryCache {
  positions: { x: number; y: number; time: number; eventIndex: number }[];
  scale: number;
  padding: { top: number; right: number; bottom: number; left: number };
  maxX: number;
  maxY: number;
}

// Integrated timeline cache
export interface IntegratedTimelineCache {
  totalTime: number;
  padding: { top: number; right: number; bottom: number; left: number };
  chartWidth: number;
  chartHeight: number;
  typingSpeedData: { time: number; speed: number }[];
  externalInputMarkers: { time: number; type: InputType }[];
  focusEvents: StoredEvent[];
  visibilityEvents: StoredEvent[];
  keyUpData: { time: number; dwellTime: number; key: string; eventIndex: number }[];
  keyDownData: { time: number; flightTime: number; key: string; eventIndex: number }[];
  maxSpeed: number;
  maxKeystrokeTime: number;
}

// External input marker
export interface ExternalInputMarker {
  time: number;
  type: InputType;
}
