/**
 * First-run seed for the landing price list. Mirrors the bundled data currently
 * in the landing repo (src/data/pricing.ts for the numbers, dictionaries for the
 * bilingual names) so the owner opens Strapi to the full menu already populated
 * and can edit names, prices, durations or add/remove services with no developer.
 *
 * Idempotent and keyed by slug: once a category/item exists it is never touched
 * again, so edits made in the admin survive every reboot. Categories are created
 * first, then each item is linked to its category by documentId.
 */
import type { Core } from '@strapi/strapi';

const CATEGORY_UID = 'api::price-category.price-category';
const ITEM_UID = 'api::price-item.price-item';

type SeedItem = {
  slug: string;
  name_es: string;
  name_en: string;
  desc_es: string;
  desc_en: string;
  priceCOP: number;
  durationMin: number | null;
};

type SeedCategory = {
  slug: string;
  label_es: string;
  label_en: string;
  sub_es: string;
  sub_en: string;
  items: SeedItem[];
};

const MENU: SeedCategory[] = [
  {
    slug: 'montajes',
    label_es: 'Montajes',
    label_en: 'Builds',
    sub_es: 'Sistemas nuevos · Extensión',
    sub_en: 'New systems · Extension',
    items: [
      { slug: 'polygel-sculpted', name_es: 'Esculpidas en polygel', name_en: 'Sculpted polygel', desc_es: 'Ligereza con extensión · Acabado natural', desc_en: 'Lightweight extension · Natural finish', priceCOP: 120000, durationMin: 150 },
      { slug: 'acrylic-sculpted', name_es: 'Esculpidas en acrílico', name_en: 'Sculpted acrylic', desc_es: 'Estructura perfecta · Duración que destaca', desc_en: 'Perfect structure · Standout durability', priceCOP: 115000, durationMin: 150 },
      { slug: 'polygel-dual', name_es: 'Dual system polygel', name_en: 'Dual-system polygel', desc_es: 'Precisión de lujo · Acabado impecable', desc_en: 'Luxury precision · Flawless finish', priceCOP: 110000, durationMin: 150 },
      { slug: 'builder-gel-dual', name_es: 'Dual system builder gel', name_en: 'Dual-system builder gel', desc_es: 'Resistencia · Delicadeza · Perfección', desc_en: 'Strength · Delicacy · Perfection', priceCOP: 105000, durationMin: 150 },
      { slug: 'press-on', name_es: 'Press on', name_en: 'Press-on', desc_es: 'Lujo instantáneo · Estilo y comodidad', desc_en: 'Instant luxury · Style and comfort', priceCOP: 100000, durationMin: 105 },
    ],
  },
  {
    slug: 'retoques',
    label_es: 'Retoques',
    label_en: 'Refills',
    sub_es: 'Mantenimiento de sistema',
    sub_en: 'System maintenance',
    items: [
      { slug: 'polygel-refill', name_es: 'Retoque polygel', name_en: 'Polygel refill', desc_es: '3 retoques por montaje, máximo cada 21 días', desc_en: '3 refills per build, every 21 days max', priceCOP: 90000, durationMin: 120 },
      { slug: 'builder-gel-refill', name_es: 'Retoque builder gel', name_en: 'Builder gel refill', desc_es: '3 retoques por montaje, máximo cada 21 días', desc_en: '3 refills per build, every 21 days max', priceCOP: 85000, durationMin: 120 },
      { slug: 'acrylic-refill', name_es: 'Retoque acrílico', name_en: 'Acrylic refill', desc_es: '3 retoques por montaje, máximo cada 21 días', desc_en: '3 refills per build, every 21 days max', priceCOP: 80000, durationMin: 120 },
    ],
  },
  {
    slug: 'forrados',
    label_es: 'Forrados',
    label_en: 'Overlays',
    sub_es: 'Refuerzo sin extensión',
    sub_en: 'Reinforcement, no extension',
    items: [
      { slug: 'polygel-overlay', name_es: 'Forrado en polygel', name_en: 'Polygel overlay', desc_es: 'Sobre uña natural', desc_en: 'On the natural nail', priceCOP: 95000, durationMin: 90 },
      { slug: 'builder-gel-overlay', name_es: 'Forrado en builder gel', name_en: 'Builder gel overlay', desc_es: 'Sobre uña natural', desc_en: 'On the natural nail', priceCOP: 90000, durationMin: 90 },
      { slug: 'acrylic-overlay', name_es: 'Forrado en acrílico', name_en: 'Acrylic overlay', desc_es: 'Sobre uña natural', desc_en: 'On the natural nail', priceCOP: 85000, durationMin: 90 },
      { slug: 'dipping', name_es: 'Dipping', name_en: 'Dipping', desc_es: 'Sistema en polvo, sin monómero', desc_en: 'Powder system, no monomer', priceCOP: 80000, durationMin: 90 },
      { slug: 'rubber-base-leveling', name_es: 'Nivelación base rubber', name_en: 'Rubber base leveling', desc_es: 'Base estructurante', desc_en: 'Structural base coat', priceCOP: 70000, durationMin: 90 },
    ],
  },
  {
    slug: 'sencillos',
    label_es: 'Sencillos',
    label_en: 'Simple',
    sub_es: 'Manicura · pedicura',
    sub_en: 'Manicure · pedicure',
    items: [
      { slug: 'semi-permanent-feet', name_es: 'Semipermanente pies', name_en: 'Semi-permanent feet', desc_es: 'Limpieza + esmalte gel', desc_en: 'Cleanup + gel polish', priceCOP: 55000, durationMin: 75 },
      { slug: 'semi-permanent-no-color', name_es: 'Semipermanente sin color', name_en: 'Semi-permanent no color', desc_es: 'Limpieza + gel sin color', desc_en: 'Cleanup + clear gel', priceCOP: 40000, durationMin: 45 },
      { slug: 'semi-permanent-hands', name_es: 'Semipermanente manos', name_en: 'Semi-permanent hands', desc_es: 'Limpieza + esmalte gel', desc_en: 'Cleanup + gel polish', priceCOP: 50000, durationMin: 60 },
      { slug: 'traditional-feet', name_es: 'Tradicional pies', name_en: 'Traditional feet', desc_es: 'Limpieza + esmalte tradicional', desc_en: 'Cleanup + regular polish', priceCOP: 35000, durationMin: 60 },
      { slug: 'traditional-hands', name_es: 'Tradicional manos', name_en: 'Traditional hands', desc_es: 'Limpieza + esmalte tradicional', desc_en: 'Cleanup + regular polish', priceCOP: 30000, durationMin: 60 },
      { slug: 'feet-cleanup-only', name_es: 'Solo limpieza pies', name_en: 'Feet cleanup only', desc_es: 'Sin esmalte', desc_en: 'No polish', priceCOP: 25000, durationMin: 45 },
      { slug: 'hands-cleanup-only', name_es: 'Solo limpieza manos', name_en: 'Hands cleanup only', desc_es: 'Sin esmalte', desc_en: 'No polish', priceCOP: 20000, durationMin: 30 },
    ],
  },
  {
    slug: 'combos',
    label_es: 'Combos',
    label_en: 'Combos',
    sub_es: 'Manos + pies · Dúo',
    sub_en: 'Hands + feet · Duo',
    items: [
      { slug: 'polygel-overlay-hands-semi-feet', name_es: 'Forrado polygel manos + semi pies', name_en: 'Polygel overlay hands + semi feet', desc_es: 'Forrado en uña natural + esmalte gel en pies', desc_en: 'Overlay on natural nail + gel polish on feet', priceCOP: 135000, durationMin: 150 },
      { slug: 'builder-gel-overlay-hands-semi-feet', name_es: 'Forrado builder gel manos + semi pies', name_en: 'Builder gel overlay hands + semi feet', desc_es: 'Forrado en uña natural + esmalte gel en pies', desc_en: 'Overlay on natural nail + gel polish on feet', priceCOP: 130000, durationMin: 150 },
      { slug: 'acrylic-overlay-hands-semi-feet', name_es: 'Forrado acrílico manos + semi pies', name_en: 'Acrylic overlay hands + semi feet', desc_es: 'Forrado en uña natural + esmalte gel en pies', desc_en: 'Overlay on natural nail + gel polish on feet', priceCOP: 125000, durationMin: 150 },
      { slug: 'semi-permanent-hands-feet', name_es: 'Semipermanente manos + pies', name_en: 'Semi-permanent hands + feet', desc_es: 'Esmalte gel en manos y pies', desc_en: 'Gel polish on hands and feet', priceCOP: 95000, durationMin: 120 },
      { slug: 'semi-permanent-hands-traditional-feet', name_es: 'Semipermanente manos + tradicional pies', name_en: 'Semi-permanent hands + traditional feet', desc_es: 'Esmalte gel manos + esmalte tradicional pies', desc_en: 'Gel polish hands + regular polish feet', priceCOP: 77000, durationMin: 120 },
    ],
  },
  {
    slug: 'extras',
    label_es: 'Extras',
    label_en: 'Extras',
    sub_es: 'Servicios adicionales',
    sub_en: 'Add-on services',
    items: [
      { slug: 'system-removal', name_es: 'Retiro de sistema previo', name_en: 'External system removal', desc_es: 'Gratis en tu primera visita · Para uñas de otro lugar', desc_en: 'Waived on your first visit · For nails from another salon', priceCOP: 20000, durationMin: 30 },
      { slug: 'single-dual-system-nail', name_es: 'Uña dual system individual', name_en: 'Single dual-system nail', desc_es: 'Reemplazo individual · Sistema dual', desc_en: 'Individual replacement · Dual system', priceCOP: 11000, durationMin: 10 },
      { slug: 'single-press-on-nail', name_es: 'Press-on individual', name_en: 'Single press-on nail', desc_es: 'Reemplazo individual · Press-on', desc_en: 'Individual replacement · Press-on', priceCOP: 10000, durationMin: 5 },
      { slug: 'design-per-nail', name_es: 'Diseño / decoración por uña', name_en: 'Design / decoration per nail', desc_es: 'Nail art aplicado sobre tu servicio', desc_en: 'Nail art applied on top of your service', priceCOP: 10000, durationMin: null },
      { slug: 'in-depth-foot-cleaning', name_es: 'Limpieza profunda de pies', name_en: 'In-depth foot cleaning', desc_es: 'Hongos, uñas encarnadas y casos especiales', desc_en: 'Fungus, ingrown nails and special cases', priceCOP: 15000, durationMin: 10 },
    ],
  },
];

export async function seedPricing(strapi: Core.Strapi): Promise<void> {
  let catCount = 0;
  let itemCount = 0;

  for (let ci = 0; ci < MENU.length; ci++) {
    const cat = MENU[ci];

    let category = (
      await strapi.documents(CATEGORY_UID).findMany({
        filters: { slug: cat.slug },
        limit: 1,
      })
    )[0];

    if (!category) {
      category = await strapi.documents(CATEGORY_UID).create({
        data: {
          slug: cat.slug,
          label_es: cat.label_es,
          label_en: cat.label_en,
          sub_es: cat.sub_es,
          sub_en: cat.sub_en,
          order: ci,
        },
      });
      catCount++;
    }

    for (let ii = 0; ii < cat.items.length; ii++) {
      const item = cat.items[ii];
      const existing = await strapi.documents(ITEM_UID).findMany({
        filters: { slug: item.slug },
        limit: 1,
      });
      if (existing.length > 0) continue;
      await strapi.documents(ITEM_UID).create({
        data: {
          slug: item.slug,
          name_es: item.name_es,
          name_en: item.name_en,
          desc_es: item.desc_es,
          desc_en: item.desc_en,
          priceCOP: item.priceCOP,
          durationMin: item.durationMin,
          order: ii,
          category: category.documentId,
        },
      });
      itemCount++;
    }
  }

  if (catCount > 0 || itemCount > 0) {
    strapi.log.info(
      `[cms] seeded pricing: ${catCount} categor${catCount === 1 ? 'y' : 'ies'}, ${itemCount} item${itemCount === 1 ? '' : 's'}`,
    );
  }
}
