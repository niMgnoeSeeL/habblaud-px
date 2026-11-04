#!/usr/bin/env python3
"""Habblaud를 아이폰 프로필(Playwright WebKit)로 열어 단계마다 스크린샷과 측정값을 남긴다. 점검표는 CHECKLIST.md.

안전: /api로 가는 요청 중 GET이 아닌 것은 모두 막는다. 그래서 어떤 단계도 실제 세션에 메시지를 보내거나, 권한을
승인·거절하거나, 세션을 시작·종료할 수 없다. 단계는 화면을 열기만 한다. REAL 단계는 실제 서버 화면이라 실제 세션
내용이 찍히므로 결과 폴더를 밖으로 내보내지 않는다.

사용:
  python3 shoot.py OUT --profile iphone-15 [단계 ...]   한 프로필로 찍고 OUT/report-<프로필>.json을 쓴다
  python3 shoot.py OUT --gallery                       OUT/report-*.json을 모아 OUT/index.html을 만든다
  python3 shoot.py --list                              프로필과 단계 목록
보통은 run.sh로 네 프로필을 한꺼번에 돌린다.
"""
import glob
import html
import json
import os
import sys

BASE = os.environ.get('HABBLAUD_URL', 'http://localhost:4747')
MOCK = f'{BASE}/?mock=1&sessions=6'
# 질문(AskUserQuestion)이 일찍 나오는 데모 시드(빠르게).
QMOCK = f'{BASE}/?mock=1&sessions=6&speed=3&seed=2'
REAL = f'{BASE}/'
# 원격 로그인 화면(run.sh가 server/http/remote.ts의 loginPage로 만든 OUT/login.html)을 띄우는 가짜 경로.
LOGIN = f'{BASE}/__phone_login'
# REAL 단계에서 /api/access를 휴대폰 포트(원격 로그인)처럼 답한다: 원격이고, 로컬이 아니며, 기능은 켜짐.
PHONE_ACCESS = {'remote': True, 'local': False, 'permissions': True, 'messages': True, 'terminal': True, 'spawn': True}

# 이름: (Playwright 기기, 가로 화면인가)
PROFILES = {
    'iphone-15': ('iPhone 15', False),            # 393×659
    'iphone-se': ('iPhone SE', False),            # 320×568: WCAG 1.4.10의 320 CSS px
    'iphone-15-land': ('iPhone 15 landscape', True),  # 734×343
    'iphone-se-land': ('iPhone SE landscape', True),  # 568×320
}

# 보이는 컨트롤 가운데 aria-label(없으면 title, 글자)이 label로 시작하거나 label을 담은 첫 번째를 화면 가운데로
# 스크롤하고 그 중심 좌표를 돌려준다.
FIND = r"""(label) => {
  const vis = el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0 && !el.closest('[hidden], [aria-hidden="true"], [inert]') };
  const names = el => [el.getAttribute('aria-label'), el.title, el.textContent].filter(Boolean).map(t => t.trim().replace(/\s+/g, ' '));
  const all = [...document.querySelectorAll('button, a[href], [role=button], [role=tab], summary')].filter(vis);
  const el = all.find(e => names(e).some(n => n.startsWith(label))) || all.find(e => names(e).some(n => n.includes(label)));
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  return at(el);
}"""

# 요소 가운데 지점의 [x, y, 그 자리를 덮은 요소(없으면 null)]. 덮였으면 그 자리를 누르면 다른 것이 눌린다.
AT = r"""const coveredBy = el => { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
  const t = document.elementFromPoint(x, y);
  if (!t || t === el || el.contains(t) || t.contains(el) || t.control === el) return null;
  return (String(t.className?.baseVal ?? t.className ?? '') || t.tagName.toLowerCase()).slice(0, 40) };
const at = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, coveredBy(el)] };"""
FIND = FIND.replace('(label) => {', '(label) => {\n  ' + AT, 1)

# 한 장면의 측정값. 항목 번호는 CHECKLIST.md.
MEASURE = r"""() => {
  const W = innerWidth, H = innerHeight;
  const hiddenUp = el => !!el.closest('[hidden], [aria-hidden="true"], [inert]');
  const vis = el => { if (!el || hiddenUp(el)) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.01 && r.width > 0 && r.height > 0 };
  const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
  const inView = r => r.x >= -1 && r.y >= -1 && r.x + r.w <= W + 1 && r.y + r.h <= H + 1;
  const shownArea = r => Math.max(0, Math.min(W, r.x + r.w) - Math.max(0, r.x)) * Math.max(0, Math.min(H, r.y + r.h) - Math.max(0, r.y));
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const label = el => (el.getAttribute('aria-label') || el.title || el.textContent || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 50);
  const cls = el => String(el.className?.baseVal ?? el.className ?? '').slice(0, 60);
  const rgba = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] };

  // C2: 컨트롤의 크기와 위치(닫힌 시트 안의 것은 빼고). 보조 측정: 화면 밖(off)과, 가운데가 다른 요소에 덮인 것(covered).
  // 라벨 안의 입력(라디오, 체크박스)은 라벨 줄이 누르는 자리이고, 문장 안 링크는 WCAG 2.5.8의 예외라 세지 않는다.
  const inLabel = el => el.tagName === 'INPUT' && !!el.closest('label');
  const inlineLink = el => (el.tagName === 'A' || getComputedStyle(el).display === 'inline') && !!el.parentElement && [...el.parentElement.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
  const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [role=tab], summary')].filter(el => vis(el) && !inLabel(el) && !inlineLink(el)).map(el => {
    const r = rect(el); return { tag: el.tagName.toLowerCase(), cls: cls(el), label: label(el), ...r, off: !inView(r), covered: coveredBy(el) } });

  // C1: 가로로 넘치는 요소(가로 스크롤 상자 안의 것은 정상이므로 뺀다).
  const scrollsX = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true } return false };
  const overflowers = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (overflowers.length >= 8) break;
    const r = el.getBoundingClientRect();
    if (r.right > W + 1 && r.width > 0 && vis(el) && !scrollsX(el) && getComputedStyle(el).position !== 'fixed') overflowers.push({ cls: cls(el) || el.tagName.toLowerCase(), ...rect(el) });
  }
  // P3-1, P3-5: 가로 스크롤 상자.
  const scrollers = [...document.body.querySelectorAll('*')].filter(el => { const o = getComputedStyle(el).overflowX;
    return (o === 'auto' || o === 'scroll') && el.scrollWidth > el.clientWidth + 1 && vis(el) }).slice(0, 8)
    .map(el => ({ cls: cls(el), ...rect(el), scrollWidth: el.scrollWidth }));

  // P1-4, P3-4: 열린 시트(화면에 30 % 넘게 들어오고 높이가 화면의 25 % 이상인 패널, 열린 dialog)와 배경의 불투명도.
  // 아래에 접혀 붙은 피드 띠처럼 낮은 패널은 시트로 세지 않는다.
  const sheets = [...document.querySelectorAll('.ui-panel, dialog[open]')]
    .filter(el => vis(el) && shownArea(rect(el)) > 0.3 * rect(el).w * rect(el).h && (el.tagName === 'DIALOG' || rect(el).h >= 0.25 * H))
    .map(el => ({ cls: cls(el), ...rect(el), alpha: (rgba(getComputedStyle(el).backgroundColor) || [0, 0, 0, 0])[3] }));
  // P1-5: 보이는 토스트와 시트에 겹치는 것.
  const toasts = [...document.querySelectorAll('.ui-toasts > *')].filter(vis).map(el => ({ ...rect(el), text: label(el) }));
  // 모달 대화창 아래에 깔린 토스트는 보이지 않으므로, 가운데 지점에서 맨 위에 있는 토스트만 센다.
  const toastOnTop = el => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && el.contains(t) };
  const toastEls = [...document.querySelectorAll('.ui-toasts > *')].filter(vis);
  const toastOverSheet = toastEls.filter(el => toastOnTop(el) && sheets.some(s => overlap(rect(el), s))).map(el => label(el));

  // P1-1, P1-2, P1-3, P1-6: 권한·질문 카드.
  const perm = (() => {
    const c = [...document.querySelectorAll('.ui-perm')].find(vis); if (!c) return null;
    // 버튼 줄은 카드 안에 있거나, 휴대폰에서는 상세 시트 맨 아래(.ui-perm-bar)로 옮겨져 있다. 거절 양식이 열려 있으면
    // 지금 눌러야 하는 것은 그 양식의 버튼 줄이다.
    const deny = [...c.querySelectorAll('.ui-perm__deny')].find(vis);
    const act = deny ? deny.querySelector('.ui-perm__actions')
      : [...c.querySelectorAll('.ui-perm__actions'), ...document.querySelectorAll('.ui-perm-bar .ui-perm__actions')].find(vis);
    const a = act ? rect(act) : null;
    // 버튼 줄의 버튼 가운데 다른 요소(입력칸 등)에 덮인 것.
    const buttonsCovered = act ? [...act.querySelectorAll('button')].filter(vis).filter(b => coveredBy(b)).map(b => `${label(b)} ← ${coveredBy(b)}`) : [];
    const head = c.querySelector('.ui-perm__head');
    const text = c.querySelector('.ui-perm__head-text'), timer = c.querySelector('.ui-perm__timer');
    const reason = [...c.querySelectorAll('.ui-perm__reason')].find(vis);
    return { kind: [...c.querySelectorAll('.ui-perm-ask')].some(vis) ? 'ask' : 'perm', actions: a, actionsInView: a ? inView(a) : null,
      actionsPos: act ? getComputedStyle(act.closest('.ui-perm-bar') || act).position : null, buttonsCovered,
      headOverflow: head ? head.scrollWidth > head.clientWidth + 1 : null,
      // 머리의 글자 묶음이 머리 폭에서 차지하는 비율(작으면 한 단어씩 쪼개진다)과, 글자 묶음과 남은 시간 표시의 겹침.
      headTextRatio: head && text && vis(text) ? Math.round(rect(text).w / rect(head).w * 100) / 100 : null,
      headOverlap: !!(text && timer && vis(text) && vis(timer) && overlap(rect(text), rect(timer))),
      reason: reason ? { ...rect(reason), inView: inView(rect(reason)) } : null,
      composerShown: [...document.querySelectorAll('.ui-msg__input')].some(vis) };
  })();

  // P2-3: 보이는 단축키 안내(.ui-kbd)와, 글자로 쓴 단축키 안내("Shift+Enter", "(L)" 같은 것).
  const kbd = [...document.querySelectorAll('.ui-kbd')].filter(vis).length;
  const HINT = /Shift\s*\+\s*Enter|Enter sends|Ctrl\s*\+|⌘|\((?:[A-Z?\[\]+−-]|Shift[^)]*)\)/;
  const hintText = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (hintText.length >= 6) break;
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
    if (own && HINT.test(own) && vis(el) && shownArea(rect(el)) > 0) hintText.push(own.slice(0, 60));
  }

  // P3-1: 상단 사용량 카드 줄이 가로로 스크롤되는지와, 카드 밖으로 삐져나간 글자·막대의 수(찌그러진 카드).
  const usage = (() => {
    const box = [...document.querySelectorAll('.ui-usage')].find(vis); if (!box) return null;
    const cards = [...box.querySelectorAll('.ui-usage-card')].filter(vis);
    let spill = 0;
    for (const c of cards) { const cr = c.getBoundingClientRect();
      for (const d of c.querySelectorAll('*')) { if (!vis(d) || d.closest('.ui-usage-tip')) continue; const r = d.getBoundingClientRect();
        if (r.left < cr.left - 1 || r.right > cr.right + 1) spill++ } }
    const o = getComputedStyle(box).overflowX;
    return { cards: cards.length, scrolls: (o === 'auto' || o === 'scroll') && box.scrollWidth > box.clientWidth + 1, spill,
      minCardW: cards.length ? Math.min(...cards.map(c => Math.round(c.getBoundingClientRect().width))) : null };
  })();

  // C4(근사치): 직접 글자를 가진 보이는 요소의 글자색과, 조상에서 처음 만나는 불투명한 배경색의 대비.
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) };
  const bgOf = el => { for (let p = el; p; p = p.parentElement) { const c = rgba(getComputedStyle(p).backgroundColor); if (c && c[3] >= 0.99) return c;
    if (getComputedStyle(p).backgroundImage !== 'none') return null } return [255, 255, 255, 1] };
  const lowContrast = []; let checked = 0, minRatio = 21;
  for (const el of document.body.querySelectorAll('*')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!vis(el) || shownArea(rect(el)) === 0) continue;
    const fg = rgba(getComputedStyle(el).color); const bg = bgOf(el); if (!fg || !bg) continue;
    checked++;
    const a = fg[3]; const mix = [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a));
    const L1 = lum(mix), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const s = getComputedStyle(el); const big = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
    minRatio = Math.min(minRatio, ratio);
    if (ratio < (big ? 3 : 4.5) && lowContrast.length < 6) lowContrast.push({ text: el.textContent.trim().slice(0, 30), ratio: Math.round(ratio * 100) / 100, cls: cls(el) });
  }

  return { vw: W, vh: H, sw: document.documentElement.scrollWidth,
    landscapeRule: matchMedia('(max-height: 500px) and (pointer: coarse)').matches,
    controls, overflowers, scrollers, sheets, toasts, toastOverSheet, perm, kbd, hintText, usage,
    contrast: { checked, low: lowContrast, min: Math.round(minRatio * 100) / 100 } };
}"""
MEASURE = MEASURE.replace('() => {', '() => {\n  ' + AT, 1)


# ------------------------------------------------------------------------------------------------ 동작

def press(page, at, what, wait=1200):
    """가운데가 덮이지 않았을 때만 누른다. 덮였으면 그 자리를 눌러도 다른 것이 눌리므로 실패로 남긴다."""
    if at[2]:
        raise LookupError(f'가려짐: {what} ← {at[2]}')
    page.touchscreen.tap(at[0], at[1])
    page.wait_for_timeout(wait)


def tap(page, label):
    at = page.evaluate(FIND, label)
    if not at:
        raise LookupError(f'보이는 컨트롤 없음: {label!r}')
    press(page, at, repr(label))


def tap_css(page, css):
    at = page.evaluate("(css) => { " + AT + """ const el = [...document.querySelectorAll(css)].find(e => e.getBoundingClientRect().width > 0 && !e.closest('[hidden], [aria-hidden="true"]'));
      if (!el) return null; el.scrollIntoView({ block: 'center' }); return at(el) }""", css)
    if not at:
        raise LookupError(f'보이는 요소 없음: {css!r}')
    press(page, at, css, 1500)


# `scope` 안에서 이름(aria-label, 없으면 글자)이 label로 시작하는 보이는 버튼의 가운데.
FIND_IN = r"""([scope, label]) => { """ + AT + r""" const el = [...document.querySelectorAll(scope)].find(b => b.getClientRects().length > 0 && !b.closest('[hidden]')
    && ((b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ').startsWith(label)));
  return el ? at(el) : null }"""


def tap_bar(page, label):
    """상단 바 버튼: 바에 보이면 바로 누르고, 폭 때문에 빠졌으면 ⋯ 메뉴(ui/moremenu.ts)를 거쳐 누른다. 바와 메뉴
    밖은 찾지 않는다(화면의 다른 글자에 같은 낱말이 있을 수 있다)."""
    at = page.evaluate(FIND_IN, ['.ui-topbar button', label])
    if not at:
        tap_css(page, '.ui-btn-more')
        at = page.evaluate(FIND_IN, ['.ui-more__item', label])
    if not at:
        raise LookupError(f'바에도 ⋯ 메뉴에도 없음: {label!r}')
    press(page, at, repr(label), 1500)


def show(page, label):
    """누르지 않고 화면 안으로 스크롤만 한다."""
    if not page.evaluate(FIND, label):
        raise LookupError(f'보이는 컨트롤 없음: {label!r}')
    page.wait_for_timeout(600)


def wait_for(page, label, secs=30):
    for _ in range(secs):
        if page.evaluate(FIND, label):
            return
        page.wait_for_timeout(1000)
    raise LookupError(f'{label!r}이(가) 나타나지 않음')


def reply(page):
    """권한 요청('approve a command' 같은) 알림의 Respond를 눌러 그 에이전트의 권한 카드를 연다."""
    reply_to(page, 'approve')


def reply_to(page, what, secs=60):
    """글자에 `what`이 든 알림의 Respond(.ui-toast__answer, 그 에이전트에 요청이 있을 때만 보임)를 누른다."""
    js = "(what) => { " + AT + """ for (const t of document.querySelectorAll('.ui-toasts > *')) {
        if (!t.textContent.includes(what)) continue;
        const b = t.querySelector('.ui-toast__answer'); if (!b || b.hidden) continue;
        if (b.getBoundingClientRect().width > 0) return at(b);
      } return null }"""
    for _ in range(secs):
        at = page.evaluate(js, what)
        if at:
            press(page, at, f'{what!r} 알림의 Respond', 1500)
            # 누른 뒤 카드가 정말 열렸는지 본다.
            for _ in range(5):
                if page.evaluate("[...document.querySelectorAll('.ui-perm')].some(e => e.getBoundingClientRect().width > 0 && !e.closest('[hidden], [aria-hidden=\"true\"]'))"):
                    return
                page.wait_for_timeout(1000)
            raise LookupError(f'{what!r} 알림의 Respond를 눌렀지만 카드가 열리지 않음')
        page.wait_for_timeout(1000)
    raise LookupError(f'{what!r}이(가) 든 알림 없음')


def open_agent(page):
    """사이드바에서 메시지 입력칸이 보이는 첫 에이전트를 연다."""
    tap(page, 'Sidebar')
    n = page.evaluate("document.querySelectorAll('#ui-sidebar .ui-agent').length")
    for i in range(min(n, 8)):
        if i:
            tap(page, 'Sidebar')
        page.evaluate("(i) => document.querySelectorAll('#ui-sidebar .ui-agent')[i].scrollIntoView({ block: 'center' })", i)
        box = page.evaluate("(i) => { const r = document.querySelectorAll('#ui-sidebar .ui-agent')[i].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] }", i)
        page.touchscreen.tap(box[0], box[1])
        page.wait_for_timeout(1500)
        if page.evaluate("[...document.querySelectorAll('.ui-msg__input')].some(e => e.getBoundingClientRect().width > 0 && !e.closest('[hidden], [aria-hidden=\"true\"]'))"):
            return
    raise LookupError('메시지 입력칸이 보이는 에이전트 없음')


def press_enter(page):
    """P1-7: 입력칸에 글자를 넣고 Enter를 누른 뒤 값을 남긴다(보내기는 GET이 아니라 막힌다)."""
    page.evaluate("""() => { const el = [...document.querySelectorAll('.ui-msg__input')].find(e => e.getBoundingClientRect().width > 0); el.focus() }""")
    page.keyboard.type('a')
    page.keyboard.press('Enter')
    page.wait_for_timeout(600)
    value = page.evaluate("""() => { const el = [...document.querySelectorAll('.ui-msg__input')].find(e => e.getBoundingClientRect().width > 0); return el ? el.value : null }""")
    return {'enter': {'value': value, 'newline': value is not None and '\n' in value}}


def wait_toast(page, secs=45):
    """P1-5: 시트가 열린 채로 토스트가 뜰 때까지 기다린다."""
    for _ in range(secs):
        if page.evaluate("[...document.querySelectorAll('.ui-toasts > *')].some(e => e.getBoundingClientRect().width > 0)"):
            page.wait_for_timeout(800)
            return
        page.wait_for_timeout(1000)
    raise LookupError('토스트가 뜨지 않음')


def long_press_reorder(page):
    """P2-2: 사이드바 첫 방의 머리를 길게 누른 뒤 둘째 방 아래로 끌어 놓고, 방 순서가 바뀌었는지 남긴다.
    Playwright의 터치는 탭만 있어서, 터치 pointer 이벤트를 직접 보낸다."""
    tap(page, 'Sidebar')
    order = "() => [...document.querySelectorAll('#ui-sidebar .ui-room__head[data-reorder-room]')].map(e => e.dataset.reorderRoom)"
    before = page.evaluate(order)
    if len(before) < 2:
        raise LookupError('방이 둘 이상 있어야 순서를 바꿀 수 있음')
    page.evaluate("""() => { const heads = [...document.querySelectorAll('#ui-sidebar .ui-room__head[data-reorder-room]')];
      const a = heads[0], r = a.getBoundingClientRect(); window.__drag = { a, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      a.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: window.__drag.x, clientY: window.__drag.y })) }""")
    page.wait_for_timeout(700)
    page.evaluate("""() => { const heads = [...document.querySelectorAll('#ui-sidebar .ui-room__head[data-reorder-room]')];
      const b = heads[1].getBoundingClientRect(); const y = b.top + b.height * 0.8;
      for (const yy of [window.__drag.y + 10, y]) window.__drag.a.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: window.__drag.x, clientY: yy }));
      window.__drag.a.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: window.__drag.x, clientY: y })) }""")
    page.wait_for_timeout(800)
    after = page.evaluate(order)
    return {'reorder': {'before': before[:3], 'after': after[:3], 'moved': after[:2] == [before[1], before[0]]}}


def open_timelapse(page):
    """P2-1: 타임랩스 버튼이 바에 보이면 바로, 폭 때문에 빠졌으면 ⋯ 메뉴로 연다. 열렸는지 확인한다."""
    visible = page.evaluate("() => { const b = document.querySelector('.ui-btn-timelapse'); return !!b && b.getClientRects().length > 0 }")
    if visible:
        tap_css(page, '.ui-btn-timelapse')
    else:
        tap_css(page, '.ui-btn-more')
        tap(page, 'Timelapse')
    if not page.evaluate("() => { const l = document.querySelector('.ui-lapse'); return !!l && !l.hidden && l.getClientRects().length > 0 }"):
        raise LookupError('타임랩스가 열리지 않음')
    return {'timelapse': {'via': 'bar' if visible else 'more'}}


def push_row(page):
    """P2-4: Configurações no acesso do celular: o interruptor "Notificações no celular", o estado e a dica."""
    page.wait_for_timeout(800)
    if not page.evaluate("() => { const s = document.querySelector('.ui-settings'); return !!s && (s.matches(':popover-open') || s.classList.contains('is-open')) }"):
        raise LookupError('설정 창이 열려 있지 않음')
    row = page.evaluate("""() => { const w = document.querySelector('.ui-set-push'); if (!w || w.hidden) return null;
      const b = w.querySelector('.ui-switch'); w.scrollIntoView({ block: 'center' });
      return { checked: b.getAttribute('aria-checked'), disabled: b.disabled, hint: (w.querySelector('.ui-set__hint') || {}).textContent || '' } }""")
    if not row:
        raise LookupError('o interruptor das notificações no celular não aparece')
    page.wait_for_timeout(400)
    return {'push': row}


def scroll_inner(page):
    page.evaluate("document.querySelectorAll('*').forEach(e => { if (e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.getBoundingClientRect().top > 100) e.scrollTop = 99999 })")
    page.wait_for_timeout(800)


# ------------------------------------------------------------------------------------------------ 단계

# 이름: (주소, 동작, 가로 프로필에서도 찍나, 휴대폰 포트처럼 /api/access를 답하나, 점검표 항목)
STEPS = {
    'home': (MOCK, [], True, False, 'C1-C4 P3-1 P3-2'),
    'sidebar': (MOCK, [lambda p: tap(p, 'Sidebar')], False, False, 'C1-C4'),
    'feed': (MOCK, [lambda p: tap(p, 'Open feed')], False, False, 'C1-C4'),
    'myday': (MOCK, [lambda p: tap_bar(p, 'My day')], False, False, 'C1-C4'),
    'settings': (MOCK, [lambda p: tap_bar(p, 'Settings')], False, False, 'C1-C4'),
    'settings-phone': (REAL, [lambda p: tap_bar(p, 'Settings'), push_row], False, True, 'P2-4'),
    'more-menu': (REAL, [lambda p: tap_css(p, '.ui-btn-more')], False, True, 'P2-1 P3-2'),
    'help': (MOCK, [lambda p: tap_bar(p, 'Help')], False, False, 'C1-C4 P2-3'),
    'overview': (MOCK, [lambda p: tap_bar(p, 'Overview')], True, False, 'P3-3'),
    'room-drawer': (MOCK, [lambda p: tap(p, 'Sidebar'), lambda p: tap(p, 'Room ')], False, False, 'C1-C4'),
    'details-permission': (MOCK, [reply], True, False, 'P1-1 P1-2 P1-6 P1-9'),
    'approve-buttons': (MOCK, [reply, lambda p: show(p, 'Approve')], True, False, 'P1-1'),
    'deny-reason': (MOCK, [reply, lambda p: tap(p, 'Deny')], True, False, 'P1-3'),
    'details-scrolled': (MOCK, [reply, scroll_inner], False, False, 'P1-1'),
    'question': (QMOCK, [lambda p: reply_to(p, 'answer a question')], True, False, 'P1-1 P1-2 P1-6'),
    'question-options': (QMOCK, [lambda p: reply_to(p, 'answer a question'), lambda p: show(p, 'Other')], False, False, 'P1-1'),
    'composer-enter': (MOCK, [open_agent, press_enter], True, False, 'P1-7'),
    'toast-over-sheet': (QMOCK, [open_agent, wait_toast], False, False, 'P1-4 P1-5'),
    'terminal': (MOCK, [reply, lambda p: tap(p, 'Open terminal')], False, False, 'C1-C4 P3-5'),
    'timelapse': (REAL, [open_timelapse], True, True, 'P2-1'),
    'reorder': (MOCK, [long_press_reorder], False, False, 'P2-2'),
    'deliveries': (REAL, [lambda p: tap_css(p, '.ui-btn-deliv')], False, True, 'C1-C4'),
    'spawn': (REAL, [lambda p: tap_css(p, '.ui-btn-spawn')], False, True, 'C1-C4'),
    'history': (REAL, [lambda p: tap_bar(p, 'Session history')], False, True, 'C1-C4'),
    'login': ('login', [], True, False, 'C1-C4'),
}


# 권한·질문 카드를 재는 단계(측정할 때 카드가 열려 있어야 한다).
CARD_STEPS = {'details-permission', 'approve-buttons', 'deny-reason', 'details-scrolled', 'question', 'question-options'}

def summarize(m):
    """한 줄 요약(출력과 갤러리에 같이 쓴다)."""
    # 크기 기준은 지금 누를 수 있는 것(화면 안에 있고 다른 요소에 덮이지 않은 것)만 센다.
    live = [c for c in m['controls'] if not c['off'] and not c['covered']]
    small = sum(1 for c in live if c['w'] < 44 or c['h'] < 44)
    tiny = sum(1 for c in live if c['w'] < 24 or c['h'] < 24)
    off = sum(1 for c in m['controls'] if c['off'])
    covered = sum(1 for c in m['controls'] if c['covered'])
    parts = [f"{m['vw']}x{m['vh']}", ('리플로 OK' if m['sw'] <= m['vw'] else f"가로 넘침 {m['sw']}"),
             f"컨트롤 {len(m['controls'])} <24:{tiny} <44:{small} 화면밖:{off} 가려짐:{covered}",
             f"시트 {len(m['sheets'])}" + (f" 반투명:{sum(1 for s in m['sheets'] if s['alpha'] < 0.99)}" if m['sheets'] else ''),
             f"대비<기준 {len(m['contrast']['low'])}/{m['contrast']['checked']} 최소 {m['contrast']['min']}"]
    if m.get('usage'):
        u = m['usage']
        parts.append(f"사용량카드 {u['cards']}장 최소폭:{u['minCardW']} 가로스크롤:{u['scrolls']} 삐져나감:{u['spill']}")
    if m['toasts']:
        parts.append(f"토스트 {len(m['toasts'])} 시트겹침:{len(m['toastOverSheet'])}")
    if m['kbd'] or m['hintText']:
        parts.append(f"단축키안내 표시:{m['kbd']} 글자:{len(m['hintText'])}")
    if m['perm']:
        p = m['perm']
        parts.append(f"카드({p['kind']}) 버튼화면안:{p['actionsInView']} 버튼가려짐:{len(p['buttonsCovered'])} pos:{p['actionsPos']}"
                     f" 입력칸:{p['composerShown']} 머리넘침:{p['headOverflow']} 머리글자폭:{p['headTextRatio']} 머리겹침:{p['headOverlap']}"
                     + (f" 사유칸화면안:{p['reason']['inView']}" if p['reason'] else ''))
    if m.get('extra', {}).get('push'):
        pr = m['extra']['push']
        parts.append(f"알림스위치:{pr['checked']} 꺼짐:{pr['disabled']} 안내:{pr['hint'][:40]!r}")
    if m.get('extra', {}).get('timelapse'):
        parts.append(f"타임랩스:{m['extra']['timelapse']['via']}")
    if m.get('extra', {}).get('reorder'):
        parts.append(f"길게눌러순서바꿈:{m['extra']['reorder']['moved']}")
    if m.get('extra', {}).get('enter'):
        e = m['extra']['enter']
        parts.append(f"Enter줄바꿈:{e['newline']} (Enter 뒤 값 {e['value']!r})")
    if m['landscapeRule']:
        parts.append('가로규칙')
    if m['console']:
        parts.append(f"콘솔오류 {len(m['console'])}")
    return ' | '.join(parts)


def run_step(browser, device, out, profile, step, url, actions, phone, items):
    """새 컨텍스트에서 한 단계를 돌려 스크린샷을 찍고 측정값을 담은 항목을 돌려준다."""
    ctx = browser.new_context(**device, locale='en-US')

    def guard(route):
        req = route.request
        if req.method != 'GET':
            return route.abort()
        if phone and req.url.split('?')[0].endswith('/api/access'):
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(PHONE_ACCESS))
        return route.continue_()

    ctx.route('**/api/**', guard)
    if url == LOGIN:
        body = open(f'{out}/login.html').read()
        ctx.route(LOGIN, lambda route: route.fulfill(status=200, content_type='text/html; charset=utf-8', body=body))
    page = ctx.new_page()
    errors = []
    page.on('console', lambda msg: errors.append(msg.text[:200]) if msg.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)[:200]))
    png = f'{profile}/{step}.png'
    entry = {'items': items, 'url': url.replace(BASE, '')}
    try:
        page.goto(url)
        page.wait_for_timeout(800 if url == LOGIN else 5000)
        extra = {}
        for a in actions:
            r = a(page)
            if isinstance(r, dict):
                extra.update(r)
        page.wait_for_timeout(1000)
        page.screenshot(path=f'{out}/{png}')
        m = page.evaluate(MEASURE)
        # 카드를 재는 단계: 데모가 그사이 요청을 끝내 카드가 닫혔으면 다시 해 본다.
        if step in CARD_STEPS and not m['perm']:
            raise LookupError('측정할 때 카드가 이미 닫힘')
        m['console'] = errors
        m['extra'] = extra
        entry.update(ok=True, png=png, m=m, summary=summarize(m))
        if os.path.exists(f'{out}/{profile}/{step}-failed.png'):
            os.remove(f'{out}/{profile}/{step}-failed.png')
    except Exception as e:  # noqa: BLE001
        png = f'{profile}/{step}-failed.png'
        page.screenshot(path=f'{out}/{png}')
        entry.update(ok=False, png=png, error=f'{type(e).__name__}: {str(e)[:200]}')
    ctx.close()
    return entry


def shoot(out, profile, only):
    from playwright.sync_api import sync_playwright

    device, land = PROFILES[profile]
    os.makedirs(f'{out}/{profile}', exist_ok=True)
    report = {}
    with sync_playwright() as pw:
        browser = pw.webkit.launch()
        for step, (url, actions, in_land, phone, items) in STEPS.items():
            if (only and step not in only) or (land and not in_land):
                continue
            if url == 'login':
                if not os.path.exists(f'{out}/login.html'):
                    print(f'{profile} {step}: 건너뜀(run.sh가 만드는 login.html 없음)')
                    continue
                # 서버 주소 아래에서 띄워야 /manifest.webmanifest 같은 상대 경로가 실제처럼 읽힌다.
                url = LOGIN
            # 데모는 알림이 나오는 때가 실행마다 달라서, 기다리던 것이 안 나오면 새 페이지로 두 번 더 해 본다. 앞선
            # 시도의 실패 이유(가려진 버튼처럼 그 자체가 발견인 것)는 `earlier`에 남긴다.
            tries = 3 if url in (MOCK, QMOCK) else 1
            earlier = []
            for attempt in range(1, tries + 1):
                entry = run_step(browser, pw.devices[device], out, profile, step, url, actions, phone, items)
                if entry['ok'] or not entry['error'].startswith('LookupError') or attempt == tries:
                    break
                earlier.append(entry['error'])
            entry['tries'] = attempt
            entry['earlier'] = earlier
            note = f' (시도 {attempt}; 앞선 실패: {"; ".join(earlier)})' if earlier else ''
            print(f'{profile} {step}: ' + (entry['summary'] if entry['ok'] else f'실패 {entry["error"]}') + note)
            report[step] = entry
        browser.close()
    old = {}
    path = f'{out}/report-{profile}.json'
    if only and os.path.exists(path):
        old = json.load(open(path))
    old.update(report)
    json.dump(old, open(path, 'w'), ensure_ascii=False, indent=1)


def gallery(out):
    """단계마다 한 줄, 프로필마다 한 칸: 스크린샷과 요약."""
    reports = {os.path.basename(f)[7:-5]: json.load(open(f)) for f in sorted(glob.glob(f'{out}/report-*.json'))}
    order = [p for p in PROFILES if p in reports]
    rows = []
    for step, (_, _, _, _, items) in STEPS.items():
        cells = []
        for p in order:
            e = reports[p].get(step)
            if not e:
                cells.append('<td class="none">—</td>')
                continue
            text = html.escape(e.get('summary') or e.get('error', ''))
            if e.get('earlier'):
                text += '<br>앞선 실패: ' + html.escape('; '.join(e['earlier']))
            cells.append(f'<td class="{"ok" if e["ok"] else "fail"}"><a href="{e["png"]}"><img src="{e["png"]}" loading="lazy"></a><p>{text}</p></td>')
        rows.append(f'<tr><th>{step}<small>{items}</small></th>{"".join(cells)}</tr>')
    head = ''.join(f'<th>{p}</th>' for p in order)
    doc = f"""<!doctype html><meta charset="utf-8"><title>Habblaud 휴대폰 점검</title>
<style>
:root {{ color-scheme: light dark; --fg: #1b1d24; --bg: #f6f6f3; --line: #d6d6cf; --bad: #b3261e; }}
@media (prefers-color-scheme: dark) {{ :root {{ --fg: #e8e6df; --bg: #14161f; --line: #3a3f58; --bad: #ff8a80; }} }}
body {{ margin: 16px; background: var(--bg); color: var(--fg); font: 13px/1.4 -apple-system, system-ui, sans-serif; }}
table {{ border-collapse: collapse; }} th, td {{ border: 1px solid var(--line); padding: 8px; vertical-align: top; text-align: left; }}
th small {{ display: block; font-weight: 400; opacity: .7; }} img {{ max-width: 260px; max-height: 420px; display: block; }}
td p {{ max-width: 260px; margin: 6px 0 0; }} td.fail p {{ color: var(--bad); }}
</style>
<h1>Habblaud 휴대폰 점검</h1><p>항목 번호는 tools/phone/CHECKLIST.md. REAL 단계는 실제 세션 화면이니 밖으로 보내지 마세요.</p>
<table><tr><th>단계</th>{head}</tr>{''.join(rows)}</table>"""
    open(f'{out}/index.html', 'w').write(doc)
    print(f'{out}/index.html')


def main(argv):
    if '--list' in argv:
        for p, (d, land) in PROFILES.items():
            print(f'프로필 {p}: {d}{" (가로 단계만)" if land else ""}')
        for s, (url, _, land, phone, items) in STEPS.items():
            print(f'단계 {s:20} {items:22} {"가로도 " if land else ""}{"REAL" if url == REAL else ""}')
        return 0
    if not argv:
        print(__doc__)
        return 2
    out = argv[0]
    rest = argv[1:]
    if '--gallery' in rest:
        gallery(out)
        return 0
    if '--profile' not in rest:
        print('--profile이 필요합니다(--list로 목록).')
        return 2
    i = rest.index('--profile')
    profile = rest[i + 1]
    only = set(rest[:i] + rest[i + 2:])
    unknown = only - set(STEPS)
    if profile not in PROFILES or unknown:
        print(f'모르는 프로필이나 단계: {profile if profile not in PROFILES else ""} {sorted(unknown)}')
        return 2
    shoot(out, profile, only)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
