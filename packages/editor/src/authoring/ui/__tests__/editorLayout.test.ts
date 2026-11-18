import { describe, expect, it } from 'vitest';
import { EditorLayout } from '../editorLayout.js';

function layoutWith(...paths: string[]): EditorLayout {
  const layout = new EditorLayout();
  for (const path of paths) layout.open(path);
  return layout;
}

describe('EditorLayout', () => {
  it('opening a document adds a tab next to the active one and makes it active', () => {
    const layout = layoutWith('a.md', 'b.c');
    layout.open('a.md');
    layout.open('c.py');
    expect(layout.group(0)).toEqual({ tabs: ['a.md', 'c.py', 'b.c'], active: 'c.py' });
  });

  it('opening an already open document does not duplicate its tab', () => {
    const layout = layoutWith('a.md', 'a.md');
    expect(layout.group(0)?.tabs).toEqual(['a.md']);
  });

  it('split opens the active document in a second group and focuses it', () => {
    const layout = layoutWith('a.md');
    expect([layout.split(), layout.groupCount, layout.activeGroup, layout.group(1)]).toEqual([
      true,
      2,
      1,
      { tabs: ['a.md'], active: 'a.md' },
    ]);
  });

  it('allows at most two groups', () => {
    const layout = layoutWith('a.md');
    layout.split();
    expect([layout.split(), layout.groupCount]).toEqual([false, 2]);
  });

  it('does not split when nothing is open', () => {
    expect(new EditorLayout().split()).toBe(false);
  });

  it('closing the last tab of the second group collapses back to one group', () => {
    const layout = layoutWith('a.md');
    layout.split();
    layout.close('a.md', 1);
    expect([layout.groupCount, layout.activeGroup, layout.isOpen('a.md')]).toEqual([1, 0, true]);
  });

  it('closing the last tab of the first group promotes the second group', () => {
    const layout = layoutWith('a.md');
    layout.split();
    layout.open('b.c', 1);
    layout.close('a.md', 0);
    expect([layout.groupCount, layout.group(0)]).toEqual([1, { tabs: ['a.md', 'b.c'], active: 'b.c' }]);
  });

  it('closing the active tab activates its neighbour', () => {
    const layout = layoutWith('a.md', 'b.c', 'c.py');
    layout.open('b.c');
    layout.close('b.c', 0);
    expect(layout.group(0)).toEqual({ tabs: ['a.md', 'c.py'], active: 'c.py' });
  });

  it('remove takes a document out of every group', () => {
    const layout = layoutWith('a.md', 'b.c');
    layout.split();
    layout.remove('b.c');
    expect([layout.isOpen('b.c'), layout.openPaths()]).toEqual([false, ['a.md']]);
  });

  it('keeps the Markdown view per group', () => {
    const layout = layoutWith('a.md');
    layout.split();
    layout.setView('a.md', 1, 'preview');
    expect([layout.view('a.md', 0), layout.view('a.md', 1)]).toEqual(['edit', 'preview']);
  });

  it('a new split inherits the view of the document it splits', () => {
    const layout = layoutWith('a.md');
    layout.setView('a.md', 0, 'preview');
    layout.split();
    expect(layout.view('a.md', 1)).toBe('preview');
  });

  it('closeGroup drops the second group and its tabs', () => {
    const layout = layoutWith('a.md');
    layout.split();
    layout.open('b.c', 1);
    layout.closeGroup(1);
    expect([layout.groupCount, layout.isOpen('b.c'), layout.activePath]).toEqual([1, false, 'a.md']);
  });

  it('reset closes everything', () => {
    const layout = layoutWith('a.md');
    layout.split();
    layout.reset();
    expect([layout.groupCount, layout.activePath, layout.openPaths()]).toEqual([1, null, []]);
  });
});
