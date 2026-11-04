import { describe, expect, it } from 'vitest';
import { menuLabel } from './moremenu';

describe('menuLabel', () => {
  it('tira o atalho do fim (no toque ele não serve)', () => {
    expect(menuLabel('Timelapse: reproduzir o dia (L)')).toBe('Timelapse: reproduzir o dia');
    expect(menuLabel('Feed de atividade ( ] )')).toBe('Feed de atividade');
    expect(menuLabel('Ajuda (?)')).toBe('Ajuda');
    expect(menuLabel('Fechar detalhes (Esc)')).toBe('Fechar detalhes');
  });

  it('parênteses que não são atalho ficam', () => {
    expect(menuLabel('Configurações')).toBe('Configurações');
    expect(menuLabel('Histórico de sessões (últimos 7 dias)')).toBe('Histórico de sessões (últimos 7 dias)');
  });
});
