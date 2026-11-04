import { describe, expect, it } from 'vitest';
import { hitTarget } from './touchreorder';

// Três linhas de 40 px empilhadas a partir de y = 100 (e as mesmas como abas lado a lado, para o eixo x).
const rows = [0, 1, 2].map((i) => ({ left: 0, top: 100 + i * 40, width: 300, height: 40 }));
const tabs = [0, 1, 2].map((i) => ({ left: i * 80, top: 0, width: 80, height: 30 }));

describe('hitTarget', () => {
  it('o item sob o dedo e o lado (metade de cima = antes, de baixo = depois)', () => {
    expect(hitTarget(rows, 10, 110, 'y')).toEqual({ index: 0, after: false });
    expect(hitTarget(rows, 10, 135, 'y')).toEqual({ index: 0, after: true });
    expect(hitTarget(rows, 10, 150, 'y')).toEqual({ index: 1, after: false });
  });

  it('fora da lista: acima do primeiro é antes dele, abaixo do último é depois dele', () => {
    expect(hitTarget(rows, 10, 20, 'y')).toEqual({ index: 0, after: false });
    expect(hitTarget(rows, 10, 400, 'y')).toEqual({ index: 2, after: true });
  });

  it('abas: o mesmo na horizontal', () => {
    expect(hitTarget(tabs, 100, 5, 'x')).toEqual({ index: 1, after: false });
    expect(hitTarget(tabs, 150, 5, 'x')).toEqual({ index: 1, after: true });
    expect(hitTarget(tabs, 999, 5, 'x')).toEqual({ index: 2, after: true });
  });

  it('sem itens, nada', () => {
    expect(hitTarget([], 0, 0, 'y')).toBeNull();
  });
});
