import { woo, type WcProduct, type WcVariation } from '../integrations/woocommerce';
import { config } from '../config';
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

// Headless: the storefront is WC_FRONT_URL, NOT the WordPress/REST domain.
// WC_FRONT_URL is optional — fall back to WC_URL when it isn't configured (a
// later phase switches this to the product's own `permalink` from the API).
// Product page = <front>/producto/<slug>.
function productLink(product: WcProduct): string {
  const base = (config.WC_FRONT_URL || config.WC_URL).replace(/\/$/, '');
  return `${base}/producto/${product.slug}`;
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
      const products = await woo.searchProducts({
        search: query,
        stockStatus: inStockOnly ? 'instock' : undefined,
        perPage: 10,
      });

      // Enrich the first few variable products with their flavor variations.
      const out = [];
      let enriched = 0;
      for (const p of products.slice(0, 8)) {
        const base = {
          id: p.id,
          nombre: p.name,
          precio: p.price || p.regular_price || null,
          moneda: config.WC_CURRENCY,
          stock: STOCK_ES[p.stock_status] ?? p.stock_status,
          categorias: p.categories?.map((c) => c.name) ?? [],
          sabores: flavorsOf(p),
          link: productLink(p),
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
      const p = await woo.getProduct(id);
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
        moneda: config.WC_CURRENCY,
        stock: STOCK_ES[p.stock_status] ?? p.stock_status,
        descripcion: (p.short_description ?? '').replace(/<[^>]+>/g, '').trim() || null,
        sabores: flavorsOf(p),
        variaciones,
        link: productLink(p),
      };
    },
  },
];
