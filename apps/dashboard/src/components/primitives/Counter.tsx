/**
 * A figure that counts into place. Used by the instrument check, where
 * the count reveals PROVENANCE: the value is being read off something,
 * not printed as decoration.
 *
 * `active` gates the count so the boot sequence can hold a line at its
 * start value until its own turn arrives.
 */
import { useCountUp } from '../../lib/motion';
import { Fig } from './Fig';

export function Counter({
  value,
  format,
  active = true,
  durationMs,
  className,
}: {
  value: number;
  format: (n: number) => string;
  active?: boolean;
  durationMs?: number;
  className?: string;
}): JSX.Element {
  const shown = useCountUp(value, { active, durationMs });
  return <Fig className={className}>{format(shown)}</Fig>;
}
