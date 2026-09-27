import type { Schemas } from '../api';

type Highlight = Schemas['Highlight'];

const ICON: Record<Highlight['kind'], string> = {
  military: '✪',
  rare_type: '★',
  foreign_operator: '⚑',
  foreign_aircraft: '⚑',
};

/** Badges for what makes a plane interesting; nothing for an ordinary one. */
export function Highlights({ items }: { items: Highlight[] }) {
  if (items.length === 0) return null;
  return (
    <div className="highlights">
      {items.map((h) => (
        <span key={h.kind} className={`badge hl ${h.kind}`}>
          {ICON[h.kind]} {h.label}
        </span>
      ))}
    </div>
  );
}
