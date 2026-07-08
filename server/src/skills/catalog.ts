import { woo, type WcProduct, type WcVariation } from '../integrations/woocommerce';
import { woo as wooConfig, type WooSettings } from '../config/runtime';
import { logger } from '../logger';
import type { ToolSpec } from '../agent/tool-spec';

const STOCK_ES: Record<string, string> = {
  instock: 'en stock',
  outofstock: 'sin stock',
  onbackorder: 'a pedido',
};

function flavorsOf(product: WcProduct): string[] {
  const attr = product.attributes?.find((a) => a.variation && a.options?.length);
  return attr?.options ?? [];
}

type ProductLinkConfig = Pick<WooSettings, 'url' | 'frontUrl' | 'productLinkTemplate'>;

/** Rewrite `permalink`'s origin (scheme + host) to `frontUrl`'s, keeping the
 * path — for headless setups where the WordPress/REST domain differs from
 * the public storefront. Returns the permalink unchanged if frontUrl is
 * unset or either URL fails to parse (never throws on bad config data). */
function rewriteOrigin(permalink: string, frontUrl: string): string {
  if (!frontUrl.trim()) return permalink;
  try {
    const url = new URL(permalink);
    const front = new URL(frontUrl);
    url.protocol = front.protocol;
    url.host = front.host;
    return url.toString();
  } catch {
    return permalink;
  }
}

/**
 * Product page URL. Prefers the product's own `permalink` from the Woo API
 * (rewritten onto the storefront origin when wc.front_url is set, for
 * headless setups where the REST domain differs from the public site).
 * Falls back to wc.product_link_template (default `{base}/producto/{slug}`)
 * only when the API gave no usable permalink — e.g. a malformed response
 * degraded by integrations/woocommerce.ts's sanitizeProduct().
 */
export function productLink(product: Pick<WcProduct, 'permalink' | 'slug'>, wc: ProductLinkConfig): string {
  const permalink = (product.permalink ?? '').trim();
  if (permalink) return rewriteOrigin(permalink, wc.frontUrl);

  const base = (wc.frontUrl || wc.url).replace(/\/$/, '');
  return wc.productLinkTemplate.replace('{base}', base).replace('{slug}', product.slug);
}

function variationSummary(v: WcVariation) {
  const flavor = v.attributes?.[0]?.option ?? null;
  return {
    sabor: flavor,
    precio: v.price || v.regular_price || null,
    stock: STOCK_ES[v.stock_status] ?? v.stock_status,
    cantidad: v.stock_quantity,
  };
}

export const catalogTools: ToolSpec[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'search_catalog',
        description:
          'Searches the store (WooCommerce) for products by text. Returns name, price, stock and available flavors. Use it whenever the customer asks about products, prices, flavors or availability. NEVER invent prices or stock: use this tool.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Text to search for, e.g. "disposable pod", "mango", "Elf Bar".',
            },
            in_stock_only: {
              type: 'boolean',
              description: 'If true, only returns products that currently have stock.',
            },
          },
          required: ['query'],
        },
      },
    },
    handler: async (args) => {
      const query = String(args.query ?? '').trim();
      const inStockOnly = args.in_stock_only === true;
      const [products, wc] = await Promise.all([
        woo.searchProducts({
          search: query,
          stockStatus: inStockOnly ? 'instock' : undefined,
          perPage: 10,
        }),
        wooConfig(),
      ]);

      // Enrich the first few variable products with their flavor variations.
      const out = [];
      let enriched = 0;
      for (const p of products.slice(0, 8)) {
        const base = {
          id: p.id,
          nombre: p.name,
          precio: p.price || p.regular_price || null,
          moneda: wc.currency,
          stock: STOCK_ES[p.stock_status] ?? p.stock_status,
          categorias: p.categories?.map((c) => c.name) ?? [],
          sabores: flavorsOf(p),
          link: productLink(p, wc),
          variaciones: undefined as unknown,
        };
        if (p.type === 'variable' && p.variations?.length && enriched < 5) {
          try {
            const variations = await woo.getVariations(p.id);
            base.variaciones = variations.map(variationSummary);
            enriched += 1;
          } catch (err) {
            logger.warn({ err, productId: p.id }, 'failed to load variations');
          }
        }
        out.push(base);
      }

      return { cantidad: out.length, productos: out };
    },
  },

  {
    definition: {
      type: 'function',
      function: {
        name: 'view_product',
        description:
          "Fetches the full detail of a product by its id (price, short description, flavors with per-flavor stock). Use it when the customer wants more detail on a specific product that already came up in search_catalog.",
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number', description: 'The product id.' },
          },
          required: ['product_id'],
        },
      },
    },
    handler: async (args) => {
      const id = Number(args.product_id);
      if (!Number.isFinite(id)) return { error: 'product_id inválido' };
      const [p, wc] = await Promise.all([woo.getProduct(id), wooConfig()]);
      let variaciones: unknown = undefined;
      if (p.type === 'variable' && p.variations?.length) {
        try {
          variaciones = (await woo.getVariations(p.id)).map(variationSummary);
        } catch (err) {
          logger.warn({ err, productId: p.id }, 'failed to load variations');
        }
      }
      return {
        id: p.id,
        nombre: p.name,
        precio: p.price || p.regular_price || null,
        moneda: wc.currency,
        stock: STOCK_ES[p.stock_status] ?? p.stock_status,
        descripcion: (p.short_description ?? '').replace(/<[^>]+>/g, '').trim() || null,
        sabores: flavorsOf(p),
        variaciones,
        link: productLink(p, wc),
      };
    },
  },
];
