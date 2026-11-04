// "⋯ Mais opções" na barra do topo, só na tela de toque: os botões que a largura da tela esconde (CSS) aparecem aqui
// como itens, e cada item aperta o botão de verdade. Com teclado eles seguem nos atalhos (o timelapse na tecla L, que
// some da barra em até 480 px); no toque, sem atalho, o ⋯ é o caminho. Ele só aparece quando há botão escondido assim.
import { tr } from '../../../shared/i18n';
import { coarsePointer, h, iconButton, setAttr, setHidden } from './dom';
import { ICONS } from './icons';

/** "Timelapse: reproduzir o dia (L)" → "Timelapse: reproduzir o dia": no menu (toque) o atalho não serve. */
export function menuLabel(label: string): string {
  return label.replace(/\s*\(\s*[^()]{1,4}\s*\)\s*$/, '').trim();
}

/** Escondido pela largura (CSS), não desligado: sem caixa na página e sem `hidden` nele nem acima. */
function hiddenByWidth(b: HTMLElement): boolean {
  return !b.closest('[hidden]') && b.getClientRects().length === 0;
}

export class MoreMenu {
  readonly button: HTMLButtonElement;
  readonly menu: HTMLElement;
  private open = false;

  /** `source`: os botões da barra que podem ir para o menu (na ordem da barra). */
  constructor(private source: () => HTMLElement[]) {
    this.menu = h('div', { class: 'ui-more', role: 'menu', hidden: true, tabIndex: -1, attrs: { id: 'ui-more', 'aria-label': tr('Mais opções') } });
    // Aberto pelo teclado (clique sem ponteiro, detail 0), o foco vai ao primeiro item; pelo toque, ao menu.
    this.button = iconButton(ICONS.more, tr('Mais opções'), (e) => this.toggle(e.detail === 0), 'ui-btn-more');
    setAttr(this.button, 'aria-haspopup', 'menu');
    setAttr(this.button, 'aria-controls', 'ui-more');
    setAttr(this.button, 'aria-expanded', 'false');
    this.button.hidden = true;
    this.menu.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.open && !this.menu.contains(e.target as Node) && !this.button.contains(e.target as Node)) this.close(false);
    });
    addEventListener('resize', () => {
      if (this.open) this.close(false);
    });
  }

  /** Mostra o ⋯ só quando a largura esconde algum botão (chamado a cada render da barra). */
  sync(): void {
    setHidden(this.button, this.hidden().length === 0);
    if (this.open && this.button.hidden) this.close(false);
  }

  private hidden(): HTMLElement[] {
    if (!coarsePointer()) return [];
    return this.source().filter((b) => b !== this.button && hiddenByWidth(b));
  }

  private toggle(fromKeyboard: boolean): void {
    if (this.open) this.close(true);
    else this.show(fromKeyboard);
  }

  private show(fromKeyboard: boolean): void {
    const items = this.hidden().map((b) => {
      const label = menuLabel(b.getAttribute('aria-label') || b.title || b.textContent || '');
      const item = h('button', { class: 'ui-more__item', type: 'button', role: 'menuitem' });
      item.innerHTML = b.innerHTML;
      item.append(h('span', { class: 'ui-more__label', text: label }));
      item.addEventListener('click', () => {
        this.close(false);
        b.click();
      });
      return item;
    });
    if (!items.length) return;
    this.menu.replaceChildren(...items);
    const r = this.button.getBoundingClientRect();
    this.menu.style.top = `${Math.round(r.bottom + 6)}px`;
    this.menu.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
    this.open = true;
    this.menu.hidden = false;
    setAttr(this.button, 'aria-expanded', 'true');
    if (fromKeyboard) items[0].focus();
    else this.menu.focus({ preventScroll: true });
  }

  private close(refocus: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.menu.hidden = true;
    setAttr(this.button, 'aria-expanded', 'false');
    if (refocus) this.button.focus();
  }
}
