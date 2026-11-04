import { describe, expect, it } from 'vitest';
import { pushHint, pushSupport, vapidKeyBytes, type PushEnv } from './push';

const ok: PushEnv = { secure: true, ios: true, standalone: true, hasPush: true, permission: 'default' };

describe('pushSupport', () => {
  it('iPhone no app da Tela de Início, por HTTPS: dá para ligar', () => {
    expect(pushSupport(ok)).toBe('off');
    expect(pushSupport({ ...ok, permission: 'granted' })).toBe('off');
  });

  it('fora do app no iPhone, sem HTTPS, sem push ou bloqueado: o motivo', () => {
    expect(pushSupport({ ...ok, standalone: false })).toBe('install');
    expect(pushSupport({ ...ok, secure: false })).toBe('insecure');
    expect(pushSupport({ ...ok, ios: false, hasPush: false })).toBe('unsupported');
    expect(pushSupport({ ...ok, permission: 'denied' })).toBe('denied');
  });

  it('cada estado tem a sua dica; a do iPhone fala da Tela de Início', () => {
    expect(pushHint('install')).toMatch(/Tela de Início/);
    expect(new Set(['unsupported', 'insecure', 'install', 'denied', 'off'].map((s) => pushHint(s as never))).size).toBe(5);
  });
});

describe('vapidKeyBytes', () => {
  it('base64url sem enchimento para os 65 bytes da chave', () => {
    const key = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
    const bytes = vapidKeyBytes(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    const back = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(back).toBe(key);
  });
});
