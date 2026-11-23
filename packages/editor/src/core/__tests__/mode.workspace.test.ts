import { describe, expect, it } from 'vitest';
import type { ClassPolicy } from '@typedcode/shared';
import {
  classPolicyCode,
  classWorkspaceFor,
  classWorkspacePath,
  entranceClassPolicy,
  isRoutableClassId,
  modeForClassPolicy,
  parseClassPolicyCode,
  parseWorkspacePath,
  resolveModeFromPath,
  resolveRoute,
  sameWorkspace,
  workspaceName,
  type ClassWorkspace,
} from '../mode.js';

// 期待値は #646 の決定どおりに直書きする (プリセットの値は /class・/assignment の能力 = mode.classPolicy.test.ts)
const CLASSROOM: ClassPolicy = { screenshots: true, fullscreenTracking: true, preExportBestEffort: true };
const TAKE_HOME: ClassPolicy = { screenshots: false, fullscreenTracking: false, preExportBestEffort: false };

/** 3 つの能力の全組み合わせ (8 通り) */
const ALL_POLICIES: ClassPolicy[] = [false, true].flatMap((screenshots) =>
  [false, true].flatMap((fullscreenTracking) =>
    [false, true].map((preExportBestEffort) => ({ screenshots, fullscreenTracking, preExportBestEffort }))
  )
);

function classWs(classId: string, policy: ClassPolicy): ClassWorkspace {
  return { kind: 'class', classId, policy };
}

describe('classPolicyCode / parseClassPolicyCode', () => {
  it('names the presets classroom and take-home and every other combination custom-<s><f><b>', () => {
    expect(ALL_POLICIES.map(classPolicyCode)).toEqual([
      'take-home',
      'custom-001',
      'custom-010',
      'custom-011',
      'custom-100',
      'custom-101',
      'custom-110',
      'classroom',
    ]);
  });

  it('reads back every code it writes', () => {
    for (const policy of ALL_POLICIES) expect(parseClassPolicyCode(classPolicyCode(policy))).toEqual(policy);
  });

  it('rejects a custom code that spells a preset so a policy has exactly one URL', () => {
    expect([parseClassPolicyCode('custom-111'), parseClassPolicyCode('custom-000')]).toEqual([null, null]);
  });

  it('rejects unknown codes', () => {
    for (const code of ['', 'Classroom', 'custom-1', 'custom-0012', 'custom-abc', 'takehome']) {
      expect(parseClassPolicyCode(code)).toBeNull();
    }
  });
});

describe('modeForClassPolicy (proof.mode of a workspace)', () => {
  it('is class for the classroom preset and assignment for the take-home preset', () => {
    expect([modeForClassPolicy(CLASSROOM), modeForClassPolicy(TAKE_HOME)]).toEqual(['class', 'assignment']);
  });

  it('follows the screenshots flag for combinations outside the presets', () => {
    const custom = ALL_POLICIES.filter((p) => classPolicyCode(p).startsWith('custom-'));
    expect(custom.map((p) => [classPolicyCode(p), modeForClassPolicy(p)])).toEqual([
      ['custom-001', 'assignment'],
      ['custom-010', 'assignment'],
      ['custom-011', 'assignment'],
      ['custom-100', 'class'],
      ['custom-101', 'class'],
      ['custom-110', 'class'],
    ]);
  });
});

describe('workspaceName (storage namespace of a workspace)', () => {
  it('gives the same name to the same classId and policy', () => {
    expect(workspaceName(classWs('algo-week3', CLASSROOM))).toBe(workspaceName(classWs('algo-week3', CLASSROOM)));
  });

  it('separates the same classId with a different policy', () => {
    expect(workspaceName(classWs('algo-week3', CLASSROOM))).not.toBe(workspaceName(classWs('algo-week3', TAKE_HOME)));
  });

  it('keeps a .tcclass classId apart from a .tcexam examId with the same value', () => {
    const names = new Set([
      workspaceName(classWs('lesson', CLASSROOM)),
      workspaceName(classWs('lesson', TAKE_HOME)),
      workspaceName({ kind: 'exam', examId: 'lesson' }),
      // variant に方針の符号と同じ文字列が入っても、種別の接頭辞で分かれる
      workspaceName({ kind: 'exam', examId: 'lesson', variant: 'classroom' }),
      workspaceName({ kind: 'exam', examId: 'lesson', variant: 'take-home' }),
    ]);
    expect(names.size).toBe(5);
  });

  it('prefixes the kind and percent-encodes each part', () => {
    expect([
      workspaceName(classWs('a:b/c', CLASSROOM)),
      workspaceName({ kind: 'exam', examId: 'e:1', variant: 'v:2' }),
    ]).toEqual(['class:a%3Ab%2Fc:classroom', 'exam:e%3A1:v%3A2']);
  });

  it('cannot be forged by a classId that contains the separator', () => {
    // classId に `:classroom` を含めても、別の classId の作業スペースの名前にはならない
    expect(workspaceName(classWs('x:classroom', TAKE_HOME))).not.toBe(workspaceName(classWs('x', CLASSROOM)));
    expect(sameWorkspace(classWs('x:take-home', CLASSROOM), classWs('x', TAKE_HOME))).toBe(false);
  });
});

describe('classWorkspacePath / parseWorkspacePath', () => {
  it('builds /w/class/<encoded classId>/<policy code>', () => {
    expect([
      classWorkspacePath(classWs('2026-algo-week3', CLASSROOM)),
      classWorkspacePath(classWs('週 3/演習', TAKE_HOME)),
      classWorkspacePath(classWs('x', { ...CLASSROOM, preExportBestEffort: false })),
    ]).toEqual([
      '/w/class/2026-algo-week3/classroom',
      '/w/class/%E9%80%B1%203%2F%E6%BC%94%E7%BF%92/take-home',
      '/w/class/x/custom-110',
    ]);
  });

  it('reads back the workspace from its own path', () => {
    for (const ws of [
      classWs('2026-algo-week3', CLASSROOM),
      classWs('週 3/演習:a', TAKE_HOME),
      classWs('...', CLASSROOM),
    ]) {
      expect(parseWorkspacePath(classWorkspacePath(ws))).toEqual(ws);
    }
  });

  it('accepts one trailing slash', () => {
    expect(parseWorkspacePath('/w/class/a/classroom/')).toEqual(classWs('a', CLASSROOM));
  });

  it('rejects malformed workspace paths', () => {
    for (const path of [
      '/w',
      '/w/',
      '/w/class',
      '/w/class/a',
      '/w/class/a/classroom/extra',
      '/w/class//classroom',
      '/w/exam/a/classroom',
      '/w/Class/a/classroom',
      '/w/class/a/unknown',
      '/w/class/a/custom-111',
      '/w/class/%E0%A4%A/classroom',
      '/w/class/%2E%2E/classroom',
    ]) {
      expect(parseWorkspacePath(path), path).toBeNull();
    }
  });

  it('returns null for paths outside /w/', () => {
    for (const path of ['/', '/class', '/assignment', '/exam', '/casual', '/wx/class/a/classroom']) {
      expect(parseWorkspacePath(path), path).toBeNull();
    }
  });
});

describe('resolveRoute / resolveModeFromPath for workspaces', () => {
  it('opens a workspace path in the mode its policy decides', () => {
    expect([
      resolveRoute('/w/class/a/classroom'),
      resolveRoute('/w/class/a/take-home'),
      resolveModeFromPath('/w/class/a/classroom'),
      resolveModeFromPath('/w/class/a/take-home'),
      resolveModeFromPath('/w/class/a/custom-100'),
    ]).toEqual(['class', 'assignment', 'class', 'assignment', 'class']);
  });

  it('sends a malformed /w/ path to not-found instead of an editor', () => {
    for (const path of ['/w', '/w/class/a', '/w/class/a/unknown', '/W/exam/a/classroom']) {
      expect(resolveRoute(path), path).toBe('not-found');
    }
  });
});

describe('isRoutableClassId', () => {
  it('refuses only the classIds a browser would fold as dot segments', () => {
    expect(['', '.', '..', '...', 'a.b', '%2e'].map(isRoutableClassId)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });
});

describe('classWorkspaceFor (which workspace a loaded .tcclass opens)', () => {
  it('opens a policy-less package from practice (/) as take-home', () => {
    expect(classWorkspaceFor({ classId: 'c' }, 'casual', null)).toEqual(classWs('c', TAKE_HOME));
  });

  it('opens a policy-less package from /class as classroom and from /assignment as take-home', () => {
    expect([
      classWorkspaceFor({ classId: 'c' }, 'class', null),
      classWorkspaceFor({ classId: 'c' }, 'assignment', null),
    ]).toEqual([classWs('c', CLASSROOM), classWs('c', TAKE_HOME)]);
  });

  it('opens a policy-less package inside a workspace with that workspace policy', () => {
    const custom = { screenshots: true, fullscreenTracking: false, preExportBestEffort: false };
    expect(classWorkspaceFor({ classId: 'c' }, 'class', classWs('c', custom))).toEqual(classWs('c', custom));
  });

  it('prefers the package policy over every entrance', () => {
    for (const [mode, ws] of [
      ['casual', null],
      ['class', null],
      ['assignment', classWs('other', TAKE_HOME)],
    ] as const) {
      expect(classWorkspaceFor({ classId: 'c', policy: CLASSROOM }, mode, ws)).toEqual(classWs('c', CLASSROOM));
    }
  });

  it('returns copies so a caller cannot change the presets through the result', () => {
    const ws = classWorkspaceFor({ classId: 'c' }, 'casual', null);
    (ws.policy as { screenshots: boolean }).screenshots = true;
    expect(entranceClassPolicy('casual', null)).toEqual(TAKE_HOME);
  });
});
