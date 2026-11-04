// Reordenar no toque: segurar um instante e arrastar (pointer events). O arrastar do HTML (draggable) não existe no
// toque do iOS, então a lista de salas e agentes (sidebar.ts) e as abas do terminal (termtabs.ts) usam isto no
// celular; com o mouse continua o draggable de sempre. As marcas (is-dragging, is-drop-before/after) e a conta da
// nova ordem são as mesmas do draggable: quem chama passa os ganchos.

/** Quanto segurar antes de o arrasto começar. */
export const HOLD_MS = 450;
/** Mexeu mais que isto antes do tempo: é rolagem da lista, não arrasto. */
export const SLOP_PX = 8;
/** Depois de soltar, o clique que o navegador ainda manda (abriria o agente) é ignorado por este tempo. */
const CLICK_GUARD_MS = 500;

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * O item sob o ponto e o lado dele (`after`: depois da metade, na direção `axis`). Fora de todos, o mais próximo na
 * direção do eixo (acima do primeiro = antes dele; abaixo do último = depois dele), para soltar nas pontas.
 */
export function hitTarget(rects: readonly RectLike[], x: number, y: number, axis: 'x' | 'y'): { index: number; after: boolean } | null {
  if (!rects.length) return null;
  const pos = axis === 'y' ? y : x;
  const start = (r: RectLike) => (axis === 'y' ? r.top : r.left);
  const size = (r: RectLike) => (axis === 'y' ? r.height : r.width);
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const s = start(r);
    const e = s + size(r);
    const d = pos < s ? s - pos : pos > e ? pos - e : 0;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  const r = rects[best];
  return { index: best, after: pos > start(r) + size(r) / 2 };
}

export interface TouchReorderHooks {
  /** Os itens do mesmo grupo onde dá para soltar (o arrastado incluído). */
  targets(): HTMLElement[];
  /** O arrasto começou (o dedo segurou o item). */
  start(): void;
  /** O item sob o dedo e o lado mudaram; null = sobre o próprio arrastado (nada muda). */
  over(target: HTMLElement | null, after: boolean): void;
  /** Soltou antes ou depois de `target` (outro item do grupo). */
  drop(target: HTMLElement, after: boolean): void;
  /** Terminou (soltou ou cancelou): limpa as marcas. */
  end(): void;
}

/** Liga o segurar-e-arrastar em `handle` (só toque e caneta; o mouse fica com o draggable). */
export function wireTouchReorder(handle: HTMLElement, hooks: TouchReorderHooks, axis: 'x' | 'y' = 'y'): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pointer = -1;
  let x0 = 0;
  let y0 = 0;
  let dragging = false;
  let target: HTMLElement | null = null;
  let after = false;

  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pointer = -1;
    dragging = false;
    target = null;
  };
  const finish = (drop: boolean) => {
    const was = dragging;
    const t = target;
    const a = after;
    if (pointer >= 0 && handle.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
    reset();
    if (!was) return;
    if (drop && t) hooks.drop(t, a);
    hooks.end();
    // O toque que terminou o arrasto ainda vira clique (abriria o agente ou a aba): esse fica de fora.
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    handle.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => handle.removeEventListener('click', swallow, { capture: true }), CLICK_GUARD_MS);
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    reset();
    pointer = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      dragging = true;
      try {
        handle.setPointerCapture(pointer);
      } catch {
        // o dedo já saiu
      }
      hooks.start();
      navigator.vibrate?.(10);
    }, HOLD_MS);
  });
  handle.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) > SLOP_PX) reset();
      return;
    }
    const items = hooks.targets();
    const hit = hitTarget(
      items.map((el) => el.getBoundingClientRect()),
      e.clientX,
      e.clientY,
      axis,
    );
    const next = hit && items[hit.index] !== handle ? items[hit.index] : null;
    const side = hit?.after ?? false;
    if (next === target && side === after) return;
    target = next;
    after = side;
    hooks.over(target, after);
  });
  handle.addEventListener('pointerup', (e) => {
    if (e.pointerId === pointer) finish(true);
  });
  handle.addEventListener('pointercancel', (e) => {
    if (e.pointerId === pointer) finish(false);
  });
  // Arrastando, o dedo não rola a lista (o iOS só respeita isto num touchmove que não é passivo).
  handle.addEventListener(
    'touchmove',
    (e) => {
      if (dragging) e.preventDefault();
    },
    { passive: false },
  );
  // Segurar abriria o menu do sistema (copiar, compartilhar) no lugar do arrasto.
  handle.addEventListener('contextmenu', (e) => {
    if (dragging || timer) e.preventDefault();
  });
}
