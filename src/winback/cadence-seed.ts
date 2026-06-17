import type { Core } from '@strapi/strapi';
import type { ServiceCategory } from './category';

/**
 * Default retoque windows per service category (days).
 * `montaje`/`forrado`/`retoque` are retoque-eligible → active with a 15–21 window.
 * `press_on` is seeded inactive: Juanes leans "not eligible"; flip `active` to enable
 * it later with no code change. `sencillo`/`otro` never drive a countdown.
 */
export const CADENCE_DEFAULTS: Array<{
  service_category: ServiceCategory;
  min_days: number;
  max_days: number;
  active: boolean;
}> = [
  { service_category: 'montaje', min_days: 15, max_days: 21, active: true },
  { service_category: 'retoque', min_days: 15, max_days: 21, active: true },
  { service_category: 'forrado', min_days: 15, max_days: 21, active: true },
  { service_category: 'press_on', min_days: 15, max_days: 21, active: false },
  { service_category: 'sencillo', min_days: 0, max_days: 0, active: false },
  { service_category: 'otro', min_days: 0, max_days: 0, active: false },
];

/**
 * Idempotently ensure one ServiceCadence row exists per category.
 * Creates missing rows only — never overwrites values an admin has edited.
 */
export async function seedServiceCadences(strapi: Core.Strapi): Promise<void> {
  for (const row of CADENCE_DEFAULTS) {
    const existing = await strapi.documents('api::service-cadence.service-cadence').findMany({
      filters: { service_category: row.service_category },
      limit: 1,
    });
    if (existing.length === 0) {
      await strapi.documents('api::service-cadence.service-cadence').create({ data: row });
      strapi.log.info(`[winback] seeded ServiceCadence: ${row.service_category}`);
    }
  }
}
