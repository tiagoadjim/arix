import { describe, it, expect } from 'vitest';
import { productLink } from '../src/skills/catalog';

const wc = (over: Partial<{ url: string; frontUrl: string; productLinkTemplate: string }> = {}) => ({
  url: 'https://shop.example.com',
  frontUrl: '',
  productLinkTemplate: '{base}/producto/{slug}',
  ...over,
});

describe('productLink', () => {
  it('prefers the product permalink from the Woo API when present', () => {
    const link = productLink({ permalink: 'https://shop.example.com/product/foo', slug: 'foo' }, wc());
    expect(link).toBe('https://shop.example.com/product/foo');
  });

  it('rewrites the permalink origin to wc.front_url when set, keeping the path', () => {
    const link = productLink(
      { permalink: 'https://shop.example.com/product/foo', slug: 'foo' },
      wc({ frontUrl: 'https://store.example.com' }),
    );
    expect(link).toBe('https://store.example.com/product/foo');
  });

  it('falls back to the template (front/base + /producto/<slug>) when the permalink is missing', () => {
    const link = productLink({ permalink: '', slug: 'foo' }, wc());
    expect(link).toBe('https://shop.example.com/producto/foo');
  });

  it('uses front_url as the template base when set and the permalink is missing', () => {
    const link = productLink({ permalink: '', slug: 'foo' }, wc({ frontUrl: 'https://store.example.com' }));
    expect(link).toBe('https://store.example.com/producto/foo');
  });

  it('honors a custom wc.product_link_template', () => {
    const link = productLink({ permalink: '', slug: 'foo' }, wc({ productLinkTemplate: '{base}/shop/{slug}/' }));
    expect(link).toBe('https://shop.example.com/shop/foo/');
  });

  it('falls back to the raw permalink unchanged when front_url is malformed', () => {
    const link = productLink(
      { permalink: 'https://shop.example.com/product/foo', slug: 'foo' },
      wc({ frontUrl: 'not-a-url' }),
    );
    expect(link).toBe('https://shop.example.com/product/foo');
  });

  it('trims a trailing slash from the base before applying the template', () => {
    const link = productLink({ permalink: '', slug: 'foo' }, wc({ url: 'https://shop.example.com/' }));
    expect(link).toBe('https://shop.example.com/producto/foo');
  });

  it('treats a whitespace-only permalink as missing', () => {
    const link = productLink({ permalink: '   ', slug: 'foo' }, wc());
    expect(link).toBe('https://shop.example.com/producto/foo');
  });
});
