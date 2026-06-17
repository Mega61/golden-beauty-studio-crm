/**
 * Download the generated report from S3 and upload it to the Strapi intake route
 * (the same endpoint validated against the manual import). Both steps fail loud.
 */
export async function downloadReport(s3Url) {
  const res = await fetch(s3Url);
  if (!res.ok) throw new Error(`S3 download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('Downloaded report is empty');
  return buf;
}

export async function uploadToStrapi({ url, secret, buffer, filename }) {
  const form = new FormData();
  form.append('report', new Blob([buffer]), filename);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-ingest-secret': secret },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Strapi intake ${res.status}: ${text}`);
  return JSON.parse(text);
}
