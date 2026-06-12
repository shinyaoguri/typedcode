/**
 * セッション開始トークン (ADR-0017) の型定義 (browser/DOM 非依存).
 *
 * casual / class セッション開始時に Workers が 1 つ発行する ECDSA-P256 署名済みトークン。
 * `serverNonce` を chain root に焼くことで root をサーバアンカーし、完全オフライン捏造を封じる。
 * 同時に Turnstile 結果を束縛し、人間ゲートの暗号的証拠 (HMAC attestation の置換) になる。
 *
 * これらの型は Cloudflare Workers / Node tooling からも import されるため、
 * 他の types/* ファイルに依存しない独立した型ファイルにしている (signedCheckpoint.ts と同方針)。
 */

/** 署名対象の payload */
export interface SessionStartTokenPayload {
  version: 1;
  /** クライアント生成の sessionId (署名 cp と一致することを検証器が要求) */
  sessionId: string;
  /** サーバ生成の 32 バイト nonce (64 桁 hex)。root = SHA256(fp ‖ localNonce ‖ serverNonce) に焼く */
  serverNonce: string;
  /** クライアントが申告した fingerprintHash。proof.fingerprint.hash との一致を検証器が要求 */
  fingerprintHash: string;
  /** サーバ時刻 (ISO)。root はこの時刻以降に始まる = 開始時刻アンカー */
  issuedAt: string;
  /** Turnstile 検証に成功したか (人間ゲート) */
  turnstileVerified: boolean;
  /** Turnstile hostname (監査用)。取得不能なら null */
  hostname: string | null;
  /** Turnstile action (監査用)。取得不能なら null */
  action: string | null;
  /** 開始時点で合意した PoSW 反復数 */
  poswIterations: number;
}

/** 署名アルゴリズム識別子 */
export type SessionStartTokenAlgorithm = 'ECDSA-P256';

/** 署名 envelope (payload + 署名 + 鍵参照)。署名 cp と同じく registry-only で検証する。 */
export interface SessionStartToken {
  payload: SessionStartTokenPayload;
  signature: string;
  keyId: string;
  algorithm: SessionStartTokenAlgorithm;
}

/** セッション開始トークンの検証結果 */
export interface SessionStartTokenVerificationResult {
  valid: boolean;
  reason?: string;
  /** 検証に用いた registry 鍵の keyId (鍵 rotation/revoke 表示用) */
  keyId?: string;
}
