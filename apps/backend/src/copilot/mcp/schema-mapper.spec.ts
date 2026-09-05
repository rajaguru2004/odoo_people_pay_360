import { isConfirmationRequired, isLocalEndpoint, parseMcpResult, toOpenAiTools } from './schema-mapper';

describe('schema-mapper', () => {
  it('maps MCP tools to OpenAI function defs', () => {
    const out = toOpenAiTools([
      {
        name: 'employee_list',
        description: 'List employees',
        inputSchema: { $schema: 'x', type: 'object', properties: { search: { type: 'string' } } },
      },
      { name: 'bare_tool' },
    ]);
    expect(out[0]).toEqual({
      type: 'function',
      function: {
        name: 'employee_list',
        description: 'List employees',
        parameters: { type: 'object', properties: { search: { type: 'string' } } },
      },
    });
    expect(out[1].function.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('parses text content JSON', () => {
    expect(
      parseMcpResult({ content: [{ type: 'text', text: '{"data":[1,2]}' }] }),
    ).toEqual({ data: [1, 2] });
  });

  it('prefers structuredContent', () => {
    expect(
      parseMcpResult({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{}' }] }),
    ).toEqual({ a: 1 });
  });

  it('wraps non-JSON text and surfaces errors', () => {
    expect(parseMcpResult({ content: [{ type: 'text', text: 'plain' }] })).toEqual({ text: 'plain' });
    expect(parseMcpResult({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toEqual({
      error: 'boom',
    });
    expect(parseMcpResult(null)).toEqual({ error: 'Empty tool result' });
  });

  it('strict mode strips grammar-hostile keywords but keeps type/enum/description/required', () => {
    const [def] = toOpenAiTools(
      [
      {
        name: 'leave_create',
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid', pattern: '^[0-9a-f-]+$', minLength: 36 },
            leaveType: { type: 'string', enum: ['ANNUAL', 'SICK'], description: 'Type' },
            days: { type: 'number', minimum: 1, maximum: 30, default: 1 },
          },
          additionalProperties: false,
        },
      },
      ],
      true,
    );
    const p = def.function.parameters;
    expect(p.required).toEqual(['id']);
    expect(p.additionalProperties).toBeUndefined();
    expect(p.properties.id).toEqual({ type: 'string' }); // format/pattern/minLength gone
    expect(p.properties.leaveType).toEqual({ type: 'string', enum: ['ANNUAL', 'SICK'], description: 'Type' });
    expect(p.properties.days).toEqual({ type: 'number' }); // minimum/maximum/default gone
  });

  it('strict mode collapses nullable/union schemas to a concrete type', () => {
    const [def] = toOpenAiTools(
      [
        {
          name: 't',
          inputSchema: {
            type: 'object',
            properties: {
              a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              b: { type: ['integer', 'null'] },
              c: { type: 'array', items: { type: 'string', format: 'uuid' } },
            },
          },
        },
      ],
      true,
    );
    const p = def.function.parameters;
    expect(p.properties.a.type).toBe('string');
    expect(p.properties.a.anyOf).toBeUndefined();
    expect(p.properties.b.type).toBe('integer');
    expect(p.properties.c.items).toEqual({ type: 'string' });
  });

  it('light mode (default, API providers) preserves format/enum hints', () => {
    const [def] = toOpenAiTools([
      {
        name: 'x',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    ]);
    expect(def.function.parameters.$schema).toBeUndefined();
    expect(def.function.parameters.properties.id).toEqual({ type: 'string', format: 'uuid' });
  });

  it('isLocalEndpoint detects private/loopback hosts', () => {
    for (const u of [
      'http://localhost:1234/v1',
      'http://127.0.0.1:1234/v1',
      'http://10.254.64.38:1234/v1',
      'http://192.168.0.151:1234/v1',
      'http://172.16.0.5:1234/v1',
      'http://my-box.local/v1',
    ]) {
      expect(isLocalEndpoint(u)).toBe(true);
    }
    for (const u of ['https://openrouter.ai/api/v1', 'https://api.openai.com/v1', 'http://172.15.0.1/v1']) {
      expect(isLocalEndpoint(u)).toBe(false);
    }
  });

  it('detects confirmation envelopes', () => {
    expect(isConfirmationRequired({ requiresConfirmation: true })).toBe(true);
    expect(isConfirmationRequired({ requiresConfirmation: false })).toBe(false);
    expect(isConfirmationRequired({ data: [] })).toBe(false);
    expect(isConfirmationRequired(null)).toBe(false);
  });
});
