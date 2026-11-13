import type { Project } from '../../../shared/types';

/** The editor and every project list use the same icon, including its color treatment. */
export function ProjectIconView({ project, size = 'md' }: { project: Pick<Project, 'name' | 'color' | 'icon'>; size?: 'sm' | 'md' | 'xl' }) {
  const icon = project.icon;
  const cls = `picon ${size}`;
  if (icon?.kind === 'image') return <span className={cls}><img src={icon.dataUrl} alt="" draggable={false} /></span>;
  if (icon?.kind === 'emoji') return <span className={cls} style={{ background: project.color + '2e' }}>{icon.value}</span>;
  return (
    <span className={`${cls} letter`} style={{ background: project.color + '2e', color: project.color }}>
      {project.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
