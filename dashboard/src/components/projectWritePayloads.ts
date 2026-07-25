import type { Project } from '../lib/api';

export interface ProjectFormValues {
  name: string;
  path: string;
  description: string;
  defaultWebUrl: string;
  sessionPrompt: string;
  openclawPrompt: string;
  color: string;
}

export function buildProjectCreatePayload(values: ProjectFormValues) {
  return {
    name: values.name,
    path: values.path,
    description: values.description,
    session_prompt: values.sessionPrompt,
    openclaw_prompt: values.openclawPrompt,
    default_web_url: values.defaultWebUrl || undefined,
    color: values.color || '',
  };
}

export function buildProjectUpdatePayload(project: Project, values: ProjectFormValues) {
  const fields: {
    name?: string;
    path?: string;
    description?: string;
    session_prompt?: string | null;
    openclaw_prompt?: string | null;
    default_web_url?: string | null;
    color?: string;
  } = {};

  if (values.name !== project.name) fields.name = values.name;
  if (values.description !== (project.description || '')) fields.description = values.description;
  if (values.defaultWebUrl !== (project.default_web_url || '')) {
    fields.default_web_url = values.defaultWebUrl || null;
  }
  if (values.sessionPrompt !== (project.session_prompt || '')) {
    fields.session_prompt = values.sessionPrompt || null;
  }
  if (values.openclawPrompt !== (project.openclaw_prompt || '')) {
    fields.openclaw_prompt = values.openclawPrompt || null;
  }
  // Always send color so a color-only edit still saves.
  fields.color = values.color || '';

  return fields;
}
