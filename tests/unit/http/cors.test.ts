import { describe, expect, it } from 'vitest';
import {
  BROWSER_MCP_CLIENT_ORIGINS,
  isAllowedOrigin,
  resolveAllowedOrigin,
} from '../../../src/http/cors.js';

describe('resolveAllowedOrigin', () => {
  it('allows the web MCP clients by exact origin', () => {
    expect(BROWSER_MCP_CLIENT_ORIGINS).toEqual([
      'https://chatgpt.com',
      'https://chat.openai.com',
      'https://claude.ai',
      'https://gemini.google.com',
      'https://copilot.microsoft.com',
      'https://www.perplexity.ai',
      'https://chat.mistral.ai',
      'https://grok.com',
    ]);
    for (const origin of BROWSER_MCP_CLIENT_ORIGINS) {
      expect(resolveAllowedOrigin(origin)).toBe(origin);
    }
    expect(resolveAllowedOrigin('https://claude.ai.evil.example')).toBeUndefined();
  });

  it('rebuilds a loopback origin on any port, with its default port spelled out', () => {
    expect(resolveAllowedOrigin('http://localhost:6274')).toBe('http://localhost:6274');
    expect(resolveAllowedOrigin('http://127.0.0.1')).toBe('http://127.0.0.1:80');
    expect(resolveAllowedOrigin('https://[::1]')).toBe('https://[::1]:443');
  });

  it.each([
    'not a url',
    'ftp://localhost',
    'http://localhost.evil.example',
    'https://evil.example',
    'null',
  ])('refuses %s', (origin) => {
    expect(resolveAllowedOrigin(origin)).toBeUndefined();
    expect(isAllowedOrigin(origin)).toBe(false);
  });

  it('answers the provider as the middleware does', () => {
    expect(isAllowedOrigin('https://claude.ai')).toBe(true);
    expect(isAllowedOrigin('http://localhost:1')).toBe(true);
  });
});
