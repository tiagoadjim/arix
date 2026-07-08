import { woo, type WcProduct, type WcVariation } from '../integrations/woocommerce';
import { woo as wooConfig } from '../config/runtime';
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

// Headless: the storefront is wc.front_url, NOT the WordPress/REST domain.
// wc.front_url is optional — fall back to wc.url when it isn't configured (a
// later phase switches this to the product's own `permalink` from the API).
// Product page = <front>/producto/<slug>. `frontBase` is resolved once per
// handler call (see wooConfig() below) and passed in to avoid re-resolving it
// per product in a search result loop.
function productLink(product: WcProduct, frontBase: string): string {
  return `${frontBase}/producto/${product.slug}`;
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
      const frontBase = (wc.frontUrl || wc.url).replace(/\/$/, '');

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
          link: productLink(p, frontBase),
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
      const frontBase = (wc.frontUrl || wc.url).replace(/\/$/, '');
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
        link: productLink(p, frontBase),
      };
    },
  },
];
