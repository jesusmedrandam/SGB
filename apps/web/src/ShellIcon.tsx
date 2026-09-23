import type { ReactNode } from 'react';

export type ShellIconName = 'home'|'animals'|'groups'|'reproduction'|'production'|'movements'|'health'|'cleanings'|'catalogs'|
  'team'|'settings'|'admin'|'menu'|'close'|'moon'|'sun'|'logout'|'chevron';

const shapes: Record<ShellIconName, ReactNode> = {
  home: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  animals: <><path d="M4 9 2 5l5 2 3-2h4l3 2 5-2-2 4v8l-4 4-4-2-4 2-4-4V9Z"/><path d="M8 12h.01M16 12h.01M10 16h4"/></>,
  groups: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2H3ZM17 5a3 3 0 0 1 0 6m0 3a5 5 0 0 1 4 5v1h-3"/></>,
  reproduction: <><path d="M12 21s-9-5.5-9-12a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.5-9 12-9 12Z"/></>,
  production: <><path d="M12 2C10 6 5 10.5 5 15a7 7 0 0 0 14 0c0-4.5-5-9-7-13Z"/><path d="M9 16a3 3 0 0 0 3 3"/></>,
  movements: <><path d="m7 7-4 4 4 4M3 11h17m-3-4 4 4-4 4M21 11v7a2 2 0 0 1-2 2H5"/></>,
  health: <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z"/>,
  cleanings: <><path d="M3 19h18M6 19l2-11h8l2 11M9 8V4h6v4M10 13h4"/></>,
  catalogs: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></>,
  team: <><circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2"/><path d="M2 20v-2a6 6 0 0 1 12 0v2H2Zm13-6a4 4 0 0 1 7 3v3h-5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M10 2h4l.5 2.3 2 1.2 2.3-.7 2 3.4-1.7 1.7v2.2l1.7 1.7-2 3.4-2.3-.7-2 1.2L14 22h-4l-.5-2.3-2-1.2-2.3.7-2-3.4 1.7-1.7v-2.2L3.2 10l2-3.4 2.3.7 2-1.2L10 2Z"/></>,
  admin: <><path d="M12 2 4 5v6c0 5 3.2 8.7 8 11 4.8-2.3 8-6 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-4"/></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
  close: <path d="M5 5 19 19M19 5 5 19"/>,
  moon: <path d="M20 15.7A8 8 0 0 1 8.3 4 8 8 0 1 0 20 15.7Z"/>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  logout: <><path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4m5-4 4-4-4-4m4 4H9"/></>,
  chevron: <path d="m9 18 6-6-6-6"/>,
};

export function ShellIcon({name,size=19}:{name:ShellIconName;size?:number}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">{shapes[name]}</svg>;
}
