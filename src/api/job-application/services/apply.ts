/**
 * Job-application intake service — the one path that turns a public form POST
 * into a Postulación entry with its CV in the Media Library.
 *
 * Trust model: this runs behind the secret-gated route (controllers/apply.ts),
 * which is itself only called by the landing's /api/postulaciones proxy. Even
 * so, everything here is validated again from scratch — the proxy is a
 * convenience, not a security boundary.
 *
 * Three things worth knowing:
 *   1. File type is decided by MAGIC BYTES, not by the declared Content-Type,
 *      which a caller controls. An applicant may send a PDF, a phone photo of
 *      their resume (very common here), or a Word doc.
 *   2. The CV lands in the "Postulaciones" folder, which the watermark hook
 *      skips — so a photographed resume doesn't get the gold wordmark baked in.
 *   3. Failures return a typed reason instead of throwing, so the controller can
 *      map each to an HTTP status the form knows how to explain in Spanish.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Core } from '@strapi/strapi';
import { normalizePhone } from '../../../winback/normalize';
import { getActiveRoleBySlug, getCareersFolderId } from '../../../cms/careers';

const UID = 'api::job-application.job-application';

// The cargo list is NOT hard-coded here — it lives in the Cargo (vacante)
// content type so the owner can open and close positions herself. We only check
// that the submitted slug matches a currently-active one.
const EXPERIENCE = ['sin_experiencia', 'menos_de_1', 'de_1_a_3', 'de_3_a_5', 'mas_de_5'];
const SURFACES = ['landing', 'bio'];
const LANGS = ['es', 'en'];

/**
 * Hard ceiling for a CV. Kept at 4 MB because Vercel caps a serverless request
 * body at 4.5 MB — a larger file would die in the proxy with an opaque 413
 * before it ever reached Strapi, so we reject it here with the same limit the
 * form advertises.
 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** Applications accepted per phone per 24 h before we start refusing. */
const DEFAULT_MAX_PER_PHONE = 3;

function maxBytes(): number {
  const n = Number(process.env.CAREERS_MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

function maxPerPhone(): number {
  const n = Number(process.env.CAREERS_MAX_PER_PHONE_PER_DAY);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PER_PHONE;
}

/* ── file sniffing ────────────────────────────────────────────────────────── */

type SniffKind = 'pdf' | 'jpeg' | 'png' | 'webp' | 'heic' | 'zip' | 'ole' | 'unknown';

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim'];

/** Identify a file from its leading bytes. Never trusts the declared MIME. */
function sniff(head: Buffer): SniffKind {
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  if (
    head.length >= 12 &&
    head.subarray(4, 8).toString('latin1') === 'ftyp' &&
    HEIC_BRANDS.includes(head.subarray(8, 12).toString('latin1'))
  ) {
    return 'heic';
  }
  // .docx / .odt are zip containers; .doc is an OLE compound file.
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return 'zip';
  }
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  ) {
    return 'ole';
  }
  return 'unknown';
}

const OFFICE_ZIP_EXT = ['.docx', '.odt'];
const OFFICE_OLE_EXT = ['.doc'];

/**
 * A sniffed kind is accepted outright for documents/photos. Zip- and OLE-based
 * Office formats are ambiguous by nature (any .zip sniffs as zip), so those also
 * have to carry a matching extension — enough to keep a random archive out
 * without rejecting the .docx resumes people actually send.
 */
function isAcceptedFile(kind: SniffKind, filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  switch (kind) {
    case 'pdf':
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'heic':
      return true;
    case 'zip':
      return OFFICE_ZIP_EXT.includes(ext);
    case 'ole':
      return OFFICE_OLE_EXT.includes(ext);
    default:
      return false;
  }
}

async function readHead(filepath: string, bytes = 16): Promise<Buffer> {
  const handle = await fs.promises.open(filepath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/* ── field normalization ──────────────────────────────────────────────────── */

function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return String(value).trim();
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Collapse the technique checkboxes into one readable, admin-friendly line. */
function joinTechniques(value: unknown): string {
  const list = Array.isArray(value) ? value : str(value).split(',');
  const cleaned = list
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .filter((t, i, all) => all.indexOf(t) === i);
  return clamp(cleaned.join(', '), 240);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * Normalize whatever the applicant typed into a portfolio link: a bare
 * `@handle` becomes an Instagram profile, a bare domain gets https://, and
 * anything already absolute is kept. Returns '' when it can't be salvaged.
 */
function normalizePortfolio(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('@')) {
    const handle = value.slice(1).replace(/[^A-Za-z0-9._]/g, '');
    return handle ? `https://instagram.com/${handle}` : '';
  }
  if (/^https?:\/\//i.test(value)) return clamp(value, 300);
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value)) return clamp(`https://${value}`, 300);
  // Not a URL at all (e.g. someone typed their handle without the @).
  const handle = value.replace(/[^A-Za-z0-9._]/g, '');
  return handle ? `https://instagram.com/${handle}` : '';
}

/** Filesystem-safe, human-readable Media Library name: "Ana Gómez — CV.pdf". */
function mediaName(fullName: string, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase() || '';
  const base = fullName
    .normalize('NFC')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${base || 'Postulante'} — CV${ext}`;
}

/* ── result shape ─────────────────────────────────────────────────────────── */

export type SubmitFailure =
  | { ok: false; reason: 'validation'; fields: string[] }
  | { ok: false; reason: 'file_missing' }
  | { ok: false; reason: 'file_too_large'; maxBytes: number }
  | { ok: false; reason: 'file_type' }
  | { ok: false; reason: 'rate_limited' };

export type SubmitResult = { ok: true; documentId: string; id: number } | SubmitFailure;

export interface SubmitInput {
  fields: Record<string, unknown>;
  /** The multipart file as Koa/formidable hands it over. */
  file?: {
    filepath?: string;
    path?: string;
    originalFilename?: string;
    name?: string;
    mimetype?: string;
    type?: string;
    size?: number;
  } | null;
  /** Pre-hashed client IP (the proxy hashes it — Strapi never sees a raw IP). */
  ipHash?: string | null;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async submit({ fields, file, ipHash }: SubmitInput): Promise<SubmitResult> {
    /* 1 — fields */
    const invalid: string[] = [];

    const full_name = clamp(str(fields.full_name), 120);
    if (full_name.length < 2) invalid.push('full_name');

    const phone = normalizePhone(str(fields.phone));
    if (!phone) invalid.push('phone');

    const emailRaw = clamp(str(fields.email).toLowerCase(), 160);
    if (emailRaw && !EMAIL_RE.test(emailRaw)) invalid.push('email');

    // The form posts the cargo's slug; we resolve it against the active Cargo
    // entries. An unknown or closed cargo is a validation error, so a stale page
    // can't file an application against a position that no longer exists.
    const roleSlug = str(fields.role_applied);
    const role = await getActiveRoleBySlug(strapi, roleSlug);
    if (!role) invalid.push('role_applied');

    const experienceRaw = str(fields.experience);
    const experience = EXPERIENCE.includes(experienceRaw) ? experienceRaw : null;
    if (experienceRaw && !experience) invalid.push('experience');

    // Habeas data (Ley 1581 de 2012): storing a CV needs explicit consent.
    const consent = str(fields.consent) === 'true' || fields.consent === true;
    if (!consent) invalid.push('consent');

    const techniques = joinTechniques(fields.techniques);
    const portfolio_url = normalizePortfolio(str(fields.portfolio_url));
    // Over-long messages are trimmed, never rejected — losing an applicant over
    // an extra paragraph would be absurd.
    const message = clamp(str(fields.message), 2000);

    const surfaceRaw = str(fields.source_surface);
    const source_surface = SURFACES.includes(surfaceRaw) ? surfaceRaw : 'landing';
    const langRaw = str(fields.source_lang);
    const source_lang = LANGS.includes(langRaw) ? langRaw : 'es';

    if (invalid.length > 0) return { ok: false, reason: 'validation', fields: invalid };

    /* 2 — file */
    const filepath = file?.filepath ?? file?.path;
    const originalName = file?.originalFilename ?? file?.name ?? '';
    if (!filepath) return { ok: false, reason: 'file_missing' };

    let realSize: number;
    try {
      realSize = (await fs.promises.stat(filepath)).size;
    } catch {
      return { ok: false, reason: 'file_missing' };
    }
    if (realSize === 0) return { ok: false, reason: 'file_missing' };
    if (realSize > maxBytes()) return { ok: false, reason: 'file_too_large', maxBytes: maxBytes() };

    const kind = sniff(await readHead(filepath));
    if (!isAcceptedFile(kind, originalName)) {
      strapi.log.info(`[careers] rejected CV upload (sniffed "${kind}", name "${originalName}")`);
      return { ok: false, reason: 'file_type' };
    }

    /* 3 — throttle: same phone, same day */
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recent = await strapi.db
        .query(UID)
        .count({ where: { phone, createdAt: { $gte: since } } });
      if (recent >= maxPerPhone()) {
        strapi.log.warn(`[careers] throttled ${phone} (${recent} applications in 24h)`);
        return { ok: false, reason: 'rate_limited' };
      }
    } catch (err: any) {
      // A throttle that can't read the DB must not block a real applicant.
      strapi.log.warn(`[careers] throttle check failed (allowing): ${err?.message}`);
    }

    /* 4 — CV into the Media Library (Postulaciones folder → never watermarked) */
    const folder = await getCareersFolderId(strapi);
    const uploaded = await strapi
      .plugin('upload')
      .service('upload')
      .upload({
        data: {
          fileInfo: {
            name: mediaName(full_name, originalName),
            alternativeText: `Hoja de vida — ${full_name}`,
            caption: `Postulación ${role!.label_es} · ${new Date().toISOString().slice(0, 10)}`,
            folder,
          },
        },
        files: file,
      });
    const cvId = Array.isArray(uploaded) ? uploaded[0]?.id : (uploaded as any)?.id;
    if (!cvId) throw new Error('upload returned no file id');

    /* 5 — the entry */
    const entry: any = await strapi.documents(UID as any).create({
      data: {
        full_name,
        phone,
        email: emailRaw || null,
        // Snapshot the cargo's Spanish name so the history stays readable even
        // if the vacancy is later renamed or deleted; `role` keeps the live link.
        role_applied: role!.label_es,
        role: role!.id,
        experience,
        techniques: techniques || null,
        portfolio_url: portfolio_url || null,
        message: message || null,
        cv: cvId,
        consent,
        // NOT `status`: the Content Manager injects its own computed `status`
        // ('draft' | 'published') into API responses, which would shadow this
        // value on every read from the admin panel.
        triage_status: 'nueva',
        source_surface,
        source_lang,
        submitted_ip_hash: ipHash || null,
      } as any,
    });

    strapi.log.info(
      `[careers] new application from ${full_name} (${role!.slug}, ${source_surface}/${source_lang})`,
    );
    return { ok: true, documentId: entry.documentId, id: entry.id };
  },
});
