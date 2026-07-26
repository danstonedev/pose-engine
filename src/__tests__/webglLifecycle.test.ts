import { describe, expect, it, vi } from 'vitest';
import { attachContextLossRecovery, disposeObject3DTree } from '../services/webglLifecycle';

/** Minimal EventTarget stand-in — the helper only uses add/removeEventListener. */
function fakeCanvas() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type: string, fn: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: EventListener) {
      listeners.get(type)?.delete(fn);
    },
    /** Dispatch and report whether anything called preventDefault. */
    emit(type: string): { defaultPrevented: boolean; handled: number } {
      let defaultPrevented = false;
      const event = {
        type,
        preventDefault() {
          defaultPrevented = true;
        },
      } as unknown as Event;
      const fns = listeners.get(type);
      fns?.forEach((fn) => fn(event));
      return { defaultPrevented, handled: fns?.size ?? 0 };
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe('attachContextLossRecovery', () => {
  it('parks on context loss and resumes on restore', () => {
    const canvas = fakeCanvas();
    const onLost = vi.fn();
    const onRestored = vi.fn();
    attachContextLossRecovery(canvas as unknown as HTMLCanvasElement, { onLost, onRestored });

    canvas.emit('webglcontextlost');
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();

    canvas.emit('webglcontextrestored');
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it('calls preventDefault on loss', () => {
    // Without this the browser never fires webglcontextrestored, so the canvas
    // is dead permanently. This is the assertion that matters most here.
    const canvas = fakeCanvas();
    attachContextLossRecovery(canvas as unknown as HTMLCanvasElement, {
      onLost: () => {},
      onRestored: () => {},
    });
    expect(canvas.emit('webglcontextlost').defaultPrevented).toBe(true);
  });

  it('detaches both listeners', () => {
    const canvas = fakeCanvas();
    const onLost = vi.fn();
    const detach = attachContextLossRecovery(canvas as unknown as HTMLCanvasElement, {
      onLost,
      onRestored: () => {},
    });
    expect(canvas.count('webglcontextlost')).toBe(1);
    expect(canvas.count('webglcontextrestored')).toBe(1);

    detach();
    expect(canvas.count('webglcontextlost')).toBe(0);
    expect(canvas.count('webglcontextrestored')).toBe(0);
    canvas.emit('webglcontextlost');
    expect(onLost).not.toHaveBeenCalled();
  });
});

/** Structural stand-ins — the helper traverses duck-typed, so no three needed. */
function texture() {
  return { isTexture: true, dispose: vi.fn() };
}
function node(opts: { geometry?: unknown; material?: unknown; children?: unknown[] } = {}) {
  const self = {
    geometry: opts.geometry,
    material: opts.material,
    children: opts.children ?? [],
    traverse(fn: (n: unknown) => void) {
      fn(self);
      for (const c of self.children as { traverse?: (f: (n: unknown) => void) => void }[]) {
        c.traverse?.(fn);
      }
    },
  };
  return self;
}

describe('disposeObject3DTree', () => {
  it('disposes geometry and material through the whole subtree', () => {
    const g1 = { dispose: vi.fn() };
    const g2 = { dispose: vi.fn() };
    const m1 = { dispose: vi.fn() };
    const m2 = { dispose: vi.fn() };
    const child = node({ geometry: g2, material: m2 });
    const root = node({ geometry: g1, material: m1, children: [child] });

    disposeObject3DTree(root as never);

    expect(g1.dispose).toHaveBeenCalledTimes(1);
    expect(g2.dispose).toHaveBeenCalledTimes(1);
    expect(m1.dispose).toHaveBeenCalledTimes(1);
    expect(m2.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the textures a material holds — the leak this exists to fix', () => {
    const map = texture();
    const normalMap = texture();
    const material = { map, normalMap, dispose: vi.fn() };

    disposeObject3DTree(node({ material }) as never);

    expect(map.dispose).toHaveBeenCalledTimes(1);
    expect(normalMap.dispose).toHaveBeenCalledTimes(1);
    expect(material.dispose).toHaveBeenCalledTimes(1);
  });

  it('leaves textures alone when asked to', () => {
    const map = texture();
    const material = { map, dispose: vi.fn() };

    disposeObject3DTree(node({ material }) as never, { textures: false });

    expect(map.dispose).not.toHaveBeenCalled();
    expect(material.dispose).toHaveBeenCalledTimes(1);
  });

  it('handles material arrays', () => {
    const a = { map: texture(), dispose: vi.fn() };
    const b = { map: texture(), dispose: vi.fn() };

    disposeObject3DTree(node({ material: [a, b] }) as never);

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(a.map.dispose).toHaveBeenCalledTimes(1);
    expect(b.map.dispose).toHaveBeenCalledTimes(1);
  });

  it('ignores non-texture material properties', () => {
    // A plain object with a dispose() must not be mistaken for a texture:
    // only isTexture === true qualifies.
    const notATexture = { dispose: vi.fn() };
    const material = { userData: notATexture, dispose: vi.fn() };

    disposeObject3DTree(node({ material }) as never);

    expect(notATexture.dispose).not.toHaveBeenCalled();
    expect(material.dispose).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for null and undefined roots', () => {
    expect(() => disposeObject3DTree(null)).not.toThrow();
    expect(() => disposeObject3DTree(undefined)).not.toThrow();
  });

  it('tolerates nodes with no geometry or material', () => {
    expect(() => disposeObject3DTree(node() as never)).not.toThrow();
  });
});
