/** The Director's actor id. Import-free leaf: every layer may depend on it without creating a cycle. */
export const DIRECTOR_ID = 'logox';

/** True for the Director, the one actor whose id is `logox`. */
export const isDirector = (ownerId: string): boolean => ownerId === DIRECTOR_ID;
