/**
 * Lookbook item lifecycle — a photo created without an `order` goes to the end
 * of the lookbook (highest existing order + ORDER_STEP), so new uploads never
 * jump ahead of the curated sequence. An explicit value (including 0) is kept.
 * Spacing matches scripts/import-lookbook.mjs and scripts/renumber-lookbook.mjs.
 */
const LOOKBOOK_ITEM_UID = 'api::lookbook-item.lookbook-item';
const ORDER_STEP = 10;

export default {
  async beforeCreate(event: any) {
    const data = event?.params?.data;
    if (!data || (data.order !== null && data.order !== undefined && data.order !== '')) return;

    const [last] = await strapi.db.query(LOOKBOOK_ITEM_UID).findMany({
      select: ['order'],
      where: { order: { $notNull: true } },
      orderBy: { order: 'desc' },
      limit: 1,
    });
    data.order = (last?.order ?? 0) + ORDER_STEP;
  },
};
