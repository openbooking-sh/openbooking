import { describe, expect, it } from 'vitest';
import { buildAgentCard, createA2AStub } from '../src';

describe('A2A Agent Card', () => {
  it('contains every v1.0 required field and no removed v0.3 fields', () => {
    const card = buildAgentCard({
      name: 'Demo Bistro',
      description: 'Book a table',
      baseUrl: 'https://bistro.example/',
      mcpUrl: 'https://bistro.example/mcp',
    });
    for (const field of [
      'name',
      'description',
      'supportedInterfaces',
      'version',
      'capabilities',
      'defaultInputModes',
      'defaultOutputModes',
      'skills',
    ]) {
      expect(card).toHaveProperty(field);
    }
    expect(card.supportedInterfaces[0]).toEqual({
      url: 'https://bistro.example/a2a',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    });
    for (const removed of [
      'url',
      'protocolVersion',
      'preferredTransport',
      'additionalInterfaces',
    ]) {
      expect(card).not.toHaveProperty(removed);
    }
    for (const skill of card.skills) {
      expect(skill.id && skill.name && skill.description && skill.tags.length).toBeTruthy();
    }
  });

  it('stub answers with a JSON-RPC error', async () => {
    const res = await createA2AStub({} as never).fetch(
      new Request('http://x/a2a', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'SendMessage' }),
      }),
    );
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ id: 7, error: { code: -32601 } });
  });
});
