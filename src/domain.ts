/**
 * Shared domain types. Owned here, imported everywhere.
 *
 * The structural shape of these is dead-simple, but centralizing the
 * declaration prevents drift — if `Repo` ever gains a third field (e.g. host
 * for GitHub Enterprise), every consumer picks it up.
 */

export type Repo = { org: string; name: string };

export type Duration = { days: number };

export type SortKey = 'merged' | 'typical' | 'average' | 'tail' | 'accept';

export type Format = 'plain' | 'json' | 'csv';
