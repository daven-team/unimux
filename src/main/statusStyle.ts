// TEMPORARY (1.1.2 review): MC_STATUS_STYLE=a|b|c picks one of three designs of the status indicators (the tab and project
// badges, the dot on a cell's icon, the status in the cell header). Read in unpackaged builds only and handed to the
// renderer as a command-line switch, which the preload exposes (window.mc.statusStyle). Removed once a design is picked.
import { app } from 'electron';

export function statusStyleArgs(): string[] {
  const style = app.isPackaged ? undefined : process.env.MC_STATUS_STYLE?.trim().toLowerCase();
  return style && /^[abc]$/.test(style) ? [`--mc-status-style=${style}`] : [];
}
