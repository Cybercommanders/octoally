interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}

interface SqliteLikeDb {
  prepare(sql: string): SqliteStatement;
}

export type ProjectPromptColumn = 'session_prompt' | 'ruflo_prompt';

export function getProjectColumnNames(db: SqliteLikeDb): Set<string> {
  const columns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

export function getProjectPromptColumn(db: SqliteLikeDb): ProjectPromptColumn {
  const columns = getProjectColumnNames(db);
  if (columns.has('session_prompt')) return 'session_prompt';
  if (columns.has('ruflo_prompt')) return 'ruflo_prompt';
  throw new Error('projects table is missing session_prompt/ruflo_prompt column');
}

export function withProjectPromptAliases<T extends Record<string, unknown>>(project: T): T {
  if ('session_prompt' in project && !('ruflo_prompt' in project)) {
    return { ...project, ruflo_prompt: project.session_prompt };
  }
  if ('ruflo_prompt' in project && !('session_prompt' in project)) {
    return { ...project, session_prompt: project.ruflo_prompt };
  }
  return project;
}
