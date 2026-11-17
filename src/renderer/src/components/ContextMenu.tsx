import { useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';

export type MenuItem =
  /** color: a small swatch before the label (a profile's or an SSH host's colour). icon: a 14px icon before the label (1.0.7);
   *  once one item of a menu has an icon, every item keeps the icon column, so the labels stay in one line. */
  | { label: string; onClick: () => void; danger?: boolean; hint?: string; disabled?: boolean; color?: string; icon?: ReactNode }
  | { sep: true }
  | { header: string }
  | { colors: string[]; onPick: (color: string) => void }
  /** 1.2.5: a submenu, opened at the item's right on hover, click, Enter or Right (Left goes back). */
  | { label: string; submenu: MenuItem[]; disabled?: boolean; icon?: ReactNode };

/**
 * owner: who opened the menu (the title bar's menu bar marks its menus, useMenuOwner). onSide: Left / Right while the menu
 * is open (the menu bar moves to the neighbouring menu).
 */
export interface MenuOptions { owner?: string; onSide?: (dir: -1 | 1) => void }
const useMenu = create<{ menu: { x: number; y: number; items: MenuItem[]; returnFocus: HTMLElement | null; options: MenuOptions } | null }>(() => ({ menu: null }));

export function openMenu(x: number, y: number, items: MenuItem[], options: MenuOptions = {}): void {
  const previous = useMenu.getState().menu;
  const focus = document.activeElement;
  const returnFocus = focus instanceof HTMLElement && !focus.closest('.menu') ? focus : previous?.returnFocus ?? null;
  useMenu.setState({ menu: { x, y, items, returnFocus, options } });
}

/** The owner of the open menu (null: none open, or one without an owner). */
export const useMenuOwner = (): string | null => useMenu((s) => s.menu?.options.owner ?? null);
export const menuOwner = (): string | null => useMenu.getState().menu?.options.owner ?? null;
export const closeMenu = (): void => useMenu.setState({ menu: null });

export function openMenuAt(el: HTMLElement, items: MenuItem[], options?: MenuOptions): void {
  const r = el.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, items, options);
}

const close = () => useMenu.setState({ menu: null });

export function ContextMenuHost() {
  const { tr } = useI18n();
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  /** The open submenu: its item's index and the item's box (the submenu goes to its right, or left when there is no room). */
  const [sub, setSub] = useState<{ index: number; anchor: DOMRect; focus: boolean } | null>(null);
  const [subPos, setSubPos] = useState({ x: 0, y: 0 });
  useEffect(() => setSub(null), [menu]);
  useLayoutEffect(() => {
    if (!sub || !subRef.current) return;
    const r = subRef.current.getBoundingClientRect();
    const right = sub.anchor.right + 2;
    setSubPos({
      x: right + r.width <= window.innerWidth - 8 ? right : Math.max(8, sub.anchor.left - r.width - 2),
      y: Math.max(8, Math.min(sub.anchor.top - 6, window.innerHeight - r.height - 8)),
    });
    if (sub.focus) subRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [sub]);

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
      // The menu bar's buttons open, switch and close their menus themselves.
      if (e.target instanceof Element && e.target.closest('[data-menubar]')) return;
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
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const inSub = !!active && !!subRef.current?.contains(active);
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        // Left in a submenu goes back to its item; Right on an item with a submenu opens it.
        if (e.key === 'ArrowLeft' && inSub) {
          e.preventDefault();
          e.stopPropagation();
          const index = sub?.index;
          setSub(null);
          ref.current?.querySelector<HTMLButtonElement>(`[data-sub="${index}"]`)?.focus({ preventScroll: true });
          return;
        }
        if (e.key === 'ArrowRight' && active?.dataset.sub !== undefined) {
          e.preventDefault();
          e.stopPropagation();
          setSub({ index: Number(active.dataset.sub), anchor: active.getBoundingClientRect(), focus: true });
          return;
        }
      }
      if (menu.options.onSide && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        menu.options.onSide(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      // Up / Down move within the menu that has the focus (the submenu or the menu itself).
      const scope = inSub ? subRef.current : ref.current;
      const items = Array.from(scope?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])
        .filter((item) => inSub || !subRef.current?.contains(item));
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
  }, [menu, sub]);

  if (!menu) return null;
  const iconsIn = (items: MenuItem[]) => items.some((item) => 'icon' in item && !!item.icon);
  const withIcons = iconsIn(menu.items);
  const openSub = sub ? menu.items[sub.index] : null;
  const subItems = openSub && 'submenu' in openSub ? openSub.submenu : null;
  const renderItems = (items: MenuItem[], top: boolean, icons: boolean) => items.map((item, i) => {
        if ('sep' in item) return <div key={i} className="menu-sep" role="separator" />;
        if ('header' in item) return <div key={i} className="menu-label">{item.header}</div>;
        if ('colors' in item)
          return (
            <div key={i} className="colors" onMouseEnter={top ? () => setSub(null) : undefined}>
              {item.colors.map((c) => (
                <button key={c} role="menuitem" aria-label={tr('Kolor {color}', { color: c })} title={c} style={{ background: c }} onClick={() => { close(); item.onPick(c); }} />
              ))}
            </div>
          );
        if ('submenu' in item) {
          const open = top && sub?.index === i;
          const show = (focus: boolean) => (el: HTMLElement) => { if (!item.disabled && item.submenu.length) setSub({ index: i, anchor: el.getBoundingClientRect(), focus }); };
          return (
            <button key={i} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open} data-sub={top ? i : undefined} tabIndex={item.disabled ? -1 : 0}
              className={`menu-item has-sub ${open ? 'open' : ''} ${item.disabled ? 'disabled' : ''}`} aria-disabled={item.disabled || undefined}
              onMouseEnter={(e) => show(false)(e.currentTarget)}
              onClick={(e) => show(true)(e.currentTarget)}>
              {icons && <span className="menu-icon" aria-hidden="true">{item.icon}</span>}
              <span style={{ flex: 1 }}>{item.label}</span>
              <span className="menu-sub-arrow" aria-hidden="true">›</span>
            </button>
          );
        }
        return (
          <button key={i} type="button" role="menuitem" tabIndex={item.disabled ? -1 : 0} className={`menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`} aria-disabled={item.disabled || undefined}
            onMouseEnter={top ? () => setSub(null) : undefined}
            onClick={() => { if (item.disabled) return; close(); item.onClick(); }}>
            {icons && <span className="menu-icon" aria-hidden="true">{item.icon}</span>}
            <span style={{ flex: 1 }}>{item.color && <span className="menu-swatch" style={{ background: item.color }} aria-hidden="true" />}{item.label}</span>
            {item.hint && <span className="kbd">{item.hint}</span>}
          </button>
        );
      });
  return (
    <div className={`menu ${withIcons ? 'with-icons' : ''}`} role="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {renderItems(menu.items, true, withIcons)}
      {sub && subItems && (
        <div className={`menu submenu ${iconsIn(subItems) ? 'with-icons' : ''}`} role="menu" ref={subRef} style={{ left: subPos.x, top: subPos.y }}>
          {renderItems(subItems, false, iconsIn(subItems))}
        </div>
      )}
    </div>
  );
}
