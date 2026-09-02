/**
 * A seven-segment display field.
 *
 * A real instrument does not hide its unlit segments — the field is
 * physically there, dark, waiting. So the backdrop renders every segment
 * off (`8888.88`) at 8.5% white, and the lit value sits exactly on top
 * of it. With no reading loaded the field is therefore PRESENT rather
 * than absent, and when a value arrives nothing reflows, because the
 * geometry was already occupied.
 *
 * The lit value is the brightest thing on its screen (data band, 97%),
 * or the accent when it is recovered value — the one figure the accent
 * exists for.
 */
import { cn } from '../../lib/cn';
import { Fig } from './Fig';
import { Scramble } from './Scramble';

export function UnlitField({
  /** Digits+separators the field is sized for, all segments on. */
  mask,
  /** The lit reading, or null for an unlit field. */
  value = null,
  accent = false,
  className,
}: {
  mask: string;
  value?: string | null;
  accent?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <span className={cn('relative inline-block', className)}>
      {/* Unlit segments. aria-hidden: it is the physical field, not a
          value, and a screen reader announcing "8888.88" would be a lie. */}
      <Fig aria-hidden className="block text-exhibit font-medium leading-none text-unlit">
        {mask}
      </Fig>
      <span className="absolute inset-0 flex items-center">
        {value === null ? null : (
          <Scramble
            onMount
            value={value}
            className={cn('text-exhibit font-medium leading-none', accent ? 'text-accent' : 'text-fg-data')}
          />
        )}
      </span>
    </span>
  );
}
