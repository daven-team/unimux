import { Component, lazy, Suspense, useMemo, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { tr } from '../i18n';
import { PanelEmpty } from './PanelEmpty';

/** Catches a failed chunk load (or a crash while rendering the screen) so the rest of the app stays usable, and offers a retry. */
class Boundary extends Component<{ onRetry(): void; panel?: boolean; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const retry = () => { this.setState({ failed: false }); this.props.onRetry(); };
    // A side panel says it at its top, like its empty state; a screen of the main area in its middle. The panel's
    // fallback still fills the column (as the panel would), so the usage box under it stays at the bottom of the sidebar.
    if (this.props.panel) {
      return (
        <div className="sidebar-content">
          <PanelEmpty role="alert">
            <p>{tr('Nie udało się wczytać tego widoku.')}</p>
            <button className="btn primary" onClick={retry}>{tr('Spróbuj ponownie')}</button>
          </PanelEmpty>
        </div>
      );
    }
    return (
      <div className="empty" role="alert">
        <div className="welcome">
          <div className="sub">{tr('Nie udało się wczytać tego widoku.')}</div>
          <button className="btn" onClick={retry}>{tr('Spróbuj ponownie')}</button>
        </div>
      </div>
    );
  }
}

/** A screen loaded on demand. `load` must be a stable function (a module constant): a retry imports the chunk again. */
type Loader = () => Promise<{ default: ComponentType }>;
/** One lazy component per loader: a screen opened again (the Git panel) renders at once instead of showing nothing first. */
const screens = new Map<Loader, LazyExoticComponent<ComponentType>>();
/** `panel`: the screen is a side panel, so a failed load is shown like its empty state. */
export function LazyScreen({ load, panel }: { load: Loader; panel?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const Screen = useMemo(() => {
    // A retry imports the chunk again (a failed lazy component stays failed).
    let screen = attempt === 0 ? screens.get(load) : undefined;
    if (!screen) { screen = lazy(load); screens.set(load, screen); }
    return screen;
  }, [load, attempt]);
  return <Boundary panel={panel} onRetry={() => setAttempt((n) => n + 1)}><Suspense fallback={null}><Screen /></Suspense></Boundary>;
}
