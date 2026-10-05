/**
 * Mechanical half of the "tool schemas: never weakened" rule (AGENTS.md): lists
 * what `candidate` stopped promising compared with `reference`. Reworded
 * descriptions are not judged here; the exact fixture diff is where a reviewer
 * reads them.
 */

type JsonSchema = Record<string, unknown>;

const LOWER_BOUNDS = ['minimum', 'minLength', 'minItems'] as const;
const UPPER_BOUNDS = ['maximum', 'maxLength', 'maxItems'] as const;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function typeNarrowed(reference: unknown, candidate: unknown): boolean {
  return reference === candidate || (reference === 'number' && candidate === 'integer');
}

export function schemaWeakenings(
  reference: JsonSchema,
  candidate: JsonSchema,
  path = '$',
): string[] {
  const found: string[] = [];

  if (reference.type !== undefined && !typeNarrowed(reference.type, candidate.type)) {
    found.push(`${path}: type ${String(reference.type)} became ${String(candidate.type)}`);
  }
  if (reference.description && !candidate.description) {
    found.push(`${path}: description dropped`);
  }

  if (Array.isArray(reference.enum)) {
    if (Array.isArray(candidate.enum)) {
      const allowed = asStrings(reference.enum);
      for (const value of asStrings(candidate.enum)) {
        if (!allowed.includes(value)) found.push(`${path}: enum widened with ${value}`);
      }
    } else {
      found.push(`${path}: enum dropped`);
    }
  }

  for (const key of LOWER_BOUNDS) {
    const bound = reference[key];
    const next = candidate[key];
    if (typeof bound === 'number' && !(typeof next === 'number' && next >= bound)) {
      found.push(`${path}: ${key} ${bound} loosened`);
    }
  }
  for (const key of UPPER_BOUNDS) {
    const bound = reference[key];
    const next = candidate[key];
    if (typeof bound === 'number' && !(typeof next === 'number' && next <= bound)) {
      found.push(`${path}: ${key} ${bound} loosened`);
    }
  }

  const required = asStrings(candidate.required);
  for (const name of asStrings(reference.required)) {
    if (!required.includes(name)) found.push(`${path}: ${name} no longer required`);
  }

  // Both directions break someone: opening a closed object lets typos through
  // silently, closing an open one rejects the free-form fields agents send.
  if (reference.additionalProperties === false && candidate.additionalProperties !== false) {
    found.push(`${path}: additionalProperties opened`);
  }
  if (reference.additionalProperties !== false && candidate.additionalProperties === false) {
    found.push(`${path}: additionalProperties closed`);
  }

  const properties = isSchema(candidate.properties) ? candidate.properties : {};
  if (isSchema(reference.properties)) {
    for (const [name, schema] of Object.entries(reference.properties)) {
      const next = properties[name];
      if (!isSchema(next)) {
        found.push(`${path}.${name}: property dropped`);
      } else if (isSchema(schema)) {
        found.push(...schemaWeakenings(schema, next, `${path}.${name}`));
      }
    }
  }

  if (isSchema(reference.items)) {
    if (isSchema(candidate.items)) {
      found.push(...schemaWeakenings(reference.items, candidate.items, `${path}[]`));
    } else {
      found.push(`${path}: items dropped`);
    }
  }

  return found;
}
