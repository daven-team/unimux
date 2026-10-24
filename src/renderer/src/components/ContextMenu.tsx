import { useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';

export type MenuItem =
  /** color: a small swatch before the label (a profile's or an SSH host's colour). icon: a 14px icon before the label (1.0.7);
   *  once one item of a menu has an icon, every item keeps the icon column, so the labels stay in one line. */
  | { label: string; onClick: () => void; danger?: boolean; hint?: string; disabled?: boolean; color?: string; icon?: ReactNode }
  | { sep: true }
  | { header: string }
  | { colors: string[]; onPick: (color: string) => void };

const useMenu = create<{ menu: { x: number; y: number; items: MenuItem[]; returnFocus: HTMLElement | null } | null }>(() => ({ menu: null }));

export function openMenu(x: number, y: number, items: MenuItem[]): void {
  const previous = useMenu.getState().menu;
  const focus = document.activeElement;
  const returnFocus = focus instanceof HTMLElement && !focus.closest('.menu') ? focus : previous?.returnFocus ?? null;
  useMenu.setState({ menu: { x, y, items, returnFocus } });
}

export function openMenuAt(el: HTMLElement, items: MenuItem[]): void {
  const r = el.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, items);
}

const close = () => useMenu.setState({ menu: null });

export function ContextMenuHost() {
  const { tr } = useI18n();
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
    ref.current.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        requestAnimationFrame(() => { if (menu.returnFocus?.isConnected) menu.returnFocus.focus({ preventScroll: true }); });
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
      if (!items.length) return;
      e.preventDefault();
      e.stopPropagation();
      const index = items.findIndex((item) => item === document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  if (!menu) return null;
  const withIcons = menu.items.some((item) => 'icon' in item && !!item.icon);
  return (
    <div className={`menu ${withIcons ? 'with-icons' : ''}`} role="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((item, i) => {
        if ('sep' in item) return <div key={i} className="menu-sep" role="separator" />;
        if ('header' in item) return <div key={i} className="menu-label">{item.header}</div>;
        if ('colors' in item)
          return (
            <div key={i} className="colors">
              {item.colors.map((c) => (
                <button key={c} role="menuitem" aria-label={tr('Kolor {color}', { color: c })} title={c} style={{ background: c }} onClick={() => { close(); item.onPick(c); }} />
              ))}
            </div>
          );
        return (
          <button key={i} type="button" role="menuitem" tabIndex={item.disabled ? -1 : 0} className={`menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`} aria-disabled={item.disabled || undefined} onClick={() => { if (item.disabled) return; close(); item.onClick(); }}>
            {withIcons && <span className="menu-icon" aria-hidden="true">{item.icon}</span>}
            <span style={{ flex: 1 }}>{item.color && <span className="menu-swatch" style={{ background: item.color }} aria-hidden="true" />}{item.label}</span>
            {item.hint && <span className="kbd">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
