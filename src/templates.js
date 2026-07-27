// The OrcaSlicer/Bambu project-settings templates the exporter bakes into
// Snapmaker U1 output. Kept out of the JS so the served build (index.html +
// native ES modules) fetches them at runtime. The single-file build
// (scripts/bundle.mjs) swaps this module for one with the JSON inlined, so the
// shared dist/index.html runs from file:// with no server.
const base = new URL('./templates/', import.meta.url);

export const templatesReady = Promise.all([
  fetch(new URL('project_settings.base.json', base)).then((r) => r.text()),
  fetch(new URL('project_settings.supports.json', base)).then((r) => r.text()),
]);
