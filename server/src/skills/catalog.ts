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

// Headless: the storefront is WC_FRONT_URL (shop.vapenic.com.ar), NOT the
// WordPress/REST domain. Product page = <front>/producto/<slug>.
function productLink(product: WcProduct): string {
  return `${config.WC_FRONT_URL.replace(/\/$/, '')}/producto/${product.slug}`;
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
        name: 'buscar_catalogo',
        description:
          'Busca productos en la tienda Vapenic (WooCommerce) por texto. Devuelve nombre, precio, stock y sabores disponibles. Usalo siempre que el cliente pregunte por productos, precios, sabores o disponibilidad. NUNCA inventes precios ni stock: usá esta tool.',
        parameters: {
          type: 'object',
          properties: {
            consulta: {
              type: 'string',
              description: 'Texto a buscar, ej: "pod descartable", "mango", "Elf Bar".',
            },
            solo_con_stock: {
              type: 'boolean',
              description: 'Si es true, sólo devuelve productos con stock disponible.',
            },
          },
          required: ['consulta'],
        },
      },
    },
    handler: async (args) => {
      const consulta = String(args.consulta ?? '').trim();
      const soloStock = args.solo_con_stock === true;
      const products = await woo.searchProducts({
        search: consulta,
        stockStatus: soloStock ? 'instock' : undefined,
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
        name: 'ver_producto',
        description:
          'Trae el detalle completo de un producto por su id (precio, descripción corta, sabores con stock por sabor). Usalo cuando el cliente quiere más detalle de un producto puntual que ya apareció en buscar_catalogo.',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number', description: 'El id del producto.' },
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
