import { describe, it, expect } from 'vitest';
import { parseHtml } from './parser.js';
import type { Source } from './sources.js';

const source: Source = {
  id: 'acme:pricing',
  competitor: 'acme',
  url: 'https://acme.example.com/pricing',
  type: 'pricing',
};

function parse(html: string) {
  return parseHtml(html, source, new Date(0));
}

describe('parseHtml', () => {
  it('extracts title and whitespace-collapsed text', () => {
    const r = parse('<title>Acme</title><body><h1>Plans</h1>\n\n  Pro   tier</body>');
    expect(r.title).toBe('Acme');
    expect(r.text).toContain('Pro tier');
  });

  it('strips script/style noise from extracted text', () => {
    const r = parse('<body>real<script>evil()</script><style>.x{}</style></body>');
    expect(r.text).toBe('real');
  });

  it('keeps http(s) links, resolving relative URLs against the source', () => {
    const r = parse(
      '<body><a href="/plans">a</a><a href="https://other.example.com/x">b</a></body>',
    );
    expect(r.links).toContain('https://acme.example.com/plans');
    expect(r.links).toContain('https://other.example.com/x');
  });

  it('drops non-http(s) link schemes (allowlist, not a javascript: blocklist)', () => {
    const r = parse(
      [
        '<a href="javascript:alert(1)">x</a>',
        '<a href="JavaScript:alert(1)">x</a>', // mixed case
        '<a href="  javascript:alert(1)">x</a>', // leading whitespace
        '<a href="data:text/html,<script>evil</script>">x</a>',
        '<a href="vbscript:msgbox(1)">x</a>',
        '<a href="https://ok.example.com/keep">ok</a>',
      ].join(''),
    );
    expect(r.links).toEqual(['https://ok.example.com/keep']);
  });

  it('dedupes repeated links', () => {
    const r = parse('<body><a href="/p">1</a><a href="/p">2</a></body>');
    expect(r.links).toEqual(['https://acme.example.com/p']);
  });
});
