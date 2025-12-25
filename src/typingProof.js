/**
 * TypingProof - タイピング証明システム
 * コピペを禁止し、全ての操作をハッシュ鎖として記録
 */

export class TypingProof {
  constructor() {
    this.events = [];
    this.currentHash = null;  // 非同期初期化を待つ
    this.fingerprint = null;
    this.fingerprintComponents = null;
    this.startTime = performance.now();
    this.initialized = false;
    this.recordQueue = Promise.resolve();  // イベント記録の排他制御用
  }

  /**
   * 初期化（非同期）
   * フィンガープリントを生成して初期ハッシュを設定
   */
  async initialize(fingerprintHash, fingerprintComponents) {
    this.fingerprint = fingerprintHash;
    this.fingerprintComponents = fingerprintComponents;
    this.currentHash = await this.initialHash(fingerprintHash);
    this.initialized = true;
  }

  /**
   * 初期ハッシュを生成（フィンガープリント + ランダム値）
   */
  async initialHash(fingerprintHash) {
    const randomData = new Uint8Array(32);
    crypto.getRandomValues(randomData);
    const randomHex = this.arrayBufferToHex(randomData);

    // フィンガープリント + ランダム値をハッシュ化
    const combined = fingerprintHash + randomHex;
    return await this.computeHash(combined);
  }

  /**
   * ArrayBufferを16進数文字列に変換
   */
  arrayBufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * 文字列からSHA-256ハッシュを計算
   */
  async computeHash(data) {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    return this.arrayBufferToHex(hashBuffer);
  }

  /**
   * イベントを記録してハッシュ鎖を更新（排他制御付き）
   * @returns {Promise<{hash: string, index: number}>} ハッシュと配列のインデックス
   */
  async recordEvent(event) {
    // 前のイベント記録が完了するまで待つ（排他制御）
    this.recordQueue = this.recordQueue.then(() => this._recordEventInternal(event));
    return this.recordQueue;
  }

  /**
   * イベントを記録する内部実装
   * @private
   */
  async _recordEventInternal(event) {
    const timestamp = performance.now() - this.startTime;
    const sequence = this.events.length;

    // ハッシュ計算に使用するフィールド（検証時と一致させる必要がある）
    const eventData = {
      sequence,
      timestamp,
      type: event.type,
      inputType: event.inputType || null,
      data: event.data || null,
      rangeOffset: event.rangeOffset || null,
      rangeLength: event.rangeLength || null,
      range: event.range || null,  // 位置情報を追加
      previousHash: this.currentHash
    };

    // イベントデータを文字列化してハッシュ計算
    const eventString = JSON.stringify(eventData);
    const combinedData = this.currentHash + eventString;
    this.currentHash = await this.computeHash(combinedData);

    // デバッグ: ハッシュ計算に使用したデータをログ出力
    if (this.events.length < 5 || event.type === 'selectionChange') {
      console.log(`[Record] Event ${this.events.length}:`, {
        type: event.type,
        eventData,
        eventString,
        hash: this.currentHash
      });
    }

    // イベントを保存（ハッシュ計算に使用したフィールド + 追加のメタデータ）
    const eventIndex = this.events.length;
    this.events.push({
      ...eventData,
      hash: this.currentHash,
      // 以下は表示用のメタデータ（ハッシュ計算には含めない）
      description: event.description || null,
      isMultiLine: event.isMultiLine || null,
      deletedLength: event.deletedLength || null,
      insertedText: event.insertedText || null,
      insertLength: event.insertLength || null,
      deleteDirection: event.deleteDirection || null,
      selectedText: event.selectedText || null
    });

    return { hash: this.currentHash, index: eventIndex };
  }

  /**
   * 入力タイプが許可されているかチェック
   */
  isAllowedInputType(inputType) {
    // 許可される操作
    const allowedTypes = [
      'insertText',
      'insertLineBreak',
      'insertParagraph',
      'deleteContentBackward',
      'deleteContentForward',
      'deleteWordBackward',
      'deleteWordForward',
      'deleteSoftLineBackward',
      'deleteSoftLineForward',
      'deleteHardLineBackward',
      'deleteHardLineForward',
      'deleteByDrag',
      'historyUndo',
      'historyRedo',
      'insertCompositionText',
      'deleteCompositionText',
      'insertFromComposition'
    ];

    return allowedTypes.includes(inputType);
  }

  /**
   * 禁止される操作かチェック
   */
  isProhibitedInputType(inputType) {
    // 禁止される操作
    const prohibitedTypes = [
      'insertFromPaste',
      'insertFromDrop',
      'insertFromYank',
      'insertReplacementText',
      'insertFromPasteAsQuotation'
    ];

    return prohibitedTypes.includes(inputType);
  }

  /**
   * 最終署名を生成
   */
  async generateSignature() {
    const finalData = {
      totalEvents: this.events.length,
      finalHash: this.currentHash,
      startTime: this.startTime,
      endTime: performance.now()
    };

    const signatureData = JSON.stringify(finalData);
    const signature = await this.computeHash(signatureData);

    return {
      ...finalData,
      signature,
      events: this.events
    };
  }

  /**
   * 証明データをエクスポート
   */
  async exportProof() {
    const signature = await this.generateSignature();
    return {
      version: '2.0.0',
      proof: signature,
      fingerprint: {
        hash: this.fingerprint,
        components: this.fingerprintComponents
      },
      metadata: {
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * 統計情報を取得
   */
  getStats() {
    const duration = performance.now() - this.startTime;
    const eventTypes = this.events.reduce((acc, event) => {
      acc[event.type] = (acc[event.type] || 0) + 1;
      return acc;
    }, {});

    return {
      totalEvents: this.events.length,
      duration: duration / 1000, // 秒単位
      eventTypes,
      currentHash: this.currentHash
    };
  }

  /**
   * ハッシュ鎖を検証
   */
  async verify() {
    let hash = this.events[0]?.previousHash;
    let lastTimestamp = -Infinity;

    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];

      // シーケンス番号チェック
      if (event.sequence !== i) {
        return {
          valid: false,
          errorAt: i,
          message: `Sequence mismatch at event ${i}: expected ${i}, got ${event.sequence}`,
          event
        };
      }

      // タイムスタンプ連続性チェック
      if (event.timestamp < lastTimestamp) {
        return {
          valid: false,
          errorAt: i,
          message: `Timestamp violation at event ${i}: time moved backward from ${lastTimestamp.toFixed(2)}ms to ${event.timestamp.toFixed(2)}ms`,
          event,
          previousTimestamp: lastTimestamp,
          currentTimestamp: event.timestamp
        };
      }
      lastTimestamp = event.timestamp;

      // recordEvent()で使用したのと同じフィールドのみを再構築
      const eventData = {
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
        inputType: event.inputType,
        data: event.data,
        rangeOffset: event.rangeOffset,
        rangeLength: event.rangeLength,
        range: event.range,  // 位置情報も含める
        previousHash: event.previousHash
      };

      const eventString = JSON.stringify(eventData);
      const combinedData = hash + eventString;
      const computedHash = await this.computeHash(combinedData);

      if (computedHash !== event.hash) {
        console.error(`[Verify] Hash mismatch at event ${i}:`, {
          event,
          eventData,
          eventString,
          previousHash: hash,
          expectedHash: event.hash,
          computedHash,
          combinedData: combinedData.substring(0, 200) + '...'
        });
        return {
          valid: false,
          errorAt: i,
          message: `Hash mismatch at event ${i}`,
          event,
          eventData,
          expectedHash: event.hash,
          computedHash
        };
      }

      hash = event.hash;
    }

    return {
      valid: true,
      message: 'All hashes verified successfully'
    };
  }

  /**
   * 全てのイベントをクリアして初期状態に戻す
   */
  async reset() {
    this.events = [];
    // フィンガープリントは保持したまま新しい初期ハッシュを生成
    if (this.fingerprint) {
      this.currentHash = await this.initialHash(this.fingerprint);
    }
    this.startTime = performance.now();
  }

  /**
   * コンテンツスナップショットを記録
   * @param {string} editorContent - エディタの全コンテンツ
   * @returns {Promise<{hash: string, index: number}>}
   */
  async recordContentSnapshot(editorContent) {
    return await this.recordEvent({
      type: 'contentSnapshot',
      data: editorContent,
      description: `スナップショット（イベント${this.events.length}）`,
      isSnapshot: true
    });
  }
}
