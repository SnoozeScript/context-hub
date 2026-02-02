import { loadSourceRegistry } from './cache.js';
import { loadConfig } from './config.js';
import { normalizeLanguage } from './normalize.js';

let _merged = null;

/**
 * Load and merge entries from all configured sources.
 * Each entry gets tagged with `_source` (source name).
 */
function getMergedEntries() {
  if (_merged) return _merged;

  const config = loadConfig();
  const allEntries = [];

  for (const source of config.sources) {
    const registry = loadSourceRegistry(source);
    if (!registry?.entries) continue;

    for (const entry of registry.entries) {
      allEntries.push({ ...entry, _source: source.name, _sourceObj: source });
    }
  }

  _merged = allEntries;
  return _merged;
}

/**
 * Filter entries by the global source trust policy.
 */
function applySourceFilter(entries) {
  const config = loadConfig();
  const allowed = config.source.split(',').map((s) => s.trim().toLowerCase());
  return entries.filter((e) => !e.source || allowed.includes(e.source.toLowerCase()));
}

/**
 * Apply tag and language filters.
 */
function applyFilters(entries, filters) {
  let result = entries;

  if (filters.tags) {
    const filterTags = filters.tags.split(',').map((t) => t.trim().toLowerCase());
    result = result.filter((e) =>
      filterTags.every((ft) => e.tags?.some((t) => t.toLowerCase() === ft))
    );
  }
  if (filters.lang) {
    const lang = normalizeLanguage(filters.lang);
    result = result.filter((e) =>
      e.languages?.some((l) => l.language === lang)
    );
  }

  return result;
}

/**
 * Check if an id has collisions across sources.
 */
function getEntriesById(id) {
  const entries = applySourceFilter(getMergedEntries());
  return entries.filter((e) => e.id === id);
}

/**
 * Check if we're in multi-source mode.
 */
export function isMultiSource() {
  const config = loadConfig();
  return config.sources.length > 1;
}

/**
 * Get the display id for an entry — namespaced only on collision.
 */
export function getDisplayId(entry) {
  if (!isMultiSource()) return entry.id;
  const matches = getEntriesById(entry.id);
  if (matches.length > 1) return `${entry._source}/${entry.id}`;
  return entry.id;
}

/**
 * Search entries by query string.
 */
export function searchEntries(query, filters = {}) {
  const entries = applySourceFilter(getMergedEntries());
  const q = query.toLowerCase();
  const words = q.split(/\s+/);

  let results = entries.map((entry) => {
    let score = 0;

    if (entry.id === q) score += 100;
    else if (entry.id.includes(q)) score += 50;

    const nameLower = entry.name.toLowerCase();
    if (nameLower === q) score += 80;
    else if (nameLower.includes(q)) score += 40;

    for (const word of words) {
      if (entry.id.includes(word)) score += 10;
      if (nameLower.includes(word)) score += 10;
      if (entry.description?.toLowerCase().includes(word)) score += 5;
      if (entry.tags?.some((t) => t.toLowerCase().includes(word))) score += 15;
    }

    return { entry, score };
  });

  results = results.filter((r) => r.score > 0);

  // Apply tag/lang filters
  const filtered = applyFilters(results.map((r) => r.entry), filters);
  const filteredSet = new Set(filtered);
  results = results.filter((r) => filteredSet.has(r.entry));

  results.sort((a, b) => b.score - a.score);
  return results.map((r) => ({ ...r.entry, _score: r.score }));
}

/**
 * Get entry by id or source/id.
 * Returns { entry, ambiguous, alternatives } object.
 */
export function getEntry(idOrNamespacedId) {
  const entries = applySourceFilter(getMergedEntries());

  // Check for source/id format
  if (idOrNamespacedId.includes('/')) {
    const [sourceName, ...rest] = idOrNamespacedId.split('/');
    const id = rest.join('/');
    const entry = entries.find((e) => e._source === sourceName && e.id === id);
    return entry ? { entry, ambiguous: false } : { entry: null, ambiguous: false };
  }

  // Bare id
  const matches = entries.filter((e) => e.id === idOrNamespacedId);
  if (matches.length === 0) return { entry: null, ambiguous: false };
  if (matches.length === 1) return { entry: matches[0], ambiguous: false };

  // Ambiguous — multiple sources have this id
  return {
    entry: null,
    ambiguous: true,
    alternatives: matches.map((e) => `${e._source}/${e.id}`),
  };
}

/**
 * List entries with optional filters.
 */
export function listEntries(filters = {}) {
  const entries = applySourceFilter(getMergedEntries());
  return applyFilters(entries, filters);
}

/**
 * Resolve the doc path + source for an entry.
 * Returns { source, path, provides, files } or null.
 * If language is null and multiple languages exist, returns { needsLanguage: true, available: [...] }.
 */
export function resolveDocPath(entry, language, version) {
  const lang = language ? normalizeLanguage(language) : null;

  let langObj = null;
  if (lang) {
    langObj = entry.languages?.find((l) => l.language === lang);
  } else if (entry.languages?.length === 1) {
    langObj = entry.languages[0];
  } else if (entry.languages?.length > 1) {
    return {
      needsLanguage: true,
      available: entry.languages.map((l) => l.language),
    };
  }

  if (!langObj) return null;

  let verObj = null;
  if (version) {
    verObj = langObj.versions?.find((v) => v.version === version);
  } else {
    const rec = langObj.recommendedVersion;
    verObj = langObj.versions?.find((v) => v.version === rec) || langObj.versions?.[0];
  }

  if (!verObj?.path) return null;
  return {
    source: entry._sourceObj,
    path: verObj.path,
    provides: verObj.provides || [],
    files: verObj.files || [],
  };
}

/**
 * Given a resolved path and a type ("doc" or "skill"), return the entry file path.
 * Returns { filePath, basePath } or { error }.
 */
export function resolveEntryFile(resolved, type) {
  if (!resolved || resolved.needsLanguage) return { error: 'unresolved' };

  const fileName = type === 'skill' ? 'SKILL.md' : 'DOC.md';

  if (resolved.provides.length > 0 && !resolved.provides.includes(type)) {
    return {
      error: `doesn't provide a ${type}. It has: ${resolved.provides.join(', ')}`,
    };
  }

  return {
    filePath: `${resolved.path}/${fileName}`,
    basePath: resolved.path,
    files: resolved.files,
  };
}
