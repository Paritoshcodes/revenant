import { POLICY_GRID } from '@revenant/contracts';

/**
 * Shell only. The three evidence layers get their own panels later, and
 * every recovery figure carries its OBSERVED or ESTIMATED label. Nothing
 * here merges them.
 */
export const App = (): JSX.Element => (
  <main>
    <h1>Revenant</h1>
    <p>Scaffold. Policy grid loaded with {POLICY_GRID.length} rows.</p>
  </main>
);
