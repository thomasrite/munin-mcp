import { describe, expect, it } from 'vitest';
import {
  arr,
  bool,
  connectorBinding,
  date,
  entityType,
  num,
  obj,
  queryTemplate,
  relationshipType,
  role,
  str,
} from './config-helpers';

describe('primitive JSON Schema helpers', () => {
  it('str() produces a minimal string schema', () => {
    expect(str()).toEqual({ type: 'string' });
  });

  it('str() carries through description, format, enum', () => {
    expect(str({ description: 'an email', format: 'email' })).toEqual({
      type: 'string',
      description: 'an email',
      format: 'email',
    });
  });

  it('str() drops undefined fields so they do not pollute hashes', () => {
    // Build opts via a typed local so we can pass an undefined value through
    // exactOptionalPropertyTypes without violating the str() signature.
    const opts: { description?: string; format?: 'email' } = { format: 'email' };
    const s = str(opts);
    expect(s).toEqual({ type: 'string', format: 'email' });
    expect('description' in s).toBe(false);
  });

  it('num() supports integer and bounds', () => {
    expect(num({ integer: true, minimum: 0, maximum: 100 })).toEqual({
      type: 'number',
      integer: true,
      minimum: 0,
      maximum: 100,
    });
  });

  it('bool() produces a minimal boolean schema', () => {
    expect(bool()).toEqual({ type: 'boolean' });
  });

  it('date() produces a string schema with date format', () => {
    expect(date()).toEqual({ type: 'string', format: 'date' });
  });

  it('arr() wraps an item schema', () => {
    expect(arr(str())).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('obj() defaults required to []', () => {
    expect(obj({ name: str() })).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: [],
    });
  });

  it('obj() carries explicit required list', () => {
    const o = obj({ a: str(), b: num() }, { required: ['a'] });
    expect(o.required).toEqual(['a']);
  });
});

describe('entityType()', () => {
  it('produces a definition with object property schema', () => {
    const t = entityType({
      name: 'Project',
      description: 'A unit of work with a goal.',
      properties: { name: str(), status: str({ enum: ['planning', 'active', 'done'] }) },
      required: ['name'],
      fewShots: [],
    });
    expect(t.name).toBe('Project');
    expect(t.propertySchema.type).toBe('object');
    expect(t.propertySchema.required).toEqual(['name']);
    expect(t.propertySchema.properties.name).toEqual({ type: 'string' });
  });
});

describe('relationshipType()', () => {
  it('omits propertySchema when no properties supplied', () => {
    const r = relationshipType({
      name: 'belongsToProject',
      description: 'A Task belongs to a Project.',
      fromTypes: ['Task'],
      toTypes: ['Project'],
    });
    expect(r.propertySchema).toBeUndefined();
    expect(r.fewShots).toBeUndefined();
  });

  it('includes propertySchema when properties supplied', () => {
    const r = relationshipType({
      name: 'worksOn',
      description: 'A Person works on a Project.',
      fromTypes: ['Person'],
      toTypes: ['Project'],
      properties: { since: date() },
    });
    expect(r.propertySchema?.type).toBe('object');
    expect(r.propertySchema?.properties.since).toEqual({ type: 'string', format: 'date' });
  });
});

describe('role(), queryTemplate(), connectorBinding()', () => {
  it('role() echoes the input', () => {
    expect(role({ name: 'admin', description: 'Admin', baseTags: ['t1'] })).toEqual({
      name: 'admin',
      description: 'Admin',
      baseTags: ['t1'],
    });
  });

  it('queryTemplate() preserves slots and expansion', () => {
    const q = queryTemplate({
      id: 'tasksFor',
      title: 'Tasks for project',
      description: 'List tasks for a project',
      slots: { project: { kind: 'entityRef', required: true, entityTypes: ['Project'] } },
      expansion: {
        startSlot: 'project',
        traverse: [{ edgeTypes: ['belongsToProject'], direction: 'in', maxDepth: 1 }],
      },
    });
    expect(q.id).toBe('tasksFor');
    expect(q.expansion.startSlot).toBe('project');
  });

  it('connectorBinding() preserves package and per-tenant schema', () => {
    const c = connectorBinding({
      packageName: '@muninhq/connector-filesystem',
      description: 'Reads files from a local directory',
      perTenantConfigSchema: obj({ rootPath: str() }, { required: ['rootPath'] }),
    });
    expect(c.packageName).toBe('@muninhq/connector-filesystem');
    expect(c.perTenantConfigSchema.required).toEqual(['rootPath']);
  });
});
