/**
 * A screen's opening statement, in the console's own voice: what this
 * evidence is and what it can and cannot support. Deliberately a claim,
 * not a description — a forensic console states the standing of what it
 * is about to show you before it shows you anything.
 */
import type { ReactNode } from 'react';

export function ScreenHead({
  title,
  standing,
  right,
}: {
  title: string;
  standing: ReactNode;
  right?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-chrome px-4 py-3.5">
      <div className="flex min-w-0 flex-col gap-1.5">
        {/* The display face, not the mono. Mono is reserved for figures,
            ids and hashes; a screen title set in it wastes the one place
            the typographic voice is most visible. */}
        <h1 className="text-xl font-bold uppercase tracking-[0.02em] text-fg-data">{title}</h1>
        <p className="max-w-3xl text-xs leading-relaxed text-fg-label">{standing}</p>
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}
