/**
 * sandbox runner が Blob Worker として起動するスクリプト (#290 / ADR-0041)。
 *
 * ユーザーの JS (TS は transpile 後の JS) はこの Worker の中でだけ実行する。Worker は
 * opaque origin の sandbox iframe の中で作られるので、親 DOM・localStorage・IndexedDB (proof の
 * イベント)・`/author` の `#author-jwk` に届かない。同期の無限ループでも親のメインスレッドは止まらない。
 *
 * 文字列定数にしているのは、Blob にそのまま入れてバンドラの変換 (minify・ヘルパの注入・外側の
 * 識別子の参照) を受けないため。テストは同じ文字列を node の `vm` で評価して確かめる
 * (`__tests__/workerSource.test.ts`)。テンプレートリテラルと `${` は中で使わない (String.raw の都合)。
 *
 * やること:
 * - 起動メッセージ `{ code, outputBudgetChars, port }` を 1 回だけ受け、以後の通信は受け取った
 *   MessagePort だけで行う (ユーザーコードは port に触れないので、`postMessage` で結果を偽れない)
 * - console の代替 (旧 `JavaScriptExecutor.createConsoleProxy` / `formatValue` と同じ出力形式)
 * - ユーザーコードを AsyncFunction で実行する (top-level await。`"use strict"` 付き)
 * - 完了の定義は Node と同じ: 本体が settle し、かつユーザーが張ったタイマー (setTimeout /
 *   setInterval) が残っていないとき。止めない setInterval は親のタイムアウトで終わる
 * - 未捕捉の例外 (本体・タイマー callback・unhandledrejection) は stderr に出して即 `failure` (exit 1)
 * - エラー位置は `(at line N, column M)` で出す。行は AsyncFunction が足す前置きの分を、
 *   起動時に同じ形の関数で投げた例外から実測して差し引く (エンジンごとの差を吸収する)
 * - 出力は予算 (stdout + stderr の文字数) を 1 文字超えたところで送るのをやめる。判定の正本は親
 *
 * port に送るメッセージ: `{ type: 'stdout' | 'stderr', text }` / `{ type: 'done', outcome, exitCode }`
 */
export const SANDBOX_WORKER_SOURCE = String.raw`(function () {
  'use strict';
  var g = self;
  var nativeSetTimeout = g.setTimeout.bind(g);
  var nativeClearTimeout = g.clearTimeout.bind(g);
  var nativeSetInterval = g.setInterval.bind(g);
  var nativeClearInterval = g.clearInterval.bind(g);
  var nativeNow = g.performance && g.performance.now ? g.performance.now.bind(g.performance) : Date.now;
  var stringify = JSON.stringify;
  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  var PREFIX = '"use strict";\n';
  var FLUSH_CHARS = 8192;

  var port = null;
  var portPost = null;
  var budget = Infinity;
  var emitted = 0;
  var budgetHit = false;
  var buffer = [];
  var bufferedChars = 0;
  var flushScheduled = false;
  var finished = false;
  var bodySettled = false;
  // 前置きの行数。calibrate() が実測で決める (位置が読めないエンジンでは formatError も位置を出さないので 0 のまま使われない)
  var lineOffset = 0;
  var userTimers = new Map();

  function send(msg) {
    portPost.call(port, msg);
  }

  function flush() {
    flushScheduled = false;
    var items = buffer;
    buffer = [];
    bufferedChars = 0;
    for (var i = 0; i < items.length; i++) send({ type: items[i][0], text: items[i][1] });
  }

  function emit(stream, text) {
    if (finished || budgetHit) return;
    var room = budget - emitted;
    if (text.length > room) {
      // 予算を 1 文字だけ超えて送る (親がそこで超過を判定する)。以後は送らない
      text = text.slice(0, room + 1);
      budgetHit = true;
    }
    emitted += text.length;
    var last = buffer[buffer.length - 1];
    if (last && last[0] === stream) last[1] += text;
    else buffer.push([stream, text]);
    bufferedChars += text.length;
    if (budgetHit || bufferedChars >= FLUSH_CHARS) flush();
    else if (!flushScheduled) {
      flushScheduled = true;
      nativeSetTimeout(flush, 0);
    }
  }

  function finish(ok) {
    if (finished) return;
    flush();
    finished = true;
    send({ type: 'done', outcome: ok ? 'success' : 'failure', exitCode: ok ? 0 : 1 });
  }

  function locate(stack) {
    var m = /(?:^|[\s(,])<anonymous>:(\d+):(\d+)/.exec(stack) || /> (?:Async)?Function:(\d+):(\d+)/.exec(stack);
    return m ? { line: parseInt(m[1], 10), column: parseInt(m[2], 10) } : null;
  }

  function formatValue(value, expand) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'function') return '[Function: ' + (value.name || 'anonymous') + ']';
    if (typeof value === 'symbol') return value.toString();
    if (value instanceof Error) return value.name + ': ' + value.message;
    if (Array.isArray(value)) {
      if (expand || value.length <= 10) {
        try {
          return stringify(value);
        } catch (e) {
          return '[Array]';
        }
      }
      return 'Array(' + value.length + ')';
    }
    if (typeof value === 'object') {
      try {
        var json = stringify(value, null, expand ? 2 : undefined);
        if (!expand && json.length > 100) return json.slice(0, 100) + '...';
        return json;
      } catch (e) {
        return '[Object]';
      }
    }
    return String(value);
  }

  function formatError(error) {
    if (error instanceof Error) {
      var message = error.name + ': ' + error.message;
      var loc = locate(String(error.stack || ''));
      if (loc) {
        var line = Math.max(1, loc.line - lineOffset);
        message += ' (at line ' + line + ', column ' + loc.column + ')';
      }
      return message;
    }
    return String(error);
  }

  function reportUncaught(error) {
    if (finished) return;
    var text;
    try {
      text = formatError(error);
    } catch (e) {
      text = 'Error';
    }
    emit('stderr', text + '\n');
    finish(false);
  }

  function checkDone() {
    if (!finished && bodySettled && userTimers.size === 0) finish(true);
  }

  // マクロタスクで判定する: callback が張った Promise の続きが新しいタイマーを張る余地を残す
  function scheduleCheck() {
    nativeSetTimeout(checkDone, 0);
  }

  function formatArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(formatValue(args[i]));
    return parts.join(' ');
  }

  function installConsole() {
    var timers = new Map();
    var counts = new Map();
    var out = function (text) {
      emit('stdout', text);
    };
    var err = function (text) {
      emit('stderr', text);
    };
    var noop = function () {};
    var proxy = {
      log: function () { out(formatArgs(arguments) + '\n'); },
      info: function () { out('[INFO] ' + formatArgs(arguments) + '\n'); },
      warn: function () { err('[WARN] ' + formatArgs(arguments) + '\n'); },
      error: function () { err('[ERROR] ' + formatArgs(arguments) + '\n'); },
      debug: function () { out('[DEBUG] ' + formatArgs(arguments) + '\n'); },
      trace: function () { out('[TRACE] ' + formatArgs(arguments) + '\n'); },
      dir: function (obj) { out(formatValue(obj, true) + '\n'); },
      table: function (data) {
        var text;
        try {
          text = stringify(data, null, 2);
        } catch (e) {
          text = '[Object]';
        }
        out('[TABLE] ' + text + '\n');
      },
      clear: function () { out('\x1b[2J\x1b[H'); },
      assert: function (condition) {
        if (!condition) err('Assertion failed: ' + formatArgs(Array.prototype.slice.call(arguments, 1)) + '\n');
      },
      count: function (label) {
        if (label === undefined) label = 'default';
        var c = (counts.get(label) || 0) + 1;
        counts.set(label, c);
        out(label + ': ' + c + '\n');
      },
      countReset: function (label) {
        counts.delete(label === undefined ? 'default' : label);
      },
      group: noop,
      groupCollapsed: noop,
      groupEnd: noop,
      time: function (label) {
        timers.set(label === undefined ? 'default' : label, nativeNow());
      },
      timeEnd: function (label) {
        if (label === undefined) label = 'default';
        var start = timers.get(label);
        if (start !== undefined) {
          out(label + ': ' + (nativeNow() - start).toFixed(2) + 'ms\n');
          timers.delete(label);
        }
      },
      timeLog: function (label) {
        if (label === undefined) label = 'default';
        var start = timers.get(label);
        if (start !== undefined) out(label + ': ' + (nativeNow() - start).toFixed(2) + 'ms\n');
      },
    };
    g.console = proxy;
  }

  function installTimers() {
    var requireFunction = function (cb) {
      if (typeof cb !== 'function') throw new TypeError('The "callback" argument must be of type function');
    };
    g.setTimeout = function (cb, ms) {
      requireFunction(cb);
      var args = Array.prototype.slice.call(arguments, 2);
      var id = nativeSetTimeout(function () {
        userTimers.delete(id);
        try {
          cb.apply(undefined, args);
        } catch (e) {
          reportUncaught(e);
          return;
        }
        scheduleCheck();
      }, ms);
      userTimers.set(id, true);
      return id;
    };
    g.setInterval = function (cb, ms) {
      requireFunction(cb);
      var args = Array.prototype.slice.call(arguments, 2);
      var id = nativeSetInterval(function () {
        try {
          cb.apply(undefined, args);
        } catch (e) {
          reportUncaught(e);
        }
      }, ms);
      userTimers.set(id, true);
      return id;
    };
    var clear = function (id) {
      // ブラウザでは clearTimeout と clearInterval が同じ id を共有する
      nativeClearTimeout(id);
      nativeClearInterval(id);
      if (userTimers.delete(id)) scheduleCheck();
    };
    g.clearTimeout = clear;
    g.clearInterval = clear;
  }

  async function calibrate() {
    try {
      await new AsyncFunction(PREFIX + 'throw new Error("calibrate")')();
    } catch (e) {
      var loc = locate(String((e && e.stack) || ''));
      if (loc) lineOffset = loc.line - 1;
    }
  }

  async function start(code) {
    await calibrate();
    installConsole();
    installTimers();
    g.addEventListener('unhandledrejection', function (ev) {
      ev.preventDefault();
      reportUncaught(ev.reason);
    });
    g.addEventListener('error', function (ev) {
      ev.preventDefault();
      reportUncaught(ev.error !== undefined && ev.error !== null ? ev.error : ev.message);
    });

    var fn;
    try {
      fn = new AsyncFunction(PREFIX + code);
    } catch (e) {
      reportUncaught(e);
      return;
    }
    var result;
    try {
      result = await fn.call(undefined);
    } catch (e) {
      reportUncaught(e);
      return;
    }
    if (result !== undefined) emit('stdout', '=> ' + formatValue(result) + '\n');
    bodySettled = true;
    scheduleCheck();
  }

  function onInit(e) {
    g.removeEventListener('message', onInit);
    var d = e.data || {};
    port = d.port;
    portPost = port.postMessage;
    if (typeof d.outputBudgetChars === 'number' && d.outputBudgetChars > 0) budget = d.outputBudgetChars;
    start(String(d.code));
  }
  g.addEventListener('message', onInit);
})();
`;
