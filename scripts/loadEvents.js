'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createEventManager({ directory, configPath, logger, getConfig }) {
  let registry = new Map();
  let watcher = null;
  let reloadTimer = null;

  function readConfig() {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (error) { logger.error('EVENTS', `Could not read ${path.basename(configPath)}`, error); return { enabled: true, unloadedEvents: [], overrides: {} }; }
  }

  function writeConfig(cfg) {
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, configPath);
  }

  async function reloadAll() {
    const cfg = readConfig();
    const unloaded = new Set((cfg.unloadedEvents || []).map(v => String(v).toLowerCase()));
    const next = new Map();
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.js')).sort((a, b) => a.localeCompare(b));

    for (const fileName of files) {
      const base = path.basename(fileName, '.js').toLowerCase();
      if (unloaded.has(base) || unloaded.has(fileName.toLowerCase())) continue;
      const file = path.join(directory, fileName);
      try {
        delete require.cache[require.resolve(file)];
        const exported = require(file);
        const plugin = exported?.default || exported;
        if (!plugin || typeof plugin.onEvent !== 'function') throw new Error('onEvent(ctx) function missing');
        const meta = plugin.config || {};
        const name = String(meta.name || base).toLowerCase();
        const override = cfg.overrides?.[name] || {};
        const event = String(override.event || meta.event || name);
        next.set(name, { ...plugin, fileName: fileName, config: { ...meta, ...override, name, event } });
        logger.info('EVENTS', `[${String(next.size).padStart(2, '0')}] Loaded ${name}`, { event, file: fileName });
      } catch (error) {
        logger.error('EVENTS', `Failed to load ${fileName}`, error);
      }
    }

    registry = next;
    logger.info('EVENTS', `Registry ready: ${registry.size} events`);
    if (global.client) {
      global.client.events = registry;
      global.client.eventConfig = cfg;
    }
    return registry;
  }

  function unload(filename) {
    const supplied = String(filename || '').trim();
    const base = path.basename(supplied, '.js').toLowerCase();
    if (!/^[a-z0-9_-]+$/i.test(base) || supplied.includes('/') || supplied.includes('\\')) throw new Error('Invalid event filename.');
    if (!fs.existsSync(path.join(directory, `${base}.js`))) throw new Error(`Event file not found: ${base}.js`);
    const cfg = readConfig();
    const list = new Set((cfg.unloadedEvents || []).map(v => String(v).toLowerCase()));
    list.add(base);
    cfg.unloadedEvents = [...list].sort();
    writeConfig(cfg);
    registry = new Map([...registry].filter(([, plugin]) => plugin.fileName !== `${base}.js`));
    if (global.client) global.client.events = registry;
    return base;
  }

  async function load(filename) {
    const supplied = String(filename || '').trim();
    const base = path.basename(supplied, '.js').toLowerCase();
    if (!/^[a-z0-9_-]+$/i.test(base) || supplied.includes('/') || supplied.includes('\\')) throw new Error('Invalid event filename.');
    const actual = path.join(directory, `${base}.js`);
    if (!fs.existsSync(actual)) throw new Error(`Event file not found: ${base}.js`);
    const cfg = readConfig();
    cfg.unloadedEvents = (cfg.unloadedEvents || []).filter(v => String(v).toLowerCase() !== base);
    writeConfig(cfg);
    await reloadAll();
    const plugin = [...registry.values()].find(item => item.fileName === `${base}.js`);
    if (!plugin) throw new Error(`Event ${base}.js could not be loaded.`);
    return base;
  }

  function startWatch() {
    if (!getConfig().autoReload.enabled || watcher) return;
    watcher = fs.watch(directory, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reloadAll().catch(error => logger.error('EVENTS', 'Hot reload failed', error)), getConfig().autoReload.debounceMs);
    });
  }

  function stopWatch() { watcher?.close(); watcher = null; if (reloadTimer) clearTimeout(reloadTimer); }

  return { reloadAll, unload, load, startWatch, stopWatch, list: () => [...registry.values()].sort((a, b) => a.config.name.localeCompare(b.config.name)), get events() { return registry; }, get count() { return registry.size; }, get config() { return readConfig(); }, persistConfig: writeConfig };
}

module.exports = createEventManager;
