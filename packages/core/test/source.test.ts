import { describe, expect, it } from 'vitest';
import { agentGroup, coarseSource, sourceFromActor, userAgentFamily } from '../src';

describe('agentGroup', () => {
  it.each([
    ['ChatGPT-User/1.0', 'ChatGPT'],
    ['openai-mcp', 'ChatGPT'],
    ['gemini-agent', 'Gemini'],
    ['agent.google.com', 'Google'],
    ['claude-ai', 'Claude'],
    ['PerplexityBot', 'Perplexity'],
    ['my-own-agent', 'Other'],
  ])('%s is %s', (raw, group) => {
    expect(agentGroup(raw)).toBe(group);
  });

  it('has no group for no name', () => {
    expect(agentGroup(undefined)).toBeUndefined();
    expect(agentGroup('')).toBeUndefined();
  });
});

describe('userAgentFamily', () => {
  it('names browsers, not the engines they pretend to be', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    expect(userAgentFamily(chrome)).toBe('Chrome');
    expect(userAgentFamily(`${chrome} Edg/130.0`)).toBe('Edge');
    expect(userAgentFamily('Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/18 Safari/605')).toBe(
      'Safari',
    );
    expect(userAgentFamily('Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/131.0')).toBe(
      'Firefox',
    );
  });

  it('prefers an assistant that announces itself', () => {
    expect(userAgentFamily('Mozilla/5.0 AppleWebKit/537.36 ChatGPT-User/1.0')).toBe('ChatGPT');
    expect(userAgentFamily('curl/8.4.0')).toBe('curl');
    expect(userAgentFamily(null)).toBeUndefined();
  });
});

describe('sourceFromActor', () => {
  it('maps each protocol to its channel and keeps the reported name', () => {
    expect(sourceFromActor({ protocol: 'mcp', agent: 'Claude', client: 'claude-ai' })).toEqual({
      channel: 'mcp',
      agent: 'claude-ai',
    });
    expect(sourceFromActor({ protocol: 'ucp', agent: 'x', client: 'agent.google.com' })).toEqual({
      channel: 'ucp',
      agent: 'agent.google.com',
    });
    expect(sourceFromActor({ protocol: 'a2a', agent: 'x' })).toEqual({ channel: 'a2a' });
    expect(sourceFromActor({ protocol: 'usp', agent: 'x' })).toEqual({ channel: 'usp' });
    expect(sourceFromActor({ protocol: 'web', agent: 'Booking page', client: 'Chrome' })).toEqual({
      channel: 'website',
      agent: 'Chrome',
    });
  });

  it('trims a User-Agent down to the client name, and caps the length', () => {
    expect(
      sourceFromActor({
        protocol: 'mcp',
        agent: 'x',
        client: 'Claude-User/1.0 (+https://claude.ai)',
      }),
    ).toEqual({ channel: 'mcp', agent: 'Claude-User' });
    expect(
      sourceFromActor({ protocol: 'mcp', agent: 'x', client: 'a'.repeat(300) })!.agent,
    ).toHaveLength(80);
  });

  it('lets staff pick phone or walk-in, and never reports an assistant for them', () => {
    expect(
      sourceFromActor({ protocol: 'studio', agent: 'Studio', channel: 'walk_in', client: 'q' }),
    ).toEqual({ channel: 'walk_in' });
    expect(sourceFromActor({ protocol: 'studio', agent: 'Studio' })).toEqual({ channel: 'other' });
  });

  it('is unknown without an actor', () => {
    expect(sourceFromActor(undefined)).toBeUndefined();
    expect(coarseSource(undefined)).toEqual({ channel: 'unknown', agent_group: null });
  });

  it('gives analytics only the channel and a coarse group', () => {
    expect(coarseSource({ channel: 'mcp', agent: 'claude-ai-2.3.1' })).toEqual({
      channel: 'mcp',
      agent_group: 'Claude',
    });
    expect(coarseSource({ channel: 'mcp', agent: 'weird-client' }).agent_group).toBe('Other');
  });
});
