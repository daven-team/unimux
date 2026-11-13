// The menu bar of the title bar, right after the logo (like VS Code or a Windows app): File, Edit, View. The menus are the
// app's context menus (ContextMenu.tsx); their items come from appMenu.ts. A press opens a menu without taking the keyboard
// from the editor, field or terminal that has it, so the Edit items act on that place. While one menu is open, pointing at
// another title opens it, and Left / Right move between them.
import { useRef } from 'react';
import { useI18n } from '../i18n';
import { closeMenu, menuOwner, openMenuAt, useMenuOwner } from './ContextMenu';
import { MENU_IDS, menuItems, menuTitle, rememberFocus, type MenuId } from '../appMenu';

const OWNER = 'menubar:';

export function MenuBar() {
  const { tr } = useI18n(); // the titles follow the language
  const owner = useMenuOwner();
  const open = owner?.startsWith(OWNER) ? (owner.slice(OWNER.length) as MenuId) : null;
  const buttons = useRef<Partial<Record<MenuId, HTMLButtonElement | null>>>({});
  const show = (id: MenuId) => {
    const el = buttons.current[id];
    if (!el) return;
    const side = (dir: -1 | 1) => show(MENU_IDS[(MENU_IDS.indexOf(id) + dir + MENU_IDS.length) % MENU_IDS.length]);
    openMenuAt(el, menuItems(id), { owner: OWNER + id, onSide: side });
  };
  return (
    <div className="menubar no-drag" role="menubar" aria-label={tr('Menu aplikacji')} data-menubar="">
      {MENU_IDS.map((id) => (
        <button
          key={id}
          ref={(el) => { buttons.current[id] = el; }}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === id}
          className={`menubar-item ${open === id ? 'open' : ''}`}
          data-menu={id}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault(); // the keyboard stays where it is (the Edit items act there)
            if (!menuOwner()?.startsWith(OWNER)) rememberFocus();
            if (open === id) closeMenu();
            else show(id);
          }}
          onMouseEnter={() => { if (open && open !== id) show(id); }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            show(id);
          }}
        >
          {menuTitle(id)}
        </button>
      ))}
    </div>
  );
}
