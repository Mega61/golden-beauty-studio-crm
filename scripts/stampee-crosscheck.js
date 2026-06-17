'use strict';
/**
 * Stampee fidelization cross-check (plan §6). Phone-only match of Stampee customers
 * against Strapi clients; stamps each client matched | sin_tarjeta and prints the two
 * clean-up lists (clients to give a card / Stampee cards missing a phone).
 *
 * Source now: an exported customers.json. Later: the live Stampee API
 * (GET /customers?include=cards) — set STAMPEE_API_URL + STAMPEE_TOKEN and extend
 * loadCustomers().
 *
 * Usage:
 *   node scripts/stampee-crosscheck.js [path/to/customers.json]
 */
const fs = require('fs');
const path = require('path');
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const DEFAULT_JSON = path.join(__dirname, '..', '.claude', 'handoff', 'customers.json');

async function loadCustomers(file) {
  // File source (BOM-tolerant). The live-API branch goes here later.
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.data || parsed.customers || [];
  return list;
}

async function main() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_JSON;
  console.log(`[stampee] reading ${file}`);
  const customers = await loadCustomers(file);
  console.log(`[stampee] ${customers.length} Stampee customers`);

  const app = await createStrapi(await compileStrapi()).load();
  try {
    const s = await app.service('api::client.stampee').crosscheck(customers);
    console.log('\n[stampee] summary:');
    console.log(`  Stampee customers      : ${s.customers_total} (internal skipped: ${s.internal_skipped})`);
    console.log(`  Strapi clients         : ${s.clients_total}`);
    console.log(`  matched (has card)     : ${s.matched}`);
    console.log(`  sin_tarjeta (no card)  : ${s.sin_tarjeta}`);
    console.log('\n  → Clients to give a card:');
    for (const n of s.sin_tarjeta_names) console.log(`      - ${n}`);
    console.log('\n  → Stampee cards missing a phone (Mariana to add the number):');
    for (const n of s.stampee_missing_mobile) console.log(`      - ${n}`);
  } finally {
    await app.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[stampee] FAILED:', err);
    process.exit(1);
  });
