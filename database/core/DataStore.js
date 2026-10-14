'use strict';

const hasOwn = (object, key) =>
  Object.prototype.hasOwnProperty.call(object, key);

const isObject = value =>
  value !== null && typeof value === 'object';

const isPlainObject = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value);

function clone(value) {
  if (value === undefined || value === null) return value;

  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {}
  }

  return JSON.parse(JSON.stringify(value));
}

function createError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function assertIdentifier(value, label = 'identifier') {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
  ) {
    throw new TypeError(`Invalid SQL ${label}: ${String(value)}`);
  }

  return value;
}

function normalizeKey(value, keyName) {
  if (value === undefined || value === null || value === '') {
    throw createError('INVALID_KEY', `${keyName} is required.`);
  }

  return String(value);
}

/**
 * Normalize a single logical path.
 *
 * Arrays are supported here as path segments for internal compatibility.
 * Public get/getAll use an array as "multiple paths", so each item is
 * normalized separately before reaching this function.
 */
function normalizePath(pathValue) {
  if (typeof pathValue === 'string') {
    const path = pathValue.trim();

    if (!path) {
      throw createError('INVALID_PATH', 'Path cannot be empty.');
    }

    const parts = path.split('.').filter(Boolean);

    if (!parts.length) {
      throw createError('INVALID_PATH', 'Path cannot be empty.');
    }

    return parts;
  }

  if (Array.isArray(pathValue)) {
    if (!pathValue.length) {
      throw createError('INVALID_PATH', 'Path array cannot be empty.');
    }

    const parts = [];

    for (const item of pathValue) {
      if (typeof item !== 'string' || !item.trim()) {
        throw createError(
          'INVALID_PATH',
          'Path array must contain non-empty strings.'
        );
      }

      parts.push(...item.split('.').filter(Boolean));
    }

    if (!parts.length) {
      throw createError('INVALID_PATH', 'Path array cannot be empty.');
    }

    return parts;
  }

  throw createError(
    'INVALID_PATH',
    `Path must be a string or array, not ${typeof pathValue}.`
  );
}

function getAt(object, pathValue, defaultValue) {
  if (pathValue === undefined || pathValue === null) {
    return clone(object);
  }

  const parts = normalizePath(pathValue);
  let current = object;

  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      !hasOwn(Object(current), part)
    ) {
      return clone(defaultValue);
    }

    current = current[part];
  }

  return clone(current);
}

function setAt(object, pathValue, value) {
  const parts = normalizePath(pathValue);
  let current = object;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];

    if (!isObject(current[part]) || current[part] === null) {
      current[part] = {};
    }

    current = current[part];
  }

  current[parts.at(-1)] = clone(value);
  return object;
}

function unsetAt(object, pathValue) {
  const parts = normalizePath(pathValue);

  if (parts.length === 1) {
    throw createError(
      'INVALID_PATH',
      `Cannot delete root key "${parts[0]}"; use remove() instead.`
    );
  }

  let current = object;

  for (let i = 0; i < parts.length - 1; i++) {
    if (
      current === null ||
      current === undefined ||
      !hasOwn(Object(current), parts[i])
    ) {
      return false;
    }

    current = current[parts[i]];
  }

  const leaf = parts.at(-1);

  if (
    current === null ||
    current === undefined ||
    !hasOwn(Object(current), leaf)
  ) {
    return false;
  }

  delete current[leaf];
  return true;
}

function mergeObjects(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return clone(patch);
  }

  const output = clone(base);

  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = mergeObjects(output[key], value);
    } else {
      output[key] = clone(value);
    }
  }

  return output;
}

class SerialQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  push(task) {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

class DataStore {
  constructor(database, options = {}) {
    this.db = database;
    this.name = options.name || options.keyName;
    this.table = assertIdentifier(options.table, 'table');
    this.keyName = assertIdentifier(options.keyName, 'key name');

    this.columns = new Set(
      (options.columns || []).map(column =>
        assertIdentifier(column, 'column')
      )
    );

    this.jsonColumns = new Set(
      (options.jsonColumns || []).map(column =>
        assertIdentifier(column, 'JSON column')
      )
    );

    this.booleanColumns = new Set(
      (options.booleanColumns || []).map(column =>
        assertIdentifier(column, 'boolean column')
      )
    );

    this.defaults = clone(options.defaults || {});
    this.autoCreateOnGet = options.autoCreateOnGet !== false;
    this.queue = options.queue || new SerialQueue();
  }

  _selectColumns() {
    return [
      this.keyName,
      'creation_date',
      'last_update',
      ...this.columns,
      ...this.jsonColumns
    ].filter((value, index, list) => list.indexOf(value) === index);
  }

  _getRaw(key) {
    return this.db.get(
      `SELECT ${this._selectColumns().join(', ')} FROM ${this.table} WHERE ${this.keyName} = ? LIMIT 1`,
      [key]
    );
  }

  _encodeValue(column, value) {
    if (this.jsonColumns.has(column)) {
      return JSON.stringify(value === undefined ? null : value);
    }

    if (this.booleanColumns.has(column)) {
      return value ? 1 : 0;
    }

    return value === undefined ? null : value;
  }

  _decodeRow(row) {
    if (!row) return null;

    const output = {};

    for (const column of this._selectColumns()) {
      if (!hasOwn(row, column)) continue;

      let value = row[column];

      if (this.jsonColumns.has(column)) {
        try {
          value = JSON.parse(value ?? '{}');
        } catch {
          value = {};
        }
      }

      if (this.booleanColumns.has(column)) {
        value = Boolean(Number(value));
      }

      output[column] = value;
    }

    return output;
  }

  _getSync(key) {
    return this._decodeRow(this._getRaw(key));
  }

  getSync(id) {
    return this._getSync(normalizeKey(id, this.keyName));
  }

  existsSync(id) {
    if (id === undefined || id === null || id === '') {
      return false;
    }

    const key = String(id);

    return Boolean(
      this.db.get(
        `SELECT 1 AS found FROM ${this.table} WHERE ${this.keyName} = ? LIMIT 1`,
        [key]
      )
    );
  }

  _splitInput(input) {
    if (input === undefined || input === null) {
      return {};
    }

    if (!isPlainObject(input)) {
      throw createError(
        'INVALID_UPDATE_DATA',
        `Update data must be an object when no path is supplied, not ${typeof input}.`
      );
    }

    return clone(input);
  }

  _buildCreateData(id, input = {}) {
    const incoming = this._splitInput(input);
    const base = isPlainObject(this.defaults)
      ? clone(this.defaults)
      : {};

    const merged = {
      ...base,
      ...incoming,
      [this.keyName]: normalizeKey(id, this.keyName)
    };

    const fields = {};
    const data = isPlainObject(base.data)
      ? clone(base.data)
      : {};

    if (hasOwn(incoming, 'data')) {
      if (isPlainObject(incoming.data) || Array.isArray(incoming.data)) {
        if (isPlainObject(incoming.data)) {
          Object.assign(data, clone(incoming.data));
        } else {
          fields.data = clone(incoming.data);
        }
      } else {
        fields.data = clone(incoming.data);
      }
    }

    for (const [key, value] of Object.entries(merged)) {
      if (key === this.keyName || key === 'data') continue;

      if (this.columns.has(key) || this.jsonColumns.has(key)) {
        fields[key] = clone(value);
      } else if (this.jsonColumns.has('data')) {
        data[key] = clone(value);
      }
    }

    if (this.jsonColumns.has('data') && !hasOwn(fields, 'data')) {
      fields.data = data;
    }

    return fields;
  }

  async _createNow(id, input = {}) {
    const key = normalizeKey(id, this.keyName);

    if (this._getSync(key)) {
      throw createError(
        'DATA_ALREADY_EXISTS',
        `${this.keyName} "${key}" already exists in the database.`
      );
    }

    const fields = this._buildCreateData(key, input);
    const columns = [this.keyName, 'creation_date', 'last_update'];
    const values = [key, Date.now(), Date.now()];

    for (const column of Object.keys(fields)) {
      if (column === this.keyName) continue;

      columns.push(assertIdentifier(column, 'column'));
      values.push(this._encodeValue(column, fields[column]));
    }

    await this.db.run(
      `INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${columns
        .map(() => '?')
        .join(', ')})`,
      values
    );

    return this._getSync(key);
  }

  async create(id, input = {}) {
    return this.queue.push(() =>
      this._createNow(id, input).then(clone)
    );
  }

  async _ensureNow(id, defaults = {}) {
    const key = normalizeKey(id, this.keyName);
    return this._getSync(key) || this._createNow(key, defaults);
  }

  async ensure(id, defaults = {}) {
    return this.queue.push(() =>
      this._ensureNow(id, defaults).then(clone)
    );
  }

  _normalizePathForOperation(pathValue) {
    return normalizePath(pathValue);
  }

  /**
   * Resolve a logical path into:
   * - root SQL/JSON column
   * - whether a nested property is being changed
   * - the path relative to that root column
   *
   * Critical rule:
   * "data" => root data column, no nested path
   * "data.foo" => root data column, nested path ["foo"]
   * "foo.bar" => unknown root, so it means data.foo.bar
   */
  _resolvePathColumn(pathValue) {
    const parts = this._normalizePathForOperation(pathValue);
    const root = parts[0];

    if (root === 'data') {
      return {
        parts,
        root: 'data',
        nested: parts.length > 1,
        dataPath: parts.slice(1)
      };
    }

    if (this.columns.has(root) || this.jsonColumns.has(root)) {
      return {
        parts,
        root,
        nested: parts.length > 1,
        dataPath: null
      };
    }

    return {
      parts,
      root: 'data',
      nested: true,
      dataPath: parts
    };
  }

  _getPathValue(record, pathValue, defaultValue) {
    return getAt(record, pathValue, defaultValue);
  }

  _applySet(record, input, pathValue) {
    const changes = new Map();

    if (pathValue !== undefined && pathValue !== null) {
      const resolved = this._resolvePathColumn(pathValue);

      // Root SQL/JSON column replacement.
      if (!resolved.nested) {
        changes.set(resolved.root, clone(input));
        return changes;
      }

      // Nested path inside the generic JSON "data" column.
      if (resolved.root === 'data') {
        const data = isPlainObject(record.data)
          ? clone(record.data)
          : {};

        setAt(data, resolved.dataPath, input);
        changes.set('data', data);

        return changes;
      }

      // Nested path inside a dedicated JSON column.
      const value = clone(record[resolved.root]);

      if (value === null || value === undefined) {
        const object = {};
        setAt(object, resolved.parts.slice(1), input);
        changes.set(resolved.root, object);
      } else {
        if (!isObject(value) || Array.isArray(value)) {
          throw createError(
            'INVALID_PATH',
            `Cannot set nested path "${pathValue}" because "${resolved.root}" is not an object.`
          );
        }

        setAt(value, resolved.parts.slice(1), input);
        changes.set(resolved.root, value);
      }

      return changes;
    }

    const incoming = this._splitInput(input);
    const unknownData = {};

    for (const [key, value] of Object.entries(incoming)) {
      if (key === this.keyName) continue;

      if (key === 'data' && this.jsonColumns.has('data')) {
        if (isPlainObject(record.data) && isPlainObject(value)) {
          changes.set('data', mergeObjects(record.data, value));
        } else {
          changes.set('data', clone(value));
        }
      } else if (
        this.columns.has(key) ||
        this.jsonColumns.has(key)
      ) {
        changes.set(key, clone(value));
      } else if (this.jsonColumns.has('data')) {
        unknownData[key] = clone(value);
      }
    }

    if (
      Object.keys(unknownData).length &&
      this.jsonColumns.has('data')
    ) {
      const data = isPlainObject(record.data)
        ? clone(record.data)
        : {};

      Object.assign(data, unknownData);
      changes.set('data', data);
    }

    return changes;
  }

  async _updateNow(id, input, pathValue) {
    const key = normalizeKey(id, this.keyName);
    let current = this._getSync(key);

    if (!current) {
      current = await this._createNow(key, {});
    }

    const changes = this._applySet(current, input, pathValue);

    if (!changes.size) {
      return this._getSync(key);
    }

    const assignments = ['last_update = ?'];
    const values = [Date.now()];

    for (const [column, value] of changes) {
      assertIdentifier(column, 'column');
      assignments.push(`${column} = ?`);
      values.push(this._encodeValue(column, value));
    }

    values.push(key);

    await this.db.run(
      `UPDATE ${this.table} SET ${assignments.join(', ')} WHERE ${this.keyName} = ?`,
      values
    );

    return this._getSync(key);
  }

  async set(id, updateData, pathValue, query) {
    return this.queue.push(async () => {
      const result = await this._updateNow(
        id,
        updateData,
        pathValue
      );

      return this._applyQuery(result, query);
    });
  }

  async _deleteKeyNow(id, pathValue) {
    const key = normalizeKey(id, this.keyName);
    const current = this._getSync(key);

    if (!current) {
      throw createError(
        'KEY_NOT_FOUND',
        `${this.keyName} "${key}" does not exist in the database.`
      );
    }

    const resolved = this._resolvePathColumn(pathValue);

    if (!resolved.nested) {
      throw createError(
        'INVALID_PATH',
        `Cannot delete root key "${resolved.root}"; use remove() instead.`
      );
    }

    if (resolved.root === 'data') {
      const target = isPlainObject(current.data)
        ? clone(current.data)
        : {};

      if (!unsetAt(target, resolved.dataPath)) {
        throw createError(
          'KEY_NOT_FOUND',
          `Path "${pathValue}" does not exist in ${this.keyName} "${key}".`
        );
      }

      return this._updateNow(key, target, 'data');
    }

    if (!this.jsonColumns.has(resolved.root)) {
      throw createError(
        'INVALID_PATH',
        `Cannot delete a nested path from SQL column "${resolved.root}".`
      );
    }

    const target = clone(current[resolved.root]);

    if (
      target === null ||
      typeof target !== 'object' ||
      Array.isArray(target)
    ) {
      throw createError(
        'INVALID_PATH',
        `Cannot delete nested path "${pathValue}" because "${resolved.root}" is not an object.`
      );
    }

    if (!unsetAt(target, resolved.parts.slice(1))) {
      throw createError(
        'KEY_NOT_FOUND',
        `Path "${pathValue}" does not exist in ${this.keyName} "${key}".`
      );
    }

    return this._updateNow(
      key,
      target,
      resolved.root
    );
  }

  async deleteKey(id, pathValue, query) {
    return this.queue.push(async () => {
      const result = await this._deleteKeyNow(id, pathValue);
      return this._applyQuery(result, query);
    });
  }

  async _removeNow(id) {
    const key = normalizeKey(id, this.keyName);

    if (!this._getSync(key)) {
      return false;
    }

    await this.db.run(
      `DELETE FROM ${this.table} WHERE ${this.keyName} = ?`,
      [key]
    );

    return true;
  }

  async remove(id) {
    return this.queue.push(() => this._removeNow(id));
  }

  async delete(id) {
    return this.remove(id);
  }

  async _getNow(id, pathValue, defaultValue, query) {
    const key = normalizeKey(id, this.keyName);
    let result = this._getSync(key);

    if (!result && this.autoCreateOnGet) {
      result = await this._createNow(key, {});
    }

    if (!result) return undefined;

    result = this._applyQuery(result, query);

    if (pathValue === undefined || pathValue === null) {
      return clone(result);
    }

    if (Array.isArray(pathValue)) {
      return pathValue.map((path, index) =>
        this._getPathValue(
          result,
          path,
          Array.isArray(defaultValue)
            ? defaultValue[index]
            : defaultValue
        )
      );
    }

    return this._getPathValue(result, pathValue, defaultValue);
  }

  async get(id, pathValue, defaultValue, query) {
    return this.queue.push(() =>
      this._getNow(id, pathValue, defaultValue, query)
    );
  }

  async getAll(pathValue, defaultValue, query) {
    return this.queue.push(() => {
      let records = this.db
        .all(
          `SELECT ${this._selectColumns().join(', ')} FROM ${this.table}`
        )
        .map(row => this._decodeRow(row));

      if (query !== undefined && query !== null) {
        records = records.map(record =>
          this._applyQuery(record, query)
        );
      }

      if (pathValue === undefined || pathValue === null) {
        return clone(records);
      }

      if (Array.isArray(pathValue)) {
        return records.map(record =>
          pathValue.map((path, index) =>
            this._getPathValue(
              record,
              path,
              Array.isArray(defaultValue)
                ? defaultValue[index]
                : defaultValue
            )
          )
        );
      }

      return records.map(record =>
        this._getPathValue(record, pathValue, defaultValue)
      );
    });
  }

  async refresh(id, updateData = {}) {
    return this.queue.push(async () => {
      const key = normalizeKey(id, this.keyName);

      return clone(
        this._getSync(key)
          ? await this._updateNow(key, updateData)
          : await this._createNow(key, updateData)
      );
    });
  }

  async refreshInfo(id, updateData = {}) {
    return this.refresh(id, updateData);
  }

  _applyQuery(value, query) {
    if (query === undefined || query === null) {
      return clone(value);
    }

    if (typeof query !== 'function') {
      throw createError(
        'INVALID_QUERY',
        'query must be a function in this database implementation.'
      );
    }

    return clone(query(clone(value)));
  }

  async increment(id, pathValue, amount = 1, query) {
    return this.queue.push(async () => {
      const numericAmount = Number(amount);

      if (!Number.isFinite(numericAmount)) {
        throw createError(
          'INVALID_AMOUNT',
          `Amount must be a finite number, not ${String(amount)}.`
        );
      }

      const key = normalizeKey(id, this.keyName);
      let current = this._getSync(key);

      if (!current) {
        current = await this._createNow(key, {});
      }

      const currentValue = Number(
        this._getPathValue(current, pathValue, 0)
      );

      if (!Number.isFinite(currentValue)) {
        throw createError(
          'INVALID_NUMBER',
          `Value at "${pathValue}" is not numeric.`
        );
      }

      const result = await this._updateNow(
        key,
        currentValue + numericAmount,
        pathValue
      );

      return this._applyQuery(result, query);
    });
  }

  async decrement(id, pathValue, amount = 1, query) {
    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount)) {
      throw createError(
        'INVALID_AMOUNT',
        `Amount must be a finite number, not ${String(amount)}.`
      );
    }

    return this.increment(
      id,
      pathValue,
      -numericAmount,
      query
    );
  }

  async getNumber(
    id,
    pathValue,
    defaultValue = 0
  ) {
    const value = await this.get(
      id,
      pathValue,
      defaultValue
    );

    const number = Number(value);

    if (!Number.isFinite(number)) {
      throw createError(
        'INVALID_NUMBER',
        `Value at "${pathValue}" is not numeric.`
      );
    }

    return number;
  }
}

class LocalDataStore extends DataStore {
  /**
   * localData always stores user-facing properties under `data`.
 *
   * "prefix"       -> "data.prefix"
   * "data.prefix"  -> "data.prefix"
   *
   * Arrays are preserved as multiple paths for get/getAll.
   */
  _localPath(pathValue) {
    if (pathValue === undefined || pathValue === null) {
      return 'data';
    }

    if (Array.isArray(pathValue)) {
      if (!pathValue.length) {
        throw createError(
          'INVALID_PATH',
          'Path array cannot be empty.'
        );
      }

      return pathValue.map(path => {
        const parts = normalizePath(path);

        return parts[0] === 'data'
          ? parts.join('.')
          : `data.${parts.join('.')}`;
      });
    }

    const parts = normalizePath(pathValue);

    return parts[0] === 'data'
      ? parts.join('.')
      : `data.${parts.join('.')}`;
  }

  async create(key, data = {}) {
    if (!isPlainObject(data)) {
      throw createError(
        'INVALID_CREATE_DATA',
        `localData.create() expects an object, not ${typeof data}.`
      );
    }

    const payload =
      hasOwn(data, 'data') &&
      Object.keys(data).every(key => key === 'data')
        ? { data: clone(data.data) }
        : { data: clone(data) };

    return super.create(key, payload);
  }

  async get(key, pathValue, defaultValue, query) {
    const normalizedPath =
      pathValue === undefined || pathValue === null
        ? pathValue
        : this._localPath(pathValue);

    return this.queue.push(async () => {
      const normalizedKey = normalizeKey(key, this.keyName);
      let record = this._getSync(normalizedKey);

      /*
       * localData deliberately differs from usersData/threadsData:
       * no default => missing key stays missing.
       */
      if (!record && defaultValue !== undefined) {
        let initialData;

        if (normalizedPath === undefined || normalizedPath === null) {
          initialData = clone(defaultValue);
        } else if (Array.isArray(normalizedPath)) {
          initialData = {};

          for (let i = 0; i < normalizedPath.length; i++) {
            const parts = normalizePath(normalizedPath[i]);
            const value = Array.isArray(defaultValue)
              ? defaultValue[i]
              : defaultValue;

            if (
              parts.length === 1 &&
              parts[0] === 'data'
            ) {
              initialData = clone(value);
              continue;
            }

            const dataPath =
              parts[0] === 'data'
                ? parts.slice(1)
                : parts;

            setAt(initialData, dataPath, value);
          }
        } else {
          const parts = normalizePath(normalizedPath);

          if (parts.length === 1 && parts[0] === 'data') {
            initialData = clone(defaultValue);
          } else {
            initialData = {};
            const dataPath =
              parts[0] === 'data'
                ? parts.slice(1)
                : parts;

            setAt(initialData, dataPath, defaultValue);
          }
        }

        record = await this._ensureNow(
          normalizedKey,
          { data: initialData }
        );
      }

      if (!record) return undefined;

      const result = this._applyQuery(record, query);

      if (normalizedPath === undefined || normalizedPath === null) {
        return clone(result);
      }

      if (Array.isArray(normalizedPath)) {
        return normalizedPath.map((path, index) =>
          getAt(
            result,
            path,
            Array.isArray(defaultValue)
              ? defaultValue[index]
              : defaultValue
          )
        );
      }

      return getAt(
        result,
        normalizedPath,
        defaultValue
      );
    });
  }

  async getAll(pathValue, defaultValue, query) {
    const normalizedPath =
      pathValue === undefined || pathValue === null
        ? pathValue
        : this._localPath(pathValue);

    return super.getAll(
      normalizedPath,
      defaultValue,
      query
    );
  }

  async set(key, updateData, pathValue, query) {
    const normalizedPath =
      pathValue === undefined || pathValue === null
        ? null
        : this._localPath(pathValue);

    /*
     * Object form:
     *   localData.set('botSettings', { prefix: '?', enabled: true })
     *
     * The object is merged directly into record.data.
     */
    if (normalizedPath === null) {
      if (!isPlainObject(updateData)) {
        throw createError(
          'INVALID_UPDATE_DATA',
          `localData.set() expects an object when no path is supplied, not ${typeof updateData}.`
        );
      }

      return this.queue.push(async () => {
        const normalizedKey = normalizeKey(
          key,
          this.keyName
        );

        const current =
          this._getSync(normalizedKey) ||
          await this._createNow(
            normalizedKey,
            { data: {} }
          );

        const patch =
          hasOwn(updateData, 'data')
            ? updateData.data
            : updateData;

        if (!isPlainObject(patch)) {
          throw createError(
            'INVALID_UPDATE_DATA',
            'localData.set() data payload must be an object.'
          );
        }

        const data = mergeObjects(
          isPlainObject(current.data)
            ? current.data
            : {},
          patch
        );

        /*
         * IMPORTANT:
         * Passing "data" here is a root-column replacement.
         * DataStore._resolvePathColumn() now handles that correctly.
         */
        const result = await this._updateNow(
          normalizedKey,
          data,
          'data'
        );

        return this._applyQuery(result, query);
      });
    }

    return super.set(
      key,
      updateData,
      normalizedPath,
      query
    );
  }

  async deleteKey(key, pathValue, query) {
    return super.deleteKey(
      key,
      this._localPath(pathValue),
      query
    );
  }

  async increment(
    key,
    pathValue,
    amount = 1,
    query
  ) {
    return super.increment(
      key,
      this._localPath(pathValue),
      amount,
      query
    );
  }

  async decrement(
    key,
    pathValue,
    amount = 1,
    query
  ) {
    return super.decrement(
      key,
      this._localPath(pathValue),
      amount,
      query
    );
  }

  async getNumber(
    key,
    pathValue,
    defaultValue = 0
  ) {
    return super.getNumber(
      key,
      this._localPath(pathValue),
      defaultValue
    );
  }
}

module.exports = {
  DataStore,
  LocalDataStore,
  SerialQueue,
  clone,
  createError,
  isPlainObject,
  normalizeKey,
  normalizePath,
  getAt,
  setAt,
  unsetAt,
  mergeObjects,
  assertIdentifier
};
