import { describe, expect, it } from 'vitest';
import { isCrawlCandidate, rankCandidates, scoreUrl } from '../src/onboarding/scoring';
import { isSitemapIndex, parseRobots, parseSitemapLocations } from '../src/onboarding/crawler';
import { parseJsonObject, sanitizeHours, sanitizeText } from '../src/onboarding/extract';

describe('scoring', () => {
  const url = (path: string) => new URL(path, 'https://shop.example.com');

  it('ranks institutional pages highly in Spanish and English', () => {
    for (const path of ['/envios', '/shipping', '/medios-de-pago', '/payment', '/devoluciones', '/returns', '/preguntas-frecuentes', '/faq']) {
      expect(scoreUrl(url(path)), path).toBeGreaterThan(50);
    }
  });

  it('always keeps the home page', () => {
    expect(scoreUrl(url('/'))).toBeGreaterThan(0);
  });

  it('excludes catalog and account routes outright', () => {
    // These duplicate the live WooCommerce API or are per-session noise.
    for (const path of [
      '/producto/remera-azul',
      '/product/blue-shirt',
      '/tienda',
      '/shop',
      '/categoria/ofertas',
      '/product-category/sale',
      '/carrito',
      '/checkout',
      '/mi-cuenta',
      '/my-account',
      '/wp-admin/index.php',
    ]) {
      expect(isCrawlCandidate(url(path)), path).toBe(false);
    }
  });

  it('excludes non-HTML resources', () => {
    for (const path of ['/logo.png', '/theme.css', '/app.js', '/catalog.pdf', '/feed.xml']) {
      expect(isCrawlCandidate(url(path)), path).toBe(false);
    }
  });

  it('scores anchor text, not just the slug', () => {
    expect(scoreUrl(url('/p/17'), 'Cómo son los envíos')).toBeGreaterThan(scoreUrl(url('/p/17')));
  });

  it('matches accented Spanish, which is how link text is actually written', () => {
    expect(scoreUrl(url('/p/17'), 'Envíos')).toBeGreaterThan(0);
    expect(scoreUrl(url('/p/17'), 'Garantía')).toBeGreaterThan(0);
    expect(scoreUrl(url('/devoluciones-y-cambios'))).toBeGreaterThan(50);
  });

  it('prefers shallow canonical pages over deep articles', () => {
    expect(scoreUrl(url('/envios'))).toBeGreaterThan(scoreUrl(url('/blog/notas/2019/envios-a-todo-el-pais')));
  });

  it('keeps one entry per path and respects the limit', () => {
    const ranked = rankCandidates(
      [
        { url: 'https://shop.example.com/envios' },
        { url: 'https://shop.example.com/envios/' },
        { url: 'https://shop.example.com/pagos' },
        { url: 'https://shop.example.com/producto/x' },
      ],
      2,
    );
    expect(ranked).toHaveLength(2);
    expect(ranked.every((entry) => !entry.url.includes('/producto/'))).toBe(true);
  });
});

describe('robots.txt', () => {
  it('applies only the catch-all group', () => {
    const policy = parseRobots(['User-agent: Googlebot', 'Disallow: /solo-google', 'User-agent: *', 'Disallow: /privado'].join('\n'));
    expect(policy.disallow).toHaveLength(1);
    expect(policy.disallow[0]!.test('/privado/x')).toBe(true);
    expect(policy.disallow[0]!.test('/solo-google')).toBe(false);
  });

  it('collects declared sitemaps', () => {
    const policy = parseRobots('Sitemap: https://shop.example.com/sitemap_index.xml\nUser-agent: *\nDisallow:');
    expect(policy.sitemaps).toEqual(['https://shop.example.com/sitemap_index.xml']);
  });

  it('ignores comments and malformed lines', () => {
    const policy = parseRobots('# a comment\nnot-a-directive\nUser-agent: *\nDisallow: /x # trailing');
    expect(policy.disallow).toHaveLength(1);
  });

  it('honours wildcards', () => {
    const policy = parseRobots('User-agent: *\nDisallow: /wp-*/admin');
    expect(policy.disallow[0]!.test('/wp-content/admin')).toBe(true);
  });
});

describe('sitemaps', () => {
  it('extracts locations and detects an index', () => {
    const xml =
      '<sitemapindex><sitemap><loc>https://shop.example.com/page-sitemap.xml</loc></sitemap></sitemapindex>';
    expect(isSitemapIndex(xml)).toBe(true);
    expect(parseSitemapLocations(xml)).toEqual(['https://shop.example.com/page-sitemap.xml']);
  });

  it('reads a plain urlset', () => {
    const xml = '<urlset><url><loc>https://shop.example.com/envios</loc></url></urlset>';
    expect(isSitemapIndex(xml)).toBe(false);
    expect(parseSitemapLocations(xml)).toEqual(['https://shop.example.com/envios']);
  });
});

describe('proposal sanitization', () => {
  it('recovers JSON from a fenced or chatty reply', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Sure! {"a":2} Hope that helps.')).toEqual({ a: 2 });
    expect(parseJsonObject('no json here')).toBeNull();
  });

  it('caps length and normalizes whitespace', () => {
    expect(sanitizeText(`${'a'.repeat(50)}`, 10)).toHaveLength(10);
    expect(sanitizeText('a  \t b\n\n\n\nc', 100)).toBe('a b\n\nc');
    expect(sanitizeText('   ', 100)).toBeNull();
    expect(sanitizeText(null, 100)).toBeNull();
  });

  it('removes zero-width and bidi characters', () => {
    // Invisible to whoever reviews the suggestion, meaningful to a tokenizer.
    const smuggled = 'pagos​con‮transferencia﻿';
    expect(sanitizeText(smuggled, 100)).toBe('pagoscontransferencia');
  });

  it('collapses control characters', () => {
    expect(sanitizeText('ab', 100)).toBe('a b');
  });

  it('accepts a well-formed week', () => {
    const week = sanitizeHours([null, [540, 1080], [540, 1080], null, null, null, null]);
    expect(week).toEqual([null, [540, 1080], [540, 1080], null, null, null, null]);
  });

  it('drops impossible windows rather than guessing', () => {
    const week = sanitizeHours([[600, 600], [540, 1080], null, null, null, null, null]);
    expect(week?.[0]).toBeNull();
    expect(week?.[1]).toEqual([540, 1080]);
  });

  it('returns null for an all-closed week', () => {
    // Storing this would silently tell the agent the shop never delivers.
    expect(sanitizeHours([null, null, null, null, null, null, null])).toBeNull();
  });

  it('rejects a week that is not seven days', () => {
    expect(sanitizeHours([[540, 1080]])).toBeNull();
    expect(sanitizeHours(null)).toBeNull();
  });
});
