// The kind of a database connection as its logo-like glyph (16px, drawn for the 16px box): the Postgres elephant and the Redis
// stack. Used by the connection rows of the "Bazy danych" panel and the database tabs of the strip.
import type { DbKind } from '../../../../shared/db';
import './dbKindIcon.css';

function PostgresIcon() {
  return (
    <svg className="db-kind-icon postgres" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle fill="#336791" cx="7.5" cy="6.8" r="5.3" />
      <path fill="none" stroke="#336791" strokeWidth="2.2" strokeLinecap="round" d="M11.3 8.8c1 1.4.6 3.4 1.3 4.6.4.7 1.2.8 1.9.2" />
      <path fill="#7ea6cf" d="M3.3 4.9c1.1-1.4 3.2-1.5 4-.2.9 1.4.6 4.6-.6 5.9-1 1.1-2.6.6-3.3-.8-.6-1.4-.8-3.6-.1-4.9Z" />
      <circle fill="#fff" cx="10.3" cy="5.3" r=".85" />
      <path fill="none" stroke="#fff" strokeWidth=".9" strokeLinecap="round" d="M10.4 10.2c.4.6 1 .9 1.6.8" />
    </svg>
  );
}

function RedisIcon() {
  return (
    <svg className="db-kind-icon redis" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="#a41e11" d="M1.5 9.4 8 12.4l6.5-3V11L8 14l-6.5-3Z" />
      <path fill="#c6302b" d="M1.5 6.2 8 9.2l6.5-3v1.6L8 10.8 1.5 7.8Z" />
      <path fill="#dc382d" d="M8 1l6.5 3L8 7 1.5 4Z" />
      <path fill="#fff" d="M8 3.1 9.3 4 8 4.9 6.7 4Z" />
    </svg>
  );
}

export function DbKindIcon({ kind }: { kind: DbKind }) {
  return kind === 'postgres' ? <PostgresIcon /> : <RedisIcon />;
}
